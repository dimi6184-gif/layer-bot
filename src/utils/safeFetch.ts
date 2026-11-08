import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

function isPublicIPv4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  if (a === 169 && b === 254) return false; // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a >= 224) return false; // multicast and reserved
  return true;
}

function isPublicAddress(ip: string): boolean {
  if (isIP(ip) === 4) return isPublicIPv4(ip);
  const v6 = ip.toLowerCase();
  if (v6 === '::' || v6 === '::1') return false;
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPublicIPv4(mapped[1]);
  if (/^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith('ff')) return false; // ULA, link-local, multicast
  return true;
}

/**
 * Downloads an image from a user-configured URL without letting it reach internal hosts:
 * https only, the resolved address must be public, the connection is pinned to that address
 * (no DNS rebinding), redirects are refused, and size and time are bounded.
 */
export async function fetchPublicImage(rawUrl: string, maxBytes = 5 * 1024 * 1024, timeoutMs = 8000): Promise<Buffer> {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:') throw new Error('Only https image URLs are allowed');
  if (url.username || url.password) throw new Error('Credentials in image URLs are not allowed');

  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await lookup(hostname, { all: true });
  if (addresses.length === 0 || !addresses.every((a) => isPublicAddress(a.address))) {
    throw new Error('Image host resolves to a non-public address');
  }
  const pinned = addresses[0];

  return new Promise<Buffer>((resolve, reject) => {
    const request = https.get(url, {
      timeout: timeoutMs,
      headers: { 'User-Agent': 'LayerBot/1.0', Accept: 'image/*' },
      lookup: (_host, _options, callback) => callback(null, pinned.address, pinned.family),
    }, (response) => {
      const status = response.statusCode ?? 0;
      const type = String(response.headers['content-type'] ?? '');
      if (status !== 200) { response.resume(); return reject(new Error(`Image request failed with status ${status}`)); }
      if (!type.startsWith('image/')) { response.resume(); return reject(new Error('URL did not return an image')); }
      if (Number(response.headers['content-length'] ?? 0) > maxBytes) { response.resume(); return reject(new Error('Image is too large')); }

      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) { request.destroy(new Error('Image is too large')); return; }
        chunks.push(chunk);
      });
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('Image request timed out')));
    request.on('error', reject);
  });
}
