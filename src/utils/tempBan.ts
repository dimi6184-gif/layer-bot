import { Client, TextChannel } from 'discord.js';
import { db } from '../db.js';
import { warnCV2 } from './cv2.js';

export interface ParsedDuration {
  ms: number;
  text: string;
}

/**
 * Parse human duration input like "1h", "7d", "2w", "30m", "1d 12h", "permanent"
 * Returns null for permanent, ParsedDuration for valid temporary ban, or undefined if invalid.
 */
export function parseDuration(input?: string | null): ParsedDuration | null | undefined {
  if (!input) return null;
  const trimmed = input.trim().toLowerCase();

  if (['perm', 'permanent', 'never', 'unendlich', 'forever', '0', 'none'].includes(trimmed)) {
    return null;
  }

  let totalMs = 0;
  const regex = /(\d+)\s*(m(?:in(?:ute)?s?)?|h(?:(?:ou)?rs?)?|d(?:ays?)?|t(?:age?)?|w(?:eeks?|ochen?)?|mo(?:nths?|nate?)?|y(?:ears?|ahre?)?)\b/gi;
  let match: RegExpExecArray | null;
  let matchesFound = 0;

  while ((match = regex.exec(trimmed)) !== null) {
    matchesFound++;
    const value = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();

    if (unit.startsWith('m') && !unit.startsWith('mo')) {
      totalMs += value * 60 * 1000;
    } else if (unit.startsWith('h')) {
      totalMs += value * 60 * 60 * 1000;
    } else if (unit.startsWith('d') || unit.startsWith('t')) {
      totalMs += value * 24 * 60 * 60 * 1000;
    } else if (unit.startsWith('w')) {
      totalMs += value * 7 * 24 * 60 * 60 * 1000;
    } else if (unit.startsWith('mo')) {
      totalMs += value * 30 * 24 * 60 * 60 * 1000;
    } else if (unit.startsWith('y')) {
      totalMs += value * 365 * 24 * 60 * 60 * 1000;
    }
  }

  if (matchesFound === 0) {
    if (/^\d+$/.test(trimmed)) {
      const plainNum = parseInt(trimmed, 10);
      if (plainNum > 0) {
        totalMs = plainNum * 24 * 60 * 60 * 1000; // treat plain numbers as days
      } else {
        return null;
      }
    } else {
      return undefined; // Invalid input format
    }
  }

  if (totalMs <= 0) return null;

  return {
    ms: totalMs,
    text: formatDurationText(totalMs),
  };
}

/**
 * Format milliseconds into a readable string (e.g. "7 Days", "2 Hours 30 Minutes")
 */
export function formatDurationText(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    const remainingHours = hours % 24;
    if (remainingHours > 0) {
      return `${days} ${days === 1 ? 'Day' : 'Days'}, ${remainingHours} ${remainingHours === 1 ? 'Hour' : 'Hours'}`;
    }
    return `${days} ${days === 1 ? 'Day' : 'Days'}`;
  }

  if (hours > 0) {
    const remainingMinutes = minutes % 60;
    if (remainingMinutes > 0) {
      return `${hours} ${hours === 1 ? 'Hour' : 'Hours'}, ${remainingMinutes} ${remainingMinutes === 1 ? 'Minute' : 'Minutes'}`;
    }
    return `${hours} ${hours === 1 ? 'Hour' : 'Hours'}`;
  }

  if (minutes > 0) {
    return `${minutes} ${minutes === 1 ? 'Minute' : 'Minutes'}`;
  }

  return `${seconds} Seconds`;
}

/**
 * Save or update a temporary ban expiration in the database
 */
export async function saveTempBan(
  guildId: string,
  userId: string,
  expiresAt: Date,
  reason: string
): Promise<void> {
  await db.pendingPunishment.upsert({
    where: { guildId_userId_type: { guildId, userId, type: 'ban' } },
    update: {
      expiresAt,
      reason,
      reapplied: false,
      reappliedAt: null,
      updatedAt: new Date(),
    },
    create: {
      guildId,
      userId,
      type: 'ban',
      expiresAt,
      reason,
    },
  });
}

/**
 * Remove any pending temporary ban record for a user
 */
