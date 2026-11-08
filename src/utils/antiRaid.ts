import {
  Guild,
  GuildMember,
  Message,
  TextChannel,
  PermissionFlagsBits,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  ChannelType,
  MessageType,
  ApplicationIntegrationType,
} from 'discord.js';
import { db } from '../db.js';

interface RecentJoinInfo {
  memberId: string;
  tag: string;
  joinedAt: number;
  createdAt: number;
  hasCustomAvatar: boolean;
}

interface RecentAppInvocation {
  userId: string;
  applicationId: string | null;
  createdAt: number;
}

// In-memory sliding window join tracking
const guildJoins = new Map<string, { memberId: string; at: number }[]>(); // guildId -> recent joins
const guildRecentMembers = new Map<string, RecentJoinInfo[]>(); // guildId -> recent join info
const activeRaids = new Map<string, { startTime: number; expiresAt: number; raiderIds: Set<string> }>();
const LOCKDOWN_PERMISSIONS = ['SendMessages', 'SendMessagesInThreads', 'CreatePublicThreads', 'CreatePrivateThreads', 'AddReactions'] as const;
type LockdownPermission = typeof LOCKDOWN_PERMISSIONS[number];
// channelId -> the @everyone state of each locked permission before lockdown (true allow, false deny, null inherit)
type LockdownSnapshot = Record<string, Record<LockdownPermission, boolean | null>>;
const LOCKDOWN_SNAPSHOT_ACTION = 'ANTIRAID_LOCKDOWN_SNAPSHOT';
const recentAppInvocations = new Map<string, RecentAppInvocation[]>();

function appInvocationKey(guildId: string, channelId: string): string {
  return `${guildId}:${channelId}`;
}

function rememberAppInvocation(key: string, userId: string, applicationId: string | null): void {
  const now = Date.now();
  const pending = (recentAppInvocations.get(key) ?? []).filter((entry) => now - entry.createdAt < 30_000);
  pending.push({ userId, applicationId, createdAt: now });
  recentAppInvocations.set(key, pending);
}

function hasRecentAppInvocation(key: string, applicationId: string | null): boolean {
  const now = Date.now();
  const pending = (recentAppInvocations.get(key) ?? []).filter((entry) => now - entry.createdAt < 30_000);
  if (pending.length) recentAppInvocations.set(key, pending);
  else recentAppInvocations.delete(key);
  return pending.some((entry) => !applicationId || !entry.applicationId || entry.applicationId === applicationId);
}

function consumeAppInvocation(key: string, applicationId: string | null, preferredUserId?: string): RecentAppInvocation | null {
  const now = Date.now();
  const pending = (recentAppInvocations.get(key) ?? []).filter((entry) => now - entry.createdAt < 30_000);
  const matchIndex = pending.findIndex((entry) =>
    (!applicationId || !entry.applicationId || entry.applicationId === applicationId) &&
    (!preferredUserId || entry.userId === preferredUserId),
  );
  const invocation = matchIndex >= 0 ? pending.splice(matchIndex, 1)[0] : null;
  if (pending.length) recentAppInvocations.set(key, pending);
  else recentAppInvocations.delete(key);
  return invocation ?? null;
}

export function isRaidActive(guildId: string): boolean {
  const raid = activeRaids.get(guildId);
  if (!raid) return false;
  if (Date.now() > raid.expiresAt) {
    activeRaids.delete(guildId);
    return false;
  }
  return true;
}

export function activateRaid(guildId: string, durationMinutes = 10): void {
  const existing = activeRaids.get(guildId);
  const expiresAt = Date.now() + durationMinutes * 60 * 1000;
  if (existing) {
    existing.expiresAt = Math.max(existing.expiresAt, expiresAt);
  } else {
    activeRaids.set(guildId, {
      startTime: Date.now(),
      expiresAt,
      raiderIds: new Set<string>(),
    });
  }
}

