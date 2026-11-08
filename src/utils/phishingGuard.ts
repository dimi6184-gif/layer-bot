// apps/bot/src/utils/phishingGuard.ts

/**
 * 2026 Anti-Phishing & Homoglyph Typosquatting Guard
 * Detects fake Discord Nitro, Steam Community, and Token grabber URLs in < 2ms.
 */

const LEGITIMATE_DOMAINS = new Set([
  'discord.com',
  'discord.gg',
  'discordapp.com',
  'discord.media',
  'discordapp.net',
  'steamcommunity.com',
  'steampowered.com',
  'roblox.com',
  't.me',
  'telegram.org',
]);

const SUSPICIOUS_TLDS = new Set([
  'gift',
  'gifts',
  'rip',
  'top',
  'click',
  'buzz',
  'rest',
  'xyz',
  'link',
  'shop',
  'club',
  'fun',
  'cfd',
  'sbs',
  'monster',
  'site',
]);

const HOMOGLYPHS: Record<string, string> = {
  '0': 'o',
  '1': 'l',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '8': 'b',
  'а': 'a',
  'с': 'c',
  'е': 'e',
  'о': 'o',
  'р': 'p',
  'х': 'x',
  'у': 'y',
  'і': 'i',
  'ј': 'j',
  'ѕ': 's',
  'ԁ': 'd',
  'rn': 'm',
  'vv': 'w',
};

function normalizeHomoglyphs(str: string): string {
  let res = str.toLowerCase();
  for (const [key, val] of Object.entries(HOMOGLYPHS)) {
    res = res.replaceAll(key, val);
  }
  return res;
}

function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }

  return dp[m][n];
}

export interface PhishingCheckResult {
  isPhishing: boolean;
  confidence: number;
  reason: string;
  matchedDomain?: string;
}

/**
 * Scan text for modern phishing domains, typosquatting, and token grabber lures
 */
export function checkPhishingFast(text: string): PhishingCheckResult {
  const lower = text.toLowerCase();

  // 1. Token Grabber Lures (Fake Game Testing, QR Code Login)
  const gameTestingLure = /(test\s*my\s*game|try\s*my\s*(demo|game)|need\s*(testers|2\s*people)\s*for\s*(steam|game)|50\$\s*to\s*test)/i;
  const qrLoginLure = /(scan\s*(the|this)?\s*qr\s*code\s*to\s*(verify|claim|get)|scan\s*in\s*discord\s*mobile\s*app)/i;

  if (gameTestingLure.test(lower) && /(https?:\/\/|\.rar|\.zip|\.scr|\.exe)/i.test(lower)) {
    return {
      isPhishing: true,
      confidence: 95,
      reason: 'Malicious Game-Testing Token Grabber Pattern',
    };
  }

  if (qrLoginLure.test(lower)) {
    return {
      isPhishing: true,
      confidence: 90,
      reason: 'Discord QR Code Phishing Lure Detected',
    };
  }

  // 2. Extract all URLs and domain-like strings
  const urlRegex = /(?:https?:\/\/)?([a-zA-Z0-9][-a-zA-Z0-9]*(?:\.[a-zA-Z0-9][-a-zA-Z0-9]*)+)(?:\/[^\s]*)?/gi;
  const matches = [...text.matchAll(urlRegex)];

  for (const match of matches) {
    const rawHost = match[1].toLowerCase().replace(/^www\./, '');
    const parts = rawHost.split('.');
    if (parts.length < 2) continue;

    const tld = parts[parts.length - 1];
    const sld = parts.slice(0, parts.length - 1).join('.');

    // Skip verified legitimate domains
    if (LEGITIMATE_DOMAINS.has(rawHost)) continue;

    // A. Punycode check
    if (rawHost.includes('xn--')) {
      return {
        isPhishing: true,
        confidence: 98,
        reason: `Punycode Homoglyph Phishing Domain: ${rawHost}`,
        matchedDomain: rawHost,
      };
    }

    // B. Nitro / Gift Scams on Suspicious TLDs
    if (SUSPICIOUS_TLDS.has(tld) && /(discord|nitro|steam|gift|claim|airdrop)/i.test(sld)) {
      return {
        isPhishing: true,
        confidence: 100,
        reason: `Nitro/Gift Phishing on suspicious TLD (.${tld}): ${rawHost}`,
        matchedDomain: rawHost,
      };
    }

    // C. Discord Typosquatting / Homoglyph Check
    const normalizedSld = normalizeHomoglyphs(sld);

    // Look for fake discord subdomains or misspelled domains
    if (normalizedSld.includes('discord') || normalizedSld.includes('discrod') || normalizedSld.includes('dlscord')) {
      if (!LEGITIMATE_DOMAINS.has(rawHost)) {
        return {
          isPhishing: true,
          confidence: 99,
          reason: `Impersonated Discord Domain: ${rawHost}`,
          matchedDomain: rawHost,
        };
      }
    }

    // Levenshtein distance to "discord"
    const distanceToDiscord = levenshteinDistance(normalizedSld, 'discord');
    if (distanceToDiscord > 0 && distanceToDiscord <= 2 && sld.length >= 5 && sld.length <= 9) {
      return {
        isPhishing: true,
        confidence: 95,
        reason: `Typosquatted Discord Phishing Domain: ${rawHost}`,
        matchedDomain: rawHost,
      };
    }

    // D. Steam Typosquatting Check
    if (normalizedSld.includes('steamcommunity') || normalizedSld.includes('steampowered')) {
      if (!LEGITIMATE_DOMAINS.has(rawHost)) {
        return {
          isPhishing: true,
          confidence: 99,
          reason: `Impersonated Steam Domain: ${rawHost}`,
          matchedDomain: rawHost,
        };
      }
    }

    const distanceToSteam = levenshteinDistance(normalizedSld, 'steamcommunity');
    if (distanceToSteam > 0 && distanceToSteam <= 3 && sld.length >= 12) {
      return {
        isPhishing: true,
        confidence: 95,
        reason: `Typosquatted Steam Phishing Domain: ${rawHost}`,
        matchedDomain: rawHost,
      };
    }
  }

  return {
    isPhishing: false,
    confidence: 0,
    reason: 'Clean',
  };
}
