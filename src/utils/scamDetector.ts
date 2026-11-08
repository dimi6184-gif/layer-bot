import { checkPhishingFast } from './phishingGuard.js';
import type { Message } from 'discord.js';
import axios from 'axios';
import { GoogleGenAI, Type, Schema } from '@google/genai'; // Neues Google SDK

console.log('[ScamDetector] Module loading...');

// ─── Interfaces ──────────────────────────────────────────────────────────────

interface ImageAnalysisResult {
  isScam: boolean;
  confidence: number;
  reason: string;
  tokens: number;
}

interface ScamResult {
  isScam: boolean;
  confidence: number;
  reason: string;
  aiUsed: boolean;
  tokens: number;
}

interface DetectionResult {
  isScam: boolean;
  confidence: number;
  reason: string;
  type: 'text' | 'image' | 'both' | 'fast';
  tokens: number;
  /** Images that could not be analysed (busy, too large, AI unavailable). The message needs human review. */
  unanalyzedImages?: number;
}

// ─── Gemini Structured Outputs Configuration ────────────────────────────────

const ScamAnalysisSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    isScam: { type: Type.BOOLEAN, description: "True if the image contains scam, phishing, or fraudulent content." },
    confidence: { type: Type.INTEGER, description: "Confidence score from 0 to 100." },
    reason: { type: Type.STRING, description: "Brief explanation of what elements were detected." }
  },
  required: ["isScam", "confidence", "reason"],
};

// ─── Queue for Image Analysis ───────────────────────────────────────────────

// A few analyses run at once. Each guild may only hold a small share of the waiting
// slots, so members of one server cannot crowd out scam detection everywhere else.
const MAX_CONCURRENT = 3;
const MAX_WAITING = 40;
const MAX_PER_GUILD = 6;
const TASK_TIMEOUT_MS = 25_000;
let running = 0;
const waiting: Array<() => void> = [];
const perGuild = new Map<string, number>();

async function enqueueImageAnalysis<T>(guildId: string, task: () => Promise<T>): Promise<T | null> {
  const guildLoad = perGuild.get(guildId) ?? 0;
  if (guildLoad >= MAX_PER_GUILD || waiting.length >= MAX_WAITING) {
    console.warn(`[Scam Detector] Analysis capacity reached for guild ${guildId}, image needs review`);
    return null;
  }

  perGuild.set(guildId, guildLoad + 1);
  if (running >= MAX_CONCURRENT) await new Promise<void>((resolve) => waiting.push(resolve));
  running++;
  try {
    return await Promise.race([
      task(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), TASK_TIMEOUT_MS)),
    ]);
  } catch (err: any) {
    console.error('[Scam Detector] Queue task failed:', err?.message);
    return null;
  } finally {
    running--;
    const left = (perGuild.get(guildId) ?? 1) - 1;
    if (left > 0) perGuild.set(guildId, left);
    else perGuild.delete(guildId);
    waiting.shift()?.();
  }
}

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGES_PER_MESSAGE = 4;
const DISCORD_MEDIA_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);

function isDiscordMediaUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && DISCORD_MEDIA_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

// ─── Gemini Vision API Execution ───────────────────────────────────────────

