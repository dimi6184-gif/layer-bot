import { registerFont } from 'canvas';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let fontsInitialized = false;

export function initCanvasFonts() {
  if (fontsInitialized) return;

  const candidatePaths = [
    path.resolve(__dirname, '../../assets/fonts/Inter.ttf'),
    path.resolve(__dirname, '../assets/fonts/Inter.ttf'),
    path.join(process.cwd(), 'assets', 'fonts', 'Inter.ttf'),
    path.join(process.cwd(), 'apps', 'bot', 'assets', 'fonts', 'Inter.ttf'),
    path.resolve(__dirname, '../../../apps/bot/assets/fonts/Inter.ttf'),
  ];

  let foundPath: string | null = null;
  for (const p of candidatePaths) {
    if (fs.existsSync(p)) {
      foundPath = p;
      break;
    }
  }

  if (foundPath) {
    try {
      // Register under multiple font families so any requested family (Arial, Inter, etc.)
      // on headless Linux hosts resolves directly to our bundled high-quality font.
      registerFont(foundPath, { family: 'LayerFont' });
      registerFont(foundPath, { family: 'Inter' });
      registerFont(foundPath, { family: 'Arial' });
      registerFont(foundPath, { family: 'Helvetica' });
      registerFont(foundPath, { family: 'sans-serif' });
      registerFont(foundPath, { family: 'Segoe UI' });
      registerFont(foundPath, { family: 'Roboto' });
      fontsInitialized = true;
      console.log(`[CanvasFonts] Successfully registered bundled font from: ${foundPath}`);
    } catch (err) {
      console.error('[CanvasFonts] Error registering bundled font:', err);
    }
  } else {
    console.warn('[CanvasFonts] Could not find bundled font Inter.ttf in candidate paths:', candidatePaths);
  }
}

/**
 * Returns a robust font spec string with bulletproof fallbacks across Linux, Windows and Mac.
 */
export function getCanvasFont(size: number, weight: 'bold' | 'normal' = 'normal', requestedFont?: string): string {
  initCanvasFonts();
  const weightPrefix = weight === 'bold' ? 'bold ' : '';
  const cleanRequested = requestedFont?.replace(/['"]/g, '').trim();
  const primary = cleanRequested ? `"${cleanRequested}", ` : '';
  return `${weightPrefix}${size}px ${primary}"LayerFont", "Inter", "Arial", "DejaVu Sans", "Liberation Sans", sans-serif`;
}

/**
 * Sanitizes text to remove invisible control characters, zero-width spaces, and normalize unicode.
 */
export function safeCanvasText(text: string, maxLength?: number): string {
  if (!text) return '';
  // Normalize unicode
  let clean = text.normalize('NFKC');
  // Remove zero-width spaces, bidi overrides, unprintable controls
  clean = clean.replace(/[\u200B-\u200D\uFEFF\u202A-\u202E\u0000-\u001F\u007F-\u009F]/g, '').trim();
  if (maxLength && clean.length > maxLength) {
    clean = clean.substring(0, maxLength - 3) + '...';
  }
  return clean;
}