export function clearRaid(guildId: string): void {
  activeRaids.delete(guildId);
}

/**
 * Handle new member join for Anti-Raid detection
 */
export async function handleAntiRaidJoin(member: GuildMember): Promise<void> {
  const { guild } = member;
  const settings = await (db.guild.findUnique as any)({
    where: { discordId: guild.id },
    select: {
      antiRaidEnabled: true,
      antiRaidJoinThreshold: true,
      antiRaidJoinTimeframe: true,
      antiRaidAction: true,
      antiRaidTimeoutMinutes: true,
      antiRaidQuarantineRoleId: true,
      antiRaidMinAccountAgeDays: true,
      antiRaidDefaultAvatarKick: true,
      antiRaidAutoLockdown: true,
      antiRaidLogChannelId: true,
    },
  });

  const now = Date.now();
  const timeframeMs = ((settings?.antiRaidJoinTimeframe) || 10) * 1000;
  const threshold = (settings?.antiRaidJoinThreshold) || 5;

  // Count distinct members, so one account leaving and rejoining cannot fake a join spike
  const joins = (guildJoins.get(guild.id) || []).filter((j) => now - j.at <= timeframeMs && j.memberId !== member.id);
  joins.push({ memberId: member.id, at: now });
  guildJoins.set(guild.id, joins);
  const timestamps = joins;

  // Automated Night-Raid Emergency Spike Shield (Protects server even if manual antiRaid is off)
  if (!settings?.antiRaidEnabled) {
    if (timestamps.length >= 8 && !isRaidActive(guild.id)) {
      activateRaid(guild.id, 10);
      console.warn(`[Anti-Raid] Automatic Night-Raid Shield triggered in ${guild.name}: ${timestamps.length} joins in 10s`);
      await sendRaidAlert(guild, {
        title: '🛡️ AUTOMATIC RAID SHIELD ACTIVATED',
        description: `**Abnormal mass join spike detected!**\n\n- **Traffic:** ${timestamps.length} joins in 10 seconds\n- **Action:** Verification temporarily frozen for 10 minutes to protect against token raid bots.\n- **Mode:** Automated Night-Raid Shield`,
        logChannelId: settings?.antiRaidLogChannelId,
      }).catch(() => {});
    }
    return;
  }

  // Track recent member info (keep last 30 minutes)
  const recentList = (guildRecentMembers.get(guild.id) || []).filter((m) => now - m.joinedAt <= 30 * 60 * 1000);
  const accountAgeDays = (now - member.user.createdTimestamp) / (1000 * 60 * 60 * 24);
  const hasCustomAvatar = !!member.user.avatar;

  recentList.push({
    memberId: member.id,
    tag: member.user.tag || member.user.username,
    joinedAt: now,
    createdAt: member.user.createdTimestamp,
    hasCustomAvatar,
  });
  guildRecentMembers.set(guild.id, recentList);

  let raidTriggered = isRaidActive(guild.id);

  if (timestamps.length >= threshold && !raidTriggered) {
    raidTriggered = true;
    activateRaid(guild.id, 15);
    console.warn(`[Anti-Raid] RAID DETECTED in guild ${guild.name} (${guild.id}): ${timestamps.length} joins in ${settings.antiRaidJoinTimeframe}s`);

    // Execute automated server lockdown if configured
    let lockedCount = 0;
    if (settings.antiRaidAutoLockdown) {
      lockedCount = await executeServerLockdown(guild, `Anti-Raid triggered: ${timestamps.length} joins in ${settings.antiRaidJoinTimeframe}s`);
      await db.guild.update({
        where: { discordId: guild.id },
        data: { antiRaidLockdownActive: true },
      }).catch(() => {});
    }

    // Send emergency alert
    await sendRaidAlert(guild, {
      title: '🚨 RAID DETECTED AND CONTAINED',
      description: `**Mass join spike detected!**\n\n- **Joins detected:** ${timestamps.length} in ${settings.antiRaidJoinTimeframe} seconds\n- **Action taken:** ${settings.antiRaidAction.toUpperCase()}\n- **Channels locked:** ${lockedCount}\n- **Auto-Lockdown:** ${settings.antiRaidAutoLockdown ? 'ACTIVE' : 'Disabled'}`,
      logChannelId: settings.antiRaidLogChannelId,
    });
  }

  // If a raid is currently active, punish incoming raiders
  if (raidTriggered) {
    const raid = activeRaids.get(guild.id);
    if (raid) raid.raiderIds.add(member.id);

    const isYoungAccount = accountAgeDays < (settings.antiRaidMinAccountAgeDays || 3);
    const isDefaultAvatar = settings.antiRaidDefaultAvatarKick && !hasCustomAvatar;

    // Apply punishment action
    await punishRaider(member, {
      action: settings.antiRaidAction || 'kick',
      timeoutMinutes: settings.antiRaidTimeoutMinutes || 60,
      quarantineRoleId: settings.antiRaidQuarantineRoleId,
      reason: isYoungAccount
        ? `[Anti-Raid] Suspicious account created ${Math.round(accountAgeDays * 24)}h ago during active raid`
        : isDefaultAvatar
        ? '[Anti-Raid] Default avatar account during active raid'
        : '[Anti-Raid] Automated Mass Join Protection',
    });
  }
}