async function analyzeImageWithGemini(imageUrl: string): Promise<ImageAnalysisResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY not configured');
  }

  // Only Discord's own media hosts, bounded in size, so the download cannot reach
  // other hosts or exhaust the shared bot process.
  if (!isDiscordMediaUrl(imageUrl)) throw new Error('Image is not hosted on Discord');

  const imageResponse = await axios.get(imageUrl, {
    responseType: 'arraybuffer',
    timeout: 10000,
    maxContentLength: MAX_IMAGE_BYTES,
    maxBodyLength: MAX_IMAGE_BYTES,
    maxRedirects: 0,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    }
  });

  const imageBuffer = Buffer.from(imageResponse.data);
  const base64Image = imageBuffer.toString('base64');
  const contentType = imageResponse.headers['content-type'];
  const mimeType: string = (typeof contentType === 'string' && /^image\/[a-z0-9.+-]+$/i.test(contentType) ? contentType : 'image/png');

  console.log(`[Scam Detector] 🧠 Image downloaded (${imageBuffer.length} bytes), analyzing with Gemini 3.5 Flash...`);

  // Initialisierung mit neuem SDK
  const ai = new GoogleGenAI({ apiKey });

  const prompt = `Analyze this image for malicious scam/phishing content. Look for:
CRITICAL SCAM INDICATORS:
- Fake withdrawal/payment success messages
- Cryptocurrency scams with money amounts or wallet drainers
- Fake Discord Nitro/Steam/gift card offers
- Casino rakeback/cashback screenshots
- Malicious QR codes designed to steal accounts or tokens

IMPORTANT - STRICT FALSE-POSITIVE PREVENTION (NOT SCAMS):
- Legitimate software dashboards, web development screenshots, Discord bot control panels (e.g. "Sync Discord", "Documentation", "Save Changes", "Layer", "Dashboard", "Role Settings").
- Normal UI navigation headers, sync buttons, settings pages, support chats, bug discussions.
- General server administration screenshots or normal member conversations.
If the image shows a legitimate Discord bot interface, settings panel, dashboard, or normal developer screen, isScam MUST be false with confidence 0.`;

  const candidateModels = [
    'gemini-3.8-flash',
    'gemini-3.6-flash',
    'gemini-3.1-flash-lite-preview',
  ];

  let response: any = null;
  let lastError: any = null;

  for (const modelName of candidateModels) {
    try {
      response = await ai.models.generateContent({
        model: modelName,
        contents: [
          prompt,
          { inlineData: { data: base64Image, mimeType } },
        ],
        config: {
          responseMimeType: "application/json",
          responseSchema: ScamAnalysisSchema,
        }
      });
      if (response?.text) break;
    } catch (err: any) {
      console.warn(`[Scam Detector] Model ${modelName} failed (${err.message}). Trying fallback...`);
      lastError = err;
    }
  }

  if (!response?.text) throw lastError || new Error('Invalid empty response from Gemini');
  const text = response.text;

  console.log(`[Scam Detector] 🧠 Gemini response: ${text}`);
  const analysis = JSON.parse(text);
  
  return {
    isScam: analysis.isScam || false,
    confidence: analysis.confidence || 0,
    reason: analysis.reason || 'Analysis completed',
    tokens: response.usageMetadata?.totalTokenCount || 1200,
  };
}

// ─── Keyword Lists ──────────────────────────────────────────────────────────

const SCAM_KEYWORDS = {
  high: [
    'withdrawal succeed', 'withdrawal successful', 'claim your', 'free crypto',
    'verify wallet', 'airdrop', 'double your', 'free nitro', 'discord nitro gift',
    'cashback', 'rakeback', 'andrew tate', 'hustlers university',
  ],
  medium: [
    'crypto', 'bitcoin', 'ethereum', 'nft', 'wallet', 'metamask', 'binance',
    'withdrawal', 'trading', 'investment', 'profit', 'giveaway', 'free money',
  ],
  low: [
    'click here', 'link in bio', 'dm me', 'urgent', 'limited', 'exclusive',
  ],
};

const SUSPICIOUS_DOMAINS = [
  'bit.ly', 'tinyurl.com', 'discord.gift', 'discordgift', 'steamcommunity.ru',
];

// ─── Text Analysis Function ────────────────────────────────────────────────

export function analyzeTextForScam(
  text: string,
  sensitivity: 'low' | 'medium' | 'high' = 'medium'
): { isScam: boolean; confidence: number; reason: string } {
  // Whitelist legitimate bot administration terms
  const lowerCheck = text.toLowerCase();
  if (
    (lowerCheck.includes('sync discord') || lowerCheck.includes('sync button') || lowerCheck.includes('uselayer.de') || lowerCheck.includes('dashboard')) &&
    !lowerCheck.includes('nitro') && !lowerCheck.includes('steam') && !lowerCheck.includes('gift') && !lowerCheck.includes('free')
  ) {
    return { isScam: false, confidence: 0, reason: 'Legitimate bot admin / dashboard instruction' };
  }

  // 2026 Anti-Phishing & Homoglyph Typosquatting fast-path
  const phishing = checkPhishingFast(text);
  if (phishing.isPhishing) {
    return {
      isScam: true,
      confidence: phishing.confidence,
      reason: phishing.reason,
    };
  }

  const lowerText = text.toLowerCase();
  let score = 0;
  const reasons: string[] = [];

  for (const keyword of SCAM_KEYWORDS.high) {
    if (lowerText.includes(keyword)) {
      score += 30;
      reasons.push(`High-risk: "${keyword}"`);
    }
  }

  for (const keyword of SCAM_KEYWORDS.medium) {
    if (lowerText.includes(keyword)) {
      score += 10;
      reasons.push(`Medium-risk: "${keyword}"`);
    }
  }

  for (const keyword of SCAM_KEYWORDS.low) {
    if (lowerText.includes(keyword)) {
      score += 5;
    }
  }

  for (const domain of SUSPICIOUS_DOMAINS) {
    if (lowerText.includes(domain)) {
      score += 25;
      reasons.push(`Suspicious domain: ${domain}`);
    }
  }

  const urlRegex = /(https?:\/\/[^\s]+)/gi;
  const urls = text.match(urlRegex) || [];
  for (const url of urls) {
    if (url.includes('discord') && !url.includes('discord.com') && !url.includes('discord.gg')) {
      score += 20;
      reasons.push('Fake Discord URL');
    }
    if (url.includes('steam') && !url.includes('steampowered.com') && !url.includes('steamcommunity.com')) {
      score += 20;
      reasons.push('Fake Steam URL');
    }
  }

  const thresholds = { low: 80, medium: 50, high: 30 };
  const threshold = thresholds[sensitivity];

  return {
    isScam: score >= threshold,
    confidence: Math.min(score, 100),
    reason: reasons.slice(0, 3).join(', ') || 'No scam indicators found',
  };
}

