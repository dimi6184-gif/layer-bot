import { GuildMember } from 'discord.js';
import { db } from '../db.js';

/**
 * STICKY PUNISHMENT SYSTEM
 *
 * When a user leaves with an active timeout or mute role,
 * the punishment is saved in DB. When they rejoin, it is
 * automatically re-applied for the remaining duration.
 */

// ── Save a timeout when mute command is used ─────────────────────────────────

export async function savePendingTimeout(
  guildId: string,
  userId: string,
  durationMs: number,
  reason: string
) {
  const expiresAt = new Date(Date.now() + durationMs);

  await db.pendingPunishment.upsert({
    where: { guildId_userId_type: { guildId, userId, type: 'timeout' } },
    update: { expiresAt, reason, reapplied: false, reappliedAt: null, updatedAt: new Date() },
    create: { guildId, userId, type: 'timeout', expiresAt, reason },
  });

  console.log(`[StickyPunishment] Saved timeout for ${userId} in ${guildId} — expires ${expiresAt.toISOString()}`);
}

// ── On member leave: log if they have an active punishment ───────────────────

export async function handleLeaveWithPunishment(member: GuildMember) {
  const guildId = member.guild.id;
  const userId = member.user.id;

  // Check if user has an active Discord timeout
  const isTimedOut =
    member.communicationDisabledUntil !== null &&
    member.communicationDisabledUntil > new Date();

  if (isTimedOut && member.communicationDisabledUntil) {
    await db.pendingPunishment.upsert({
      where: { guildId_userId_type: { guildId, userId, type: 'timeout' } },
      update: {
        expiresAt: member.communicationDisabledUntil,
        reapplied: false,
        reappliedAt: null,
        // Don't reset reapplyCount — it tracks cumulative abuse
        updatedAt: new Date(),
      },
      create: {
        guildId,
        userId,
        type: 'timeout',
        expiresAt: member.communicationDisabledUntil,
        reason: 'Left server while timed out',
      },
    });

    console.log(
      `[StickyPunishment] ${member.user.tag} left with active timeout — saved until ${member.communicationDisabledUntil.toISOString()}`
    );
  }
}

// ── On member join: re-apply any pending punishment ──────────────────────────

export async function handleRejoinWithPunishment(member: GuildMember) {
  const guildId = member.guild.id;
  const userId = member.user.id;

  // Find a pending timeout or mute that hasn't been re-applied. There is no re-apply cap:
  // leaving and rejoining repeatedly must not let a member escape the punishment.
  // Temporary bans share this table but are handled by tempBan.ts.
  const pending = await db.pendingPunishment.findFirst({
    where: {
      guildId,
      userId,
      reapplied: false,
      type: { in: ['timeout', 'mute_role'] },
    },
  });

  if (!pending) return;

  const now = new Date();

  // ── Timeout ──────────────────────────────────────────────────────────────

  if (pending.type === 'timeout' && pending.expiresAt) {
    if (pending.expiresAt <= now) {
      // Punishment already expired — clean up and skip
      await db.pendingPunishment.update({
        where: { id: pending.id },
        data: { reapplied: true, reappliedAt: now },
      });
      console.log(`[StickyPunishment] Punishment for ${member.user.tag} already expired — skipping`);
      return;
    }

    const remainingMs = pending.expiresAt.getTime() - now.getTime();
    // Discord max timeout = 28 days
    const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000;
    const clampedMs = Math.min(remainingMs, MAX_TIMEOUT_MS);

    try {
      await member.timeout(
        clampedMs,
        `[Sticky Punishment] Re-applied: ${pending.reason}`
      );

      await db.pendingPunishment.update({
        where: { id: pending.id },
        data: { reapplied: true, reappliedAt: now, reapplyCount: { increment: 1 } },
      });

      // DM the user
      try {
        const remainingMins = Math.ceil(remainingMs / 60000);
        const remainingText =
          remainingMins >= 60
            ? `${Math.floor(remainingMins / 60)}h ${remainingMins % 60}m`
            : `${remainingMins} minutes`;

        await member.send({
          embeds: [
            {
              color: 0xef4444,
              title: '🔇 Timeout Re-Applied',
              description:
                `You were timed out in **${member.guild.name}** before you left.\n` +
                `The remaining **${remainingText}** of your timeout has been re-applied.`,
              fields: [{ name: 'Original Reason', value: pending.reason }],
              footer: { text: 'Leaving the server does not remove active punishments.' },
            },
          ],
        });
      } catch {
        // DMs disabled — ignore
      }

      // Log to audit log
      await db.auditLog.create({
        data: {
          guildId,
          action: 'PUNISHMENT_REAPPLIED',
          userId,
          userName: member.user.tag,
          details: `Re-applied timeout after rejoin (${Math.ceil(remainingMs / 60000)} min remaining)`,
          metadata: {
            type: 'timeout',
            originalReason: pending.reason,
            expiresAt: pending.expiresAt.toISOString(),
          },
        },
      }).catch(() => {});

      console.log(
        `[StickyPunishment] ✅ Re-applied timeout for ${member.user.tag} in ${member.guild.name} (${Math.ceil(clampedMs / 60000)} min remaining)`
      );
    } catch (err: any) {
      console.error(`[StickyPunishment] Failed to re-apply timeout for ${member.user.tag}:`, err.message);
    }
  }
}
