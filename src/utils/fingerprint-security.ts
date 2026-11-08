import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

const ENVELOPE_VERSION = 1;

type EncryptedEnvelope = {
  __layerEncrypted: true;
  version: number;
  iv: string;
  tag: string;
  ciphertext: string;
};

function getMasterKey(): Buffer {
  const configured = process.env.FINGERPRINT_ENCRYPTION_KEY;
  if (!configured) {
    const fallback = process.env.DISCORD_TOKEN || process.env.DISCORD_BOT_TOKEN || 'uselayer-default-fingerprint-key-32';
    return createHmac('sha256', 'uselayer-salt').update(fallback).digest();
  }

  const key = /^[a-f0-9]{64}$/i.test(configured)
    ? Buffer.from(configured, 'hex')
    : Buffer.from(configured, 'base64');
  if (key.length !== 32) {
    return createHmac('sha256', 'uselayer-salt').update(configured).digest();
  }
  return key;
}

function deriveKey(purpose: string): Buffer {
  return createHmac('sha256', getMasterKey()).update(`uselayer:${purpose}:v1`).digest();
}

export function hashFingerprint(guildId: string, fingerprint: string): string {
  return `v1:${createHmac('sha256', deriveKey('fingerprint-match'))
    .update(`${guildId}:${fingerprint}`)
    .digest('hex')}`;
}

export function hashNetworkAddress(guildId: string, address: string): string {
  return `v1:${createHmac('sha256', deriveKey('network-match'))
    .update(`${guildId}:${address}`)
    .digest('hex')}`;
}

export function hashVerificationToken(token: string): string {
  return createHmac('sha256', deriveKey('verification-challenge'))
    .update(token)
    .digest('hex');
}

export function encryptFingerprintData(value: unknown): EncryptedEnvelope {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey('fingerprint-data'), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value ?? {}), 'utf8'),
    cipher.final(),
  ]);
  return {
    __layerEncrypted: true,
    version: ENVELOPE_VERSION,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

export function decryptFingerprintData(value: unknown): Record<string, unknown> | undefined {
  if (value == null) return undefined;

  const envelope = value as Partial<EncryptedEnvelope>;
  if (envelope.__layerEncrypted !== true) {
    return value as Record<string, unknown>;
  }
  if (envelope.version !== ENVELOPE_VERSION || !envelope.iv || !envelope.tag || !envelope.ciphertext) {
    throw new Error('Unsupported or incomplete encrypted fingerprint record');
  }

  const decipher = createDecipheriv(
    'aes-256-gcm',
    deriveKey('fingerprint-data'),
    Buffer.from(envelope.iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
  const parsed: unknown = JSON.parse(plaintext);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : undefined;
}

export function isFingerprintEncryptionConfigured(): boolean {
  try {
    getMasterKey();
    return true;
  } catch {
    return false;
  }
}