// ─── Image Analysis Function ───────────────────────────────────────────────

// Confidence describes Gemini's verdict, so a confident "not a scam" must not count as a scam.
export function isImageFlaggedAsScam(
  analysis: { isScam: boolean; confidence: number },
  sensitivity: 'low' | 'medium' | 'high' = 'medium'
): boolean {
  const thresholds = { low: 80, medium: 60, high: 40 };
  return analysis.isScam && analysis.confidence >= thresholds[sensitivity];
}

export async function analyzeImageForScam(
  imageUrl: string,
  sensitivity: 'low' | 'medium' | 'high' = 'medium',
  guildId = 'global'
): Promise<ScamResult> {
  const result = await enqueueImageAnalysis(guildId, async () => {
    try {
      const geminiResult = await analyzeImageWithGemini(imageUrl);

      return {
        isScam: isImageFlaggedAsScam(geminiResult, sensitivity),
        confidence: geminiResult.confidence,
        reason: geminiResult.reason,
        aiUsed: true,
        tokens: geminiResult.tokens,
      };
    } catch (error: any) {
      console.error(`[Scam Detector] Image analysis error: ${error.message}`);
      return { isScam: false, confidence: 0, reason: 'AI unavailable', aiUsed: false, tokens: 0 };
    }
  });

  return result || { isScam: false, confidence: 0, reason: 'Queue full', aiUsed: false, tokens: 0 };
}

// ─── MAIN DETECTION FUNCTION (Kombiniert Text + Bild) ─────────────────────

export async function detectScam(
  message: Message,
  sensitivity: 'low' | 'medium' | 'high' = 'medium'
): Promise<DetectionResult> {
  console.log(`[Scam Detector] 🚀 Starting detection (sensitivity: ${sensitivity})`);

  // 1. Text-Analyse durchführen
  const textResult = analyzeTextForScam(message.content || '', sensitivity);
  let finalResult: DetectionResult = {
    isScam: textResult.isScam,
    confidence: textResult.confidence,
    reason: textResult.reason,
    type: 'text',
    tokens: 0
  };

  // Wenn der Text bereits eindeutig Scam ist, stoppen wir hier (spart API-Aufrufe)
  if (finalResult.isScam && finalResult.confidence >= 80) {
    finalResult.type = 'fast';
    return finalResult;
  }

  // 2. Bild-Analyse durchführen, falls Anhänge existieren
  // 2. Analyse every image: attachments and image embeds, so a scam image cannot hide
  // behind a harmless first attachment. Embeds use Discord's proxy URL, never the original host.
  const imageUrls: string[] = [];
  let oversized = 0;
  for (const attachment of message.attachments.values()) {
    if (!attachment.contentType?.startsWith('image/')) continue;
    if (attachment.size > MAX_IMAGE_BYTES) { oversized++; continue; }
    imageUrls.push(attachment.url);
  }
  for (const embed of message.embeds) {
    for (const proxied of [embed.image?.proxyURL, embed.thumbnail?.proxyURL]) {
      if (proxied && isDiscordMediaUrl(proxied)) imageUrls.push(proxied);
    }
  }
  const selected = [...new Set(imageUrls)].slice(0, MAX_IMAGES_PER_MESSAGE);
  let unanalyzed = oversized + Math.max(0, new Set(imageUrls).size - selected.length);

  if (selected.length > 0) {
    const results = await Promise.all(selected.map((url) => analyzeImageForScam(url, sensitivity, message.guildId ?? 'global')));
    unanalyzed += results.filter((r) => !r.aiUsed).length;
    const flagged = results.filter((r) => r.isScam);
    const tokens = results.reduce((sum, r) => sum + r.tokens, 0);

    if (results.some((r) => r.aiUsed)) {
      const combinedReasons: string[] = [];
      if (textResult.confidence > 0) combinedReasons.push(`[Text] ${textResult.reason}`);
      for (const r of flagged) combinedReasons.push(`[Image] ${r.reason}`);

      finalResult = {
        isScam: finalResult.isScam || flagged.length > 0,
        confidence: Math.max(finalResult.confidence, ...flagged.map((r) => r.confidence)),
        reason: combinedReasons.join(' | ') || 'Analyzed text and image',
        type: 'both',
        tokens,
      };
    }
  }

  if (unanalyzed > 0) finalResult.unanalyzedImages = unanalyzed;
  return finalResult;
}
