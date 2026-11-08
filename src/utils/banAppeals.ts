import { GuildBan } from 'discord.js';
import { db } from '../db.js';

const recentlyNotified = new Map<string, number>();

function appealUrl(guildId: string) {
  const origin = (process.env.NEXTAUTH_URL || 'https://uselayer.de').replace(/\/$/, '');
  return `${origin}/appeal/${guildId}`;
}

export async function getEnabledBanAppealUrl(guildId: string) {
  const settings = await db.guild.findUnique({
    where: { discordId: guildId },
    select: { banAppealsEnabled: true },
  });
  return settings?.banAppealsEnabled ? appealUrl(guildId) : null;
}

export function markBanAppealDmSent(guildId: string, userId: string) {
  const key = `${guildId}:${userId}`;
  recentlyNotified.set(key, Date.now() + 30_000);
  setTimeout(() => recentlyNotified.delete(key), 30_000).unref?.();
}

export async function notifyBannedUserAboutAppeal(ban: GuildBan) {
  try {
    const url = await getEnabledBanAppealUrl(ban.guild.id);
    if (!url) return;

    const key = `${ban.guild.id}:${ban.user.id}`;
    const expiry = recentlyNotified.get(key);
    if (expiry && expiry > Date.now()) {
      recentlyNotified.delete(key);
      return;
    }

    await ban.user.send({
      content: `You were banned from **${ban.guild.name}**. If you believe this was a mistake, you can submit an appeal here: ${url}`,
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    console.info(`[BanAppeal] Could not DM the banned user in ${ban.guild.id}:`, error);
  }
}