/**
 * Handle messages to protect against User Apps, Webhook Spam, and Raid Floods
 */
export async function handleAntiRaidMessage(message: Message): Promise<boolean> {
  if (!message.guild || message.author.id === message.client.user?.id) return false;

  const settings = await (db.guild.findUnique as any)({
    where: { discordId: message.guild.id },
    select: {
      antiRaidEnabled: true,
      antiRaidBlockUserApps: true,
      antiRaidBlockWebhooks: true,
      antiRaidLogChannelId: true,
    },
  });

  if (!settings?.antiRaidEnabled) return false;

  // 1. Block external app messages. User-installed app replies are not guaranteed
  // to include interaction metadata, so applicationId is the primary signal.
  if (settings.antiRaidBlockUserApps) {
    const applicationId = message.applicationId;
    const ownApplicationId = message.client.user?.id;
    const isAppCommand = message.type === MessageType.ChatInputCommand || message.type === MessageType.ContextMenuCommand;
    // Apps the server installed itself are allowed; only user-installed apps are blocked.
    const guildInstalled = await isGuildInstalledApp(message, applicationId);
    const isExternalApp = !!applicationId && applicationId !== ownApplicationId && !guildInstalled;
    const invocationKey = appInvocationKey(message.guild.id, message.channel.id);

    // Discord emits a user-authored system message for slash/context-menu app
    // commands. Remember it so the app's follow-up can still be attributed if
    // Discord omits interaction_metadata or applicationId from that follow-up.
    if (isAppCommand && !message.author.bot && applicationId !== ownApplicationId && !guildInstalled) {
      const commandInvoker = message.interactionMetadata?.user ?? message.interaction?.user ?? message.author;
      rememberAppInvocation(invocationKey, commandInvoker.id, isExternalApp ? applicationId : null);
    }

    // Do not require interaction metadata here: regular application webhook
    // replies may have applicationId but no interaction/interactionMetadata.
    // When applicationId is absent, a recent app command plus a bot-authored
    // follow-up is the fallback signal.
    const hasMatchingInvocation = hasRecentAppInvocation(invocationKey, applicationId);
    // A user-installed app's reply to a slash command is itself a command-type message,
    // so command types count as responses whenever they come from an external app.
    const isAppResponse = (isExternalApp && (message.author.bot || !isAppCommand)) || (
      !isAppCommand && !guildInstalled &&
      message.author.bot && message.author.id !== ownApplicationId && hasMatchingInvocation
    );

    if (isAppResponse) {
      const metadataInvoker = message.interactionMetadata?.user ?? message.interaction?.user ?? null;
      const queuedInvocation = consumeAppInvocation(invocationKey, applicationId, metadataInvoker?.id);
      const invokerId = metadataInvoker?.id ?? queuedInvocation?.userId ?? (!message.author.bot ? message.author.id : null);
      const detectedApplicationId = applicationId ?? queuedInvocation?.applicationId ?? (message.author.bot ? message.author.id : null);
      // Check if user who invoked it is staff
      const member = invokerId
        ? message.guild.members.cache.get(invokerId) ?? await message.guild.members.fetch(invokerId).catch(() => null)
        : null;
      const isStaff = member?.permissions.has(PermissionFlagsBits.ManageMessages) ||
        member?.permissions.has(PermissionFlagsBits.Administrator);

      if (!isStaff) {
        await message.delete().catch(() => {});
        let timedOut = false;
        if (member && member.moderatable) {
          timedOut = await member.timeout(10 * 60 * 1000, '[Anti-Raid] Blocked unauthorized User App interaction')
            .then(() => true)
            .catch(() => false);
        }

        await sendRaidAlert(message.guild, {
          title: '🛡️ Unauthorized User App Blocked',
          description: [
            `Removed a message from an unauthorized user-installed app in <#${message.channel.id}>.`,
            `**App ID:** ${detectedApplicationId ? `\`${detectedApplicationId}\`` : 'Unavailable'}`,
            `**User who ran it:** ${invokerId ? `<@${invokerId}>` : 'Unknown (Discord did not provide the invoking user).'}`,
            timedOut ? 'The user was timed out for 10 minutes.' : 'A timeout could not be applied.',
          ].join('\n'),
          logChannelId: settings.antiRaidLogChannelId,
        });
        return true;
      }
    }
  }

  // 2. Block unauthorized Webhook Spam
  if (settings.antiRaidBlockWebhooks && message.webhookId) {
    const content = message.content.toLowerCase();
    const hasEveryone = content.includes('@everyone') || content.includes('@here');
    const isRaid = isRaidActive(message.guild.id);

    if (hasEveryone || isRaid) {
      await message.delete().catch(() => {});
      console.warn(`[Anti-Raid] Deleted suspicious webhook message in ${message.guild.name}`);
      return true;
    }
  }

  // 3. Mention Flood during Raid
  if (isRaidActive(message.guild.id) && message.member && !message.member.permissions.has(PermissionFlagsBits.MentionEveryone)) {
    const mentions = message.mentions.users.size + message.mentions.roles.size;
    const content = message.content.toLowerCase();
    const hasEveryone = content.includes('@everyone') || content.includes('@here');

    if (hasEveryone || mentions >= 3) {
      await message.delete().catch(() => {});
      if (message.member.moderatable) {
        await message.member.timeout(60 * 60 * 1000, '[Anti-Raid] Mention flood during active raid').catch(() => {});
      }
      return true;
    }
  }

  return false;
}

/**
 * Apply punishment to an identified raider member
 */
async function punishRaider(
  member: GuildMember,
  opts: {
    action: string;
    timeoutMinutes: number;
    quarantineRoleId?: string | null;
    reason: string;
  }
): Promise<void> {
  const { action, timeoutMinutes, quarantineRoleId, reason } = opts;

  try {
    if (action === 'ban' && member.bannable) {
      await member.ban({ deleteMessageSeconds: 86400, reason });
      console.log(`[Anti-Raid] Banned ${member.user.tag} (${member.id})`);
    } else if (action === 'kick' && member.kickable) {
      await member.kick(reason);
      console.log(`[Anti-Raid] Kicked ${member.user.tag} (${member.id})`);
    } else if (action === 'quarantine' && quarantineRoleId) {
      await member.roles.add(quarantineRoleId, reason).catch(() => {});
      console.log(`[Anti-Raid] Quarantined ${member.user.tag} (${member.id})`);
    } else if (member.moderatable) {
      await member.timeout(timeoutMinutes * 60 * 1000, reason);
      console.log(`[Anti-Raid] Timed out ${member.user.tag} (${member.id}) for ${timeoutMinutes}m`);
    }
  } catch (err) {
    console.error(`[Anti-Raid] Failed to punish ${member.id}:`, err);
  }
}

async function isGuildInstalledApp(message: Message, applicationId: string | null): Promise<boolean> {
  const owners = message.interactionMetadata?.authorizingIntegrationOwners;
  if (owners?.[ApplicationIntegrationType.GuildInstall]) return true;
  if (!applicationId || !message.guild) return false;
  // A bot user that is a member of the server was installed by the server.
  const appMember = message.guild.members.cache.get(applicationId) ?? await message.guild.members.fetch(applicationId).catch(() => null);
  return !!appMember?.user.bot;
}

async function loadLockdownSnapshot(guildId: string): Promise<LockdownSnapshot> {
  const row = await db.auditLog.findFirst({
    where: { guildId, action: LOCKDOWN_SNAPSHOT_ACTION },
    orderBy: { createdAt: 'desc' },
  }).catch(() => null);
  return ((row?.metadata as { channels?: LockdownSnapshot } | null)?.channels) ?? {};
}

async function saveLockdownSnapshot(guildId: string, channels: LockdownSnapshot): Promise<void> {
  await db.auditLog.create({
    data: {
      guildId,
      action: LOCKDOWN_SNAPSHOT_ACTION,
      details: `Anti-raid lockdown snapshot of ${Object.keys(channels).length} channels`,
      metadata: { channels },
    },
  }).catch((err) => console.error('[Anti-Raid] Failed to save lockdown snapshot:', err));
}

/**
 * Freeze public text channels by denying SendMessages for @everyone.
 * The previous state is persisted so lifting restores it exactly, even after a restart.
 */
export async function executeServerLockdown(guild: Guild, reason: string): Promise<number> {
  const everyoneRole = guild.roles.everyone;
  let lockedCount = 0;

  // Keep the state captured by an earlier, still active lockdown.
  const snapshot = await loadLockdownSnapshot(guild.id);

  const channels = await guild.channels.fetch().catch(() => null);
  if (!channels) return 0;

  for (const [, channel] of channels) {
    if (!channel || channel.type !== ChannelType.GuildText) continue;
    const textChannel = channel as TextChannel;

    try {
      const currentOverwrite = textChannel.permissionOverwrites.cache.get(everyoneRole.id);
      if (!snapshot[textChannel.id]) {
        // Already read-only for @everyone: nothing to lock, and nothing to restore later.
        if (currentOverwrite?.deny.has(PermissionFlagsBits.SendMessages)) continue;
        const state = {} as Record<LockdownPermission, boolean | null>;
        for (const permission of LOCKDOWN_PERMISSIONS) {
          const bit = PermissionFlagsBits[permission];
          state[permission] = currentOverwrite?.allow.has(bit) ? true : currentOverwrite?.deny.has(bit) ? false : null;
        }
        snapshot[textChannel.id] = state;
      }

      await textChannel.permissionOverwrites.edit(
        everyoneRole,
        {
          SendMessages: false,
          SendMessagesInThreads: false,
          CreatePublicThreads: false,
          CreatePrivateThreads: false,
          AddReactions: false,
        },
        { reason: `[Anti-Raid Lockdown] ${reason}` }
      );

      lockedCount++;
    } catch {
      // Ignore channels bot cannot manage
      if (!channel.permissionOverwrites.cache.get(everyoneRole.id)?.deny.has(PermissionFlagsBits.SendMessages)) {
        delete snapshot[textChannel.id];
      }
    }
  }

  await saveLockdownSnapshot(guild.id, snapshot);
  return lockedCount;
}

/**
 * Lift server lockdown and restore channel permissions
 */
export async function liftServerLockdown(guild: Guild): Promise<number> {
  const everyoneRole = guild.roles.everyone;
  let unlockedCount = 0;

  // Only channels this lockdown changed are touched, and each gets its exact previous state back.
  const snapshot = await loadLockdownSnapshot(guild.id);

  for (const [channelId, state] of Object.entries(snapshot)) {
    const textChannel = await guild.channels.fetch(channelId).catch(() => null) as TextChannel | null;
    if (!textChannel || textChannel.type !== ChannelType.GuildText) continue;

    try {
      await textChannel.permissionOverwrites.edit(everyoneRole, state, { reason: '[Anti-Raid] Lockdown lifted by staff' });
      const overwrite = textChannel.permissionOverwrites.cache.get(everyoneRole.id);
      if (overwrite && overwrite.allow.bitfield === 0n && overwrite.deny.bitfield === 0n) {
        await overwrite.delete('[Anti-Raid] Lockdown lifted by staff').catch(() => {});
      }
      unlockedCount++;
    } catch {
      // Ignore
    }
  }

  await saveLockdownSnapshot(guild.id, {});
  clearRaid(guild.id);

  await db.guild.update({
    where: { discordId: guild.id },
    data: { antiRaidLockdownActive: false },
  }).catch(() => {});

  return unlockedCount;
}

/**
 * Bulk action on members who joined in the last X minutes
 */
export async function cleanRecentRaiders(
  guild: Guild,
  minutes = 15,
  action: 'kick' | 'ban' = 'ban'
): Promise<number> {
  const cutoff = Date.now() - minutes * 60 * 1000;
  const recentList = guildRecentMembers.get(guild.id) || [];
  const targetIds = recentList.filter((m) => m.joinedAt >= cutoff).map((m) => m.memberId);

  let affected = 0;
  for (const memberId of targetIds) {
    try {
      const member = await guild.members.fetch(memberId).catch(() => null);
      if (!member) continue;

      if (action === 'ban' && member.bannable) {
        await member.ban({ deleteMessageSeconds: 86400, reason: `[Anti-Raid Clean] Bulk ban (${minutes}m window)` });
        affected++;
      } else if (action === 'kick' && member.kickable) {
        await member.kick(`[Anti-Raid Clean] Bulk kick (${minutes}m window)`);
        affected++;
      }
    } catch {
      // Continue
    }
  }

  return affected;
}

/**
 * Helper to dispatch raid alert to log channel
 */
async function sendRaidAlert(
  guild: Guild,
  opts: {
    title: string;
    description: string;
    logChannelId?: string | null;
  }
): Promise<void> {
  const { title, description, logChannelId } = opts;

  let targetChannel: TextChannel | null = null;
  if (logChannelId) {
    targetChannel = (await guild.channels.fetch(logChannelId).catch(() => null)) as TextChannel | null;
  }
  if (!targetChannel) {
    targetChannel = guild.systemChannel as TextChannel | null;
  }

  if (!targetChannel) return;

  const embed = new EmbedBuilder()
    .setColor('#ef4444')
    .setTitle(title)
    .setDescription(description)
    .setTimestamp()
    .setFooter({ text: 'Layer Anti-Raid Shield' });

  const unlockBtn = new ButtonBuilder()
    .setCustomId(`antiraid:unlock:${guild.id}`)
    .setLabel('Lift Lockdown')
    .setEmoji('🔓')
    .setStyle(ButtonStyle.Success);

  const banRecentBtn = new ButtonBuilder()
    .setCustomId(`antiraid:banrecent:${guild.id}`)
    .setLabel('Ban Recent Raiders')
    .setEmoji('🔨')
    .setStyle(ButtonStyle.Danger);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(unlockBtn, banRecentBtn);

  await targetChannel.send({
    embeds: [embed],
    components: [row],
  }).catch(() => {});
}
