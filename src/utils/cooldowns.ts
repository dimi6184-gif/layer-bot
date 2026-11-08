/**
 * Command Cooldown System
 * Prevents command spam and abuse
 */

interface CooldownEntry {
  expiresAt: number;
  uses: number;
}

const cooldowns = new Map<string, CooldownEntry>();

// Cleanup old entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of cooldowns.entries()) {
    if (entry.expiresAt < now) {
      cooldowns.delete(key);
    }
  }
}, 5 * 60 * 1000);

export interface CooldownConfig {
  seconds: number;
  maxUses?: number; // Max uses within cooldown period (default: 1)
}

export const COOLDOWNS = {
  // General Commands
  DEFAULT: { seconds: 3 },
  
  // Moderation Commands (stricter)
  BAN: { seconds: 5 },
  KICK: { seconds: 5 },
  MUTE: { seconds: 3 },
  WARN: { seconds: 3 },
  CLEAR: { seconds: 5 },
  
  // Anti-Raid Commands
  ANTIRAID: { seconds: 3 },
  
  // Leveling Commands
  RANK: { seconds: 5 },
  LEADERBOARD: { seconds: 10 },
  
  // AI Commands (expensive)
  AI_ASK: { seconds: 10 },
  
  // Utility Commands
  SERVERINFO: { seconds: 10 },
  USERINFO: { seconds: 5 },
  
  // Giveaway/Poll (prevents spam)
  GIVEAWAY: { seconds: 30 },
  POLL: { seconds: 15 },
  
  // XP Gain (prevents farming)
  XP_GAIN: { seconds: 60 },
} as const;

/**
 * Check if command is on cooldown
 * @returns true if allowed, false if on cooldown
 */
export function checkCooldown(
  userId: string,
  commandName: string,
  config: CooldownConfig = COOLDOWNS.DEFAULT
): { allowed: boolean; remainingSeconds?: number } {
  const key = `${userId}-${commandName}`;
  const now = Date.now();
  const entry = cooldowns.get(key);
  
  const maxUses = config.maxUses || 1;
  const cooldownMs = config.seconds * 1000;

  // No existing cooldown
  if (!entry || entry.expiresAt < now) {
    cooldowns.set(key, {
      expiresAt: now + cooldownMs,
      uses: 1,
    });
    return { allowed: true };
  }

  // Within cooldown period
  if (entry.uses < maxUses) {
    entry.uses++;
    return { allowed: true };
  }

  // On cooldown
  const remainingSeconds = Math.ceil((entry.expiresAt - now) / 1000);
  return { allowed: false, remainingSeconds };
}

/**
 * Get remaining cooldown time
 */
export function getRemainingCooldown(userId: string, commandName: string): number {
  const key = `${userId}-${commandName}`;
  const entry = cooldowns.get(key);
  
  if (!entry) return 0;
  
  const now = Date.now();
  if (entry.expiresAt < now) {
    cooldowns.delete(key);
    return 0;
  }
  
  return Math.ceil((entry.expiresAt - now) / 1000);
}

/**
 * Reset cooldown for a user/command (admin override)
 */
export function resetCooldown(userId: string, commandName: string): void {
  const key = `${userId}-${commandName}`;
  cooldowns.delete(key);
}

/**
 * Clear all cooldowns (maintenance)
 */
export function clearAllCooldowns(): void {
  cooldowns.clear();
}
