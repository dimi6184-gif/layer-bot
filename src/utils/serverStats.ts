import { ChannelType, Client, Events, Guild, VoiceChannel } from 'discord.js';
import { db } from '../db.js';

type Metric = 'members' | 'boosts' | 'bots' | 'roles' | 'channels';
type Config = {
  discordId: string;
  serverStatsEnabled: boolean;
  serverStatsCategoryId: string | null;
  serverStatsMembers: boolean;
  serverStatsBoosts: boolean;
  serverStatsBots: boolean;
  serverStatsRoles: boolean;
  serverStatsChannels: boolean;
  serverStatsChannelIds: unknown;
  serverStatsTemplates: unknown;
};

export const DEFAULT_SERVER_STATS_TEMPLATES: Record<Metric, string> = {
  members: '👥・Members: {count}',
  boosts: '🚀・Boosts: {count}',
  bots: '🤖・Bots: {count}',
  roles: '🎭・Roles: {count}',
  channels: '💬・Channels: {count}',
};

export function formatServerStatsChannelName(template: string, count: number): string {
  const formattedCount = count.toLocaleString('en-US');
  let name = template.trim();
  if (name.includes('{count}')) {
    name = name.replace(/\{count\}/gi, formattedCount);
  } else if (name.includes('{number}')) {
    name = name.replace(/\{number\}/gi, formattedCount);
  } else if (name.includes('%COUNT%')) {
    name = name.replace(/%COUNT%/g, formattedCount);
  } else {
    name = `${name}: ${formattedCount}`;
  }
  return name.slice(0, 100);
}

function readTemplates(value: unknown): Partial<Record<Metric, string>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const templates: Partial<Record<Metric, string>> = {};
  for (const key of Object.keys(DEFAULT_SERVER_STATS_TEMPLATES) as Metric[]) {
    const raw = (value as Record<string, unknown>)[key];
    if (typeof raw === 'string' && raw.trim().length > 0) {
      templates[key] = raw.trim();
    }
  }
  return templates;
}

const labels: Record<Metric, { emoji: string; label: string }> = {
  members: { emoji: '👥', label: 'members' },
  boosts: { emoji: '🚀', label: 'boosts' },
  bots: { emoji: '🤖', label: 'bots' },
  roles: { emoji: '🎭', label: 'roles' },
  channels: { emoji: '💬', label: 'channels' },
};

const pending = new Map<string, NodeJS.Timeout>();
const botCountFetched = new Set<string>();
const botCountFetchAttemptedAt = new Map<string, number>();

function channelIds(value: unknown): Partial<Record<Metric, string>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const ids: Partial<Record<Metric, string>> = {};
  for (const key of Object.keys(labels) as Metric[]) {
    const id = (value as Record<string, unknown>)[key];
    if (typeof id === 'string') ids[key] = id;
  }
  return ids;
}

async function getBotCount(guild: Guild) {
  const lastAttempt = botCountFetchAttemptedAt.get(guild.id) ?? 0;
  if (!botCountFetched.has(guild.id) && Date.now() - lastAttempt > 10 * 60 * 1000) {
    botCountFetchAttemptedAt.set(guild.id, Date.now());
    try {
      await guild.members.fetch();
      botCountFetched.add(guild.id);
    } catch (error) {
      console.warn(`[ServerStats] Could not refresh members for ${guild.id}:`, error);
    }
  }
  return guild.members.cache.filter((member) => member.user.bot).size;
}

async function updateGuildStats(guild: Guild, config: Config) {
  if (!config.serverStatsEnabled || !config.serverStatsCategoryId) return;
  const ids = channelIds(config.serverStatsChannelIds);
  const enabled: Record<Metric, boolean> = {
    members: config.serverStatsMembers,
    boosts: config.serverStatsBoosts,
    bots: config.serverStatsBots,
    roles: config.serverStatsRoles,
    channels: config.serverStatsChannels,
  };
  const counts: Record<Metric, number> = {
    members: guild.memberCount,
    boosts: guild.premiumSubscriptionCount ?? 0,
    bots: config.serverStatsBots ? await getBotCount(guild) : 0,
    roles: guild.roles.cache.filter((role) => role.id !== guild.id).size,
    channels: guild.channels.cache.filter((channel) => channel.type !== ChannelType.GuildCategory && !Object.values(ids).includes(channel.id)).size,
  };

  const customTemplates = readTemplates(config.serverStatsTemplates);

  for (const metric of Object.keys(labels) as Metric[]) {
    if (!enabled[metric] || !ids[metric]) continue;
    const channel = guild.channels.cache.get(ids[metric]!) ?? await guild.channels.fetch(ids[metric]!).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildVoice || channel.parentId !== config.serverStatsCategoryId) continue;
    const template = customTemplates[metric] || DEFAULT_SERVER_STATS_TEMPLATES[metric];
    const name = formatServerStatsChannelName(template, counts[metric]);
    if (channel.name !== name) await (channel as VoiceChannel).setName(name, 'Update live server statistics').catch((error) => {
      console.warn(`[ServerStats] Could not rename channel ${channel.id}:`, error);
    });
  }
}

export function scheduleServerStatsUpdate(guild: Guild) {
  const current = pending.get(guild.id);
  if (current) clearTimeout(current);
  pending.set(guild.id, setTimeout(() => {
    pending.delete(guild.id);
    void db.guild.findUnique({ where: { discordId: guild.id } }).then((config) => {
      if (config) return updateGuildStats(guild, config as Config);
    }).catch((error) => console.error(`[ServerStats] Update failed for ${guild.id}:`, error));
  }, 1500));
}

export function startServerStatsManager(client: Client) {
  const refresh = async () => {
    const configs = await db.guild.findMany({ where: { serverStatsEnabled: true } }).catch((error) => {
      console.error('[ServerStats] Could not load configurations:', error);
      return [];
    });
    for (const config of configs) {
      const guild = client.guilds.cache.get(config.discordId);
      if (guild) scheduleServerStatsUpdate(guild);
    }
  };

  void refresh();
  setInterval(() => void refresh(), 60_000);
  client.on(Events.GuildMemberAdd, (member) => scheduleServerStatsUpdate(member.guild));
  client.on(Events.GuildMemberRemove, (member) => scheduleServerStatsUpdate(member.guild));
  client.on(Events.GuildMemberUpdate, (oldMember, newMember) => {
    if (oldMember.premiumSinceTimestamp !== newMember.premiumSinceTimestamp) scheduleServerStatsUpdate(newMember.guild);
  });
  client.on(Events.GuildRoleCreate, (role) => scheduleServerStatsUpdate(role.guild));
  client.on(Events.GuildRoleDelete, (role) => scheduleServerStatsUpdate(role.guild));
  client.on(Events.ChannelCreate, (channel) => { if (channel.isDMBased() === false && 'guild' in channel) scheduleServerStatsUpdate(channel.guild); });
  client.on(Events.ChannelDelete, (channel) => { if (channel.isDMBased() === false && 'guild' in channel) scheduleServerStatsUpdate(channel.guild); });
}