export async function removeTempBan(guildId: string, userId: string): Promise<void> {
  await db.pendingPunishment.deleteMany({
    where: { guildId, userId, type: 'ban' },
  }).catch(() => {});
}

/**
 * Check and process all expired temporary bans
 */
export async function checkExpiredBans(client: Client): Promise<void> {
  const now = new Date();

  const expiredBans = await db.pendingPunishment.findMany({
    where: {
      type: 'ban',
      reapplied: false,
      expiresAt: { lte: now },
    },
  }).catch((err) => {
    console.error('[TempBan] Failed to fetch expired bans:', err);
    return [];
  });

  if (!expiredBans || expiredBans.length === 0) return;

  for (const ban of expiredBans) {
    try {
      const guild = client.guilds.cache.get(ban.guildId) ?? await client.guilds.fetch(ban.guildId).catch(() => null);
      if (!guild) {
        // Guild not accessible, mark as resolved so we do not loop forever
        await db.pendingPunishment.update({
          where: { id: ban.id },
          data: { reapplied: true, reappliedAt: now },
        }).catch(() => {});
        continue;
      }

      // Only lift the ban this schedule was created for. If the user was unbanned and
      // banned again by another path, the current ban no longer carries the marker.
      const currentBan = await guild.bans.fetch({ user: ban.userId, force: true }).catch(() => null);
      if (!currentBan || !currentBan.reason?.startsWith('[Temp-Ban ')) {
        await db.pendingPunishment.update({
          where: { id: ban.id },
          data: { reapplied: true, reappliedAt: now },
        }).catch(() => {});
        continue;
      }

      // Perform Discord unban
      let unbanned = false;
      try {
        await guild.bans.remove(ban.userId, `Temporary ban expired. (Original reason: ${ban.reason})`);
        unbanned = true;
        console.log(`[TempBan] Unbanned ${ban.userId} from ${guild.name} (${guild.id})`);
      } catch (err: any) {
        // 10026 = Unknown Ban (already unbanned manually)
        if (err?.code === 10026) {
          unbanned = true;
          console.log(`[TempBan] User ${ban.userId} was already unbanned manually in ${guild.id}`);
        } else {
          console.error(`[TempBan] Failed to unban ${ban.userId} in ${guild.id}:`, err?.message || err);
        }
      }

      // Mark record as completed
      await db.pendingPunishment.update({
        where: { id: ban.id },
        data: { reapplied: true, reappliedAt: now },
      });

      // Audit log entry
      await db.auditLog.create({
        data: {
          guildId: ban.guildId,
          action: 'UNBAN',
          userId: ban.userId,
          details: `Temporary ban expired (Reason: ${ban.reason})`,
          metadata: {
            automatic: true,
            originalReason: ban.reason,
            unbannedAt: now.toISOString(),
          },
        },
      }).catch(() => {});

      // Moderation log channel announcement if configured
      if (unbanned) {
        try {
          const guildData = await db.guild.findUnique({
            where: { discordId: ban.guildId },
            select: { logChannelId: true },
          });

          if (guildData?.logChannelId) {
            const channel = guild.channels.cache.get(guildData.logChannelId) as TextChannel | undefined;
            if (channel && channel.isTextBased()) {
              await channel.send(
                warnCV2({
                  title: '🔓 Temporary Ban Expired',
                  description: `User <@${ban.userId}> has been unbanned.`,
                  fields: [
                    { label: 'User ID', value: `\`${ban.userId}\`` },
                    { label: 'Original Reason', value: ban.reason || 'No reason provided.' },
                    { label: 'Status', value: 'Unbanned automatically' },
                  ],
                })
              );
            }
          }
        } catch {}
      }
    } catch (err) {
      console.error(`[TempBan] Error processing ban ${ban.id}:`, err);
    }
  }
}

/**
 * Start the background manager that regularly checks for expired temporary bans
 */
export function startTempBanManager(client: Client): void {
  // Check immediately on startup
  checkExpiredBans(client).catch((err) => {
    console.error('[TempBan] Error on initial check:', err);
  });

  // Then check every 30 seconds
  setInterval(() => {
    checkExpiredBans(client).catch((err) => {
      console.error('[TempBan] Interval error:', err);
    });
  }, 30 * 1000);

  console.log('   Temp-Ban Manager: Started (checking every 30 seconds)');
}
