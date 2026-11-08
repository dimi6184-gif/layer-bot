import {
  Client,
  Collection,
  GatewayIntentBits,
  Partials,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ModalSubmitInteraction,
  GuildMember,
  PermissionFlagsBits,
  Guild,
} from 'discord.js';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { addXP, ACHIEVEMENTS } from './commands/leveling/rank.js';
import { detectScam } from './utils/scamDetector.js';
import { checkCooldown, COOLDOWNS } from './utils/cooldowns.js';
import { db } from './db.js';

dotenv.config();
import { initCanvasFonts } from './utils/canvasFonts.js';
initCanvasFonts();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Types ──────────────────────────────────────────────────────────────────

interface Command {
  data: SlashCommandBuilder;
  execute(interaction: ChatInputCommandInteraction): Promise<void>;
}

// ─── Client ─────────────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

const commands = new Collection<string, Command>();

async function syncBotGuild(guild: Guild) {
  const lastSeenAt = new Date();
  await db.guild.upsert({
    where: { discordId: guild.id },
    create: {
      discordId: guild.id,
      name: guild.name,
      iconHash: guild.icon,
      memberCount: guild.memberCount,
      botPresent: true,
      botJoinedAt: guild.joinedAt ?? lastSeenAt,
      lastSeenAt,
    },
    update: {
      name: guild.name,
      iconHash: guild.icon,
      memberCount: guild.memberCount,
      botPresent: true,
      botJoinedAt: guild.joinedAt ?? undefined,
      lastSeenAt,
    },
  });
}

async function syncBotGuildInventory(guilds: Collection<string, Guild>) {
  const currentGuilds = [...guilds.values()];
  const currentIds = currentGuilds.map((guild) => guild.id);

  await db.guild.updateMany({
    where: currentIds.length
      ? { botPresent: true, discordId: { notIn: currentIds } }
      : { botPresent: true },
    data: { botPresent: false },
  });

  for (const guild of currentGuilds) {
    await syncBotGuild(guild);
  }
}

// ─── Cooldown Helper ────────────────────────────────────────────────────────

function getCooldownForCommand(commandName: string) {
  // Map command names to cooldown configs
  const cooldownMap: Record<string, typeof COOLDOWNS[keyof typeof COOLDOWNS]> = {
    'ban': COOLDOWNS.BAN,
    'kick': COOLDOWNS.KICK,
    'mute': COOLDOWNS.MUTE,
    'warn': COOLDOWNS.WARN,
    'clear': COOLDOWNS.CLEAR,
    'antiraid': COOLDOWNS.ANTIRAID,
    'rank': COOLDOWNS.RANK,
    'leaderboard': COOLDOWNS.LEADERBOARD,
    'ask': COOLDOWNS.AI_ASK,
    'serverinfo': COOLDOWNS.SERVERINFO,
    'userinfo': COOLDOWNS.USERINFO,
    'giveaway': COOLDOWNS.GIVEAWAY,
    'poll': COOLDOWNS.POLL,
  };
  
  return cooldownMap[commandName] || COOLDOWNS.DEFAULT;
}

// ─── Load commands from all subfolders ──────────────────────────────────────

async function loadCommands() {
  const commandsPath = path.join(__dirname, 'commands');
  const categories = fs.readdirSync(commandsPath);

  for (const category of categories) {
    const categoryPath = path.join(commandsPath, category);
    if (!fs.statSync(categoryPath).isDirectory()) continue;

    const files = fs.readdirSync(categoryPath).filter((f) => f.endsWith('.js') || f.endsWith('.ts'));

    for (const file of files) {
      const filePath = path.join(categoryPath, file);
      const commandUrl = pathToFileURL(filePath).href;
      const command: Command = await import(commandUrl);
      if (command.data && typeof command.execute === 'function') {
        commands.set(command.data.name, command);
        console.log(`  ✓ Loaded /${command.data.name}`);
      }
    }
  }
}

// ─── Deploy slash commands to Discord ───────────────────────────────────────

async function deployCommands() {
  const token = process.env.DISCORD_TOKEN!;
  const clientId = process.env.CLIENT_ID!;
  const guildId = process.env.DEV_GUILD_ID;

  const rest = new REST({ version: '10' }).setToken(token);
  const commandsJSON = [...commands.values()].map((c) => c.data.toJSON());

  console.log(`\n📤 Deploying ${commandsJSON.length} slash commands globally to all servers...`);
  try {
    await rest.put(Routes.applicationCommands(clientId), { body: commandsJSON });
    console.log('✅ Slash commands deployed globally to all servers.\n');
  } catch (err) {
    console.error('Failed to deploy slash commands globally:', err);
  }

  const instantGuildIds = Array.from(new Set([
    ...(guildId ? guildId.split(',') : []),
    '1557787459792928839',
    '1513589369921994782',
  ].map((g) => g.trim()).filter(Boolean)));

  for (const gId of instantGuildIds) {
    try {
      console.log(`📤 Deploying ${commandsJSON.length} slash commands to guild ${gId} (instant)...`);
      await rest.put(Routes.applicationGuildCommands(clientId, gId), { body: commandsJSON });
      console.log(`✅ Slash commands deployed to guild ${gId}.\n`);
    } catch (err) {
      console.error(`Failed to deploy commands to guild ${gId}:`, err);
    }
  }
}

import { startGiveawayManager } from './utils/giveawayManager.js';
import { startTempBanManager } from './utils/tempBan.js';
import { GhostCleaner } from './utils/ghostCleaner.js';
import { startServerStatsManager } from './utils/serverStats.js';
import { notifyBannedUserAboutAppeal } from './utils/banAppeals.js';
import { setupAIImageDetection } from './events/aiImageDetectionHandler.js';

// Register the AI-generated image detector for messages containing images.
setupAIImageDetection(client);

// ─── Ready ──────────────────────────────────────────────────────────────────

client.once(Events.ClientReady, async (c) => {
  console.log(`\n🟣 Layer Bot online as ${c.user.tag}`);
  console.log(`   Guilds: ${c.guilds.cache.size}`);

  // Keep the monitor's server inventory aligned with the live Discord gateway.
  const refreshGuildInventory = () => {
    void syncBotGuildInventory(c.guilds.cache).catch((error) => {
      console.error('[Monitor] Could not sync bot server inventory:', error);
    });
  };
  refreshGuildInventory();
  setInterval(refreshGuildInventory, 5 * 60 * 1000);
  
  // Professional rotating status
  const statuses = [
    { name: 'your server 🛡️', type: 3 }, // Watching
    { name: '/help for commands', type: 2 }, // Listening
    { name: `${c.guilds.cache.size} servers`, type: 3 }, // Watching
    { name: 'AI-powered moderation', type: 0 }, // Playing
    { name: 'for scams and spam', type: 3 }, // Watching
  ];
  
  let currentStatus = 0;
  
  const updateStatus = () => {
    c.user.setPresence({
      activities: [statuses[currentStatus]],
      status: 'online',
    });
    currentStatus = (currentStatus + 1) % statuses.length;
  };
  
  // Set initial status
  updateStatus();
  
  // Rotate status every 30 seconds
  setInterval(updateStatus, 30000);

  // ─── Upcore monitoring heartbeat: ping every 60s with gateway ping ───
  // The push token belongs in configuration, never in source.
  const UPCORE_PUSH_URL = process.env.UPCORE_PUSH_URL;
  if (UPCORE_PUSH_URL) {
    const pingUpcore = () => {
      const wsPing = Math.round(c.ws.ping);
      const validPing = Number.isFinite(wsPing) && wsPing >= 0 ? wsPing : 0;
      fetch(`${UPCORE_PUSH_URL}?status=up&ping=${validPing}&msg=OK`).catch(() => {});
    };
    pingUpcore();
    setInterval(pingUpcore, 60 * 1000);
    console.log(`   Upcore Heartbeat: Started (every 60 seconds)`);
  }

  // Report the bot's live state to Layer's status page.
  const layerStatusHeartbeatUrl = process.env.STATUS_HEARTBEAT_URL;
  const layerStatusHeartbeatToken = process.env.STATUS_HEARTBEAT_TOKEN;
  if (layerStatusHeartbeatUrl && layerStatusHeartbeatToken) {
    const pingLayerStatus = () => {
      const wsPing = Math.round(c.ws.ping);
      const validPing = Number.isFinite(wsPing) && wsPing >= 0 ? wsPing : 0;
      fetch(layerStatusHeartbeatUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${layerStatusHeartbeatToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ping: validPing }),
      }).catch(() => {});
    };
    pingLayerStatus();
    setInterval(pingLayerStatus, 60 * 1000);
    console.log(`   Layer status heartbeat: Started (every 60 seconds)`);
  } else {
    console.warn('   Layer status heartbeat: Not configured');
  }


  // Start giveaway manager
  startGiveawayManager(client);
  console.log(`   Giveaway Manager: Started (checking every 30 seconds)`);

  // Start temporary ban manager
  startTempBanManager(client);

  // Keep configured live server-stat channels current.
  startServerStatsManager(client);

  
  // Calculate time until next 3 AM
  const now = new Date();
  const next3AM = new Date(now);
  next3AM.setHours(3, 0, 0, 0);
  if (next3AM <= now) {
    next3AM.setDate(next3AM.getDate() + 1);
  }
  const msUntil3AM = next3AM.getTime() - now.getTime();

  // Schedule first run at 3 AM, then repeat every 24 hours
  setTimeout(async () => {
    for (const guild of client.guilds.cache.values()) {
      await GhostCleaner.executeScheduledKicks(guild).catch(() => {});
    }
    setInterval(async () => {
      for (const guild of client.guilds.cache.values()) {
        await GhostCleaner.executeScheduledKicks(guild).catch(() => {});
      }
    }, 24 * 60 * 60 * 1000); // Every 24 hours
  }, msUntil3AM);
  
  console.log(`   Ghost Cleaner: Scheduled (next run at 3:00 AM)`);
  
  await deployCommands();
});

client.on(Events.GuildCreate, (guild) => {
  void syncBotGuild(guild).catch((error) => {
    console.error(`[Monitor] Could not record server join (${guild.id}):`, error);
  });
});

client.on(Events.GuildDelete, (guild) => {
  void db.guild.updateMany({
    where: { discordId: guild.id },
    data: { botPresent: false, lastSeenAt: new Date() },
  }).catch((error) => {
    console.error(`[Monitor] Could not record server removal (${guild.id}):`, error);
  });
});

// Any unban, including approved appeals and manual unbans, ends a pending temporary ban,
// so its expiry can never lift a later ban.
client.on(Events.GuildBanRemove, (ban) => {
  void import('./utils/tempBan.js')
    .then(({ removeTempBan }) => removeTempBan(ban.guild.id, ban.user.id))
    .catch((error) => console.error('[TempBan] Could not clear schedule after unban:', error));
  void db.bannedUser.deleteMany({ where: { guildId: ban.guild.id, userId: ban.user.id } })
    .catch((error) => console.error('[BanEvasion] Could not remove unban reference:', error));
});

// Offer the appeal link after manual or automated Discord bans when the server opted in.
client.on(Events.GuildBanAdd, (ban) => {
  void notifyBannedUserAboutAppeal(ban);
  void db.guild.findUnique({
    where: { discordId: ban.guild.id },
    select: { banEvasionEnabled: true },
  }).then(async (settings) => {
    if (!settings?.banEvasionEnabled) return;
    const { BanEvasionDetector } = await import('./utils/banEvasionDetector.js');
    await BanEvasionDetector.storeBannedUser(
      ban.user.id,
      ban.guild.id,
      ban.user.username,
      'unknown',
      'Moderator',
      ban.reason || undefined,
    );
  }).catch((error) => console.error('[BanEvasion] Could not store ban reference:', error));
});

// ─── Welcome/Leave System ────────────────────────────────────────────────────

import { handleMemberJoin, handleMemberLeave } from './events/welcomeHandler.js';

client.on(Events.GuildMemberAdd, async (member) => {
  // Anti-Raid Shield: process join spikes immediately
  const { handleAntiRaidJoin } = await import('./utils/antiRaid.js');
  await handleAntiRaidJoin(member).catch((err) =>
    console.error('[Anti-Raid] Error handling join:', err)
  );

  await handleMemberJoin(member);

  // Sticky Punishment: re-apply any pending punishment
  const { handleRejoinWithPunishment } = await import('./utils/stickyPunishment.js');
  await handleRejoinWithPunishment(member).catch((err) =>
    console.error('[StickyPunishment] Error on rejoin:', err)
  );

  // Impersonation Detection for new members
  const { handleNewMember } = await import('./events/impersonationHandler.js');
  await handleNewMember(member);
});

client.on(Events.GuildMemberRemove, async (member) => {
  await handleMemberLeave(member as any);

  // Handle open tickets if creator leaves
  const { handleTicketCreatorLeave } = await import('./events/ticketHandler.js');
  await handleTicketCreatorLeave(member as any).catch((err) =>
    console.error('[Ticket Creator Leave Error]', err)
  );

  // Sticky Punishment: save active punishment if they leave mid-timeout
  if (member.guild) {
    const { handleLeaveWithPunishment } = await import('./utils/stickyPunishment.js');
    await handleLeaveWithPunishment(member as any).catch((err) =>
      console.error('[StickyPunishment] Error on leave:', err)
    );
  }
});

// ─── Avatar Tracking ─────────────────────────────────────────────────────────

client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  const { handleAvatarChange } = await import('./events/avatarTrackingHandler.js');
  await handleAvatarChange(oldMember as any, newMember as any);
});

// ─── Poll Reactions ──────────────────────────────────────────────────────────

client.on(Events.MessageReactionAdd, async (reaction, user) => {
  const { handlePollReactionAdd } = await import('./events/pollHandler.js');
  await handlePollReactionAdd(reaction, user);
});

client.on(Events.MessageReactionRemove, async (reaction, user) => {
  const { handlePollReactionRemove } = await import('./events/pollHandler.js');
  await handlePollReactionRemove(reaction, user);
});

// ─── Slash command handling ──────────────────────────────────────────────────

client.on(Events.InteractionCreate, async (interaction) => {
  // Slash commands
  if (interaction.isChatInputCommand()) {
    const command = commands.get(interaction.commandName);
    if (!command) return;

    // Servers can override a command's default permissions in Integrations settings,
    // so enforce the permissions each command is registered with at execution time.
    const requiredPermissions = (command.data.toJSON() as { default_member_permissions?: string | null }).default_member_permissions;
    if (requiredPermissions && interaction.inGuild() && !interaction.memberPermissions?.has(BigInt(requiredPermissions))) {
      await interaction.reply({ content: '❌ You do not have permission to use this command.', ephemeral: true }).catch(() => {});
      return;
    }
    
    // Check cooldown
    const cooldownConfig = getCooldownForCommand(interaction.commandName);
    const cooldownCheck = checkCooldown(interaction.user.id, interaction.commandName, cooldownConfig);
    
    if (!cooldownCheck.allowed) {
      await interaction.reply({
        content: `⏰ Please wait ${cooldownCheck.remainingSeconds} seconds before using this command again.`,
        ephemeral: true,
      }).catch(() => {});
      return;
    }
    
    try {
      await command.execute(interaction);
      
      // Log command execution
      if (interaction.guildId) {
        const { db } = await import('./db.js');
        await db.auditLog.create({
          data: {
            guildId: interaction.guildId,
            action: 'COMMAND_EXECUTED',
            userId: interaction.user.id,
            userName: interaction.user.tag,
            details: `/${interaction.commandName}`,
            metadata: {
              commandName: interaction.commandName,
              channelId: interaction.channelId,
            },
          },
        }).catch(() => {}); // Silent fail
      }
    } catch (err) {
      console.error(`Error in /${interaction.commandName}:`, err);
      const errMsg = { content: '❌ Ein Fehler ist aufgetreten.', ephemeral: true };
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(errMsg).catch(() => {});
      } else {
        await interaction.reply(errMsg).catch(() => {});
      }
    }
    return;
  }

  // Autocomplete handling
  if (interaction.isAutocomplete()) {
    const command = commands.get(interaction.commandName) as any;
    if (command?.autocomplete) {
      await command.autocomplete(interaction).catch((err: any) => {
        console.error(`Error in autocomplete /${interaction.commandName}:`, err);
      });
    }
    return;
  }

  // Modal submissions
  if (interaction.isModalSubmit()) {
    if (interaction.customId.startsWith('setup_modal_')) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({ content: '❌ Only administrators can run the server setup.', ephemeral: true }).catch(() => {});
        return;
      }
      const { handleSetupModal } = await import('./commands/ai/setup.js');
      await handleSetupModal(interaction as ModalSubmitInteraction);
      return;
    }
    if (interaction.customId === 'verification:captcha') {
      const { handleVerificationModal } = await import('./events/verificationHandler.js');
      await handleVerificationModal(interaction);
      return;
    }
    if (interaction.customId.startsWith('ticket:')) {
      const { handleTicketModal } = await import('./events/ticketHandler.js');
      await handleTicketModal(interaction);
      return;
    }
    return;
  }

  // Setup channel/category picker
  if (interaction.isChannelSelectMenu() && interaction.customId.startsWith('setup_select_')) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: '❌ Only administrators can run the server setup.', ephemeral: true }).catch(() => {});
      return;
    }
    const { handleSetupChannelSelect } = await import('./commands/ai/setup.js');
    await handleSetupChannelSelect(interaction);
    return;
  }

  // Button clicks
  if (interaction.isButton()) {
    if (interaction.customId.startsWith('privacy_erase:')) {
      const { handlePrivacyButton } = await import('./commands/utility/privacy.js');
      await handlePrivacyButton(interaction);
      return;
    }
    if (interaction.customId.startsWith('setup_')) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({ content: '❌ Only administrators can run the server setup.', ephemeral: true }).catch(() => {});
        return;
      }
      const { handleSetupButton } = await import('./commands/ai/setup.js');
      await handleSetupButton(interaction);
      return;
    }
    if (interaction.customId.startsWith('ticket:')) {
      const { handleTicketButton } = await import('./events/ticketHandler.js');
      await handleTicketButton(interaction).catch((err) => {
        console.error('[Ticket Handler Error]', err);
      });
      return;
    }
    if (interaction.customId === 'verification:captcha_open') {
      const { handleCaptchaOpenButton } = await import('./events/verificationHandler.js');
      await handleCaptchaOpenButton(interaction);
      return;
    }
    if (interaction.customId === 'verification:verify') {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ flags: 64 }).catch(() => {});
      }
      const { handleVerificationButton } = await import('./events/verificationHandler.js');
      await handleVerificationButton(interaction);
      return;
    }
    if (interaction.customId === 'giveaway:enter') {
      const { handleGiveawayEnter } = await import('./events/giveawayHandler.js');
      await handleGiveawayEnter(interaction);
      return;
    }
    if (interaction.customId.startsWith('impersonation:')) {
      const { handleImpersonationButton } = await import('./events/impersonationHandler.js');
      await handleImpersonationButton(interaction);
      return;
    }
    if (interaction.customId.startsWith('antiraid:')) {
      const parts = interaction.customId.split(':');
      const action = parts[1];
      const member = await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
      if (!member?.permissions.has(PermissionFlagsBits.ManageGuild) && !member?.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ content: '❌ You need Manage Server permission to use Anti-Raid controls.', ephemeral: true });
      }
      const { liftServerLockdown, cleanRecentRaiders } = await import('./utils/antiRaid.js');
      if (action === 'unlock') {
        const count = await liftServerLockdown(interaction.guild!);
        return interaction.reply({ content: `✅ Server lockdown lifted! Restored send permissions for ${count} channels.`, ephemeral: true });
      } else if (action === 'banrecent') {
        const count = await cleanRecentRaiders(interaction.guild!, 15, 'ban');
        return interaction.reply({ content: `🔨 Banned ${count} raiders who joined in the last 15 minutes.`, ephemeral: true });
      }
      return;
    }
    return;
  }

  // String Select Menu (Dropdown)
  if (interaction.isStringSelectMenu()) {
    if (interaction.customId.startsWith('setup_')) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({ content: '❌ Only administrators can configure server setup.', ephemeral: true }).catch(() => {});
        return;
      }
      const { handleSetupStyleSelect } = await import('./commands/ai/setup.js');
      await handleSetupStyleSelect(interaction);
      return;
    }
    if (interaction.customId.startsWith('ticket:')) {
      const { handleTicketButton } = await import('./events/ticketHandler.js');
      await handleTicketButton(interaction).catch((err) => {
        console.error('[Ticket Handler Error]', err);
      });
      return;
    }
    return;
  }
});

// ─── XP & Auto Moderation ───────────────────────────────────────────────────

const spamTracker = new Map<string, number[]>();

// Cleanup stale spamTracker entries every 60 seconds to prevent memory leak
setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of spamTracker.entries()) {
    if (key.endsWith('-locked')) continue;
    if (ts.length === 0 || now - ts[ts.length - 1] > 60000) {
      spamTracker.delete(key);
    }
  }
}, 60000);

client.on(Events.MessageCreate, async (message) => {
  if (!message.guild) return;

  // Anti-Raid Message Filter (catches unauthorized User Apps, Webhook Spam, and Raid Floods)
  const { handleAntiRaidMessage } = await import('./utils/antiRaid.js');
  const wasRaidBlocked = await handleAntiRaidMessage(message).catch((err) => {
    console.error('[Anti-Raid] Error filtering message:', err);
    return false;
  });
  if (wasRaidBlocked) return;

  if (message.author.bot) return;

  try {
    const { db } = await import('./db.js');
    const guildSettings = await db.guild.findUnique({
      where: { discordId: message.guild.id },
    });

    // AI Ticket Moderator (runs FIRST for ticket channels)
    const chName = 'name' in message.channel ? (message.channel as any).name : '';
    if (chName?.startsWith('ticket-') || message.channel.isThread()) {
      const { handleTicketMessage } = await import('./utils/aiTicketModerator.js');
      await handleTicketMessage(message);
    }

    const isServerOwner = message.guild.ownerId === message.author.id;
    const isServerAdmin = Boolean(
      message.member?.permissions.has(PermissionFlagsBits.Administrator) ||
      message.member?.permissions.has(PermissionFlagsBits.ManageGuild)
    );

    // Auto-Mod Check (runs BEFORE anti-scam) - Always bypass Server Owners and Admins
    if (guildSettings && !isServerOwner && !isServerAdmin) {
      const { checkAutoMod, executeAutoModAction } = await import('./utils/autoMod.js');
      const autoModResult = await checkAutoMod(message, guildSettings as any);
      if (autoModResult) {
        await executeAutoModAction(message, autoModResult, guildSettings as any);
        return; // Stop processing further
      }
    }

    // Anti-Scam Check (runs AFTER auto-mod, independent of moderation module) - Always bypass Server Owners and Admins
    if (guildSettings?.antiScamEnabled && !isServerOwner && !isServerAdmin) {
      console.log(`[Anti-Scam] Checking message from ${message.author.tag} in ${message.guild.name}`);
      
      const scamResult = await detectScam(message, guildSettings.scamSensitivity as 'low' | 'medium' | 'high');
      
      console.log(`[Anti-Scam] Result: isScam=${scamResult.isScam}, confidence=${scamResult.confidence}%, type=${scamResult.type}`);
      
      // Log AI token usage if AI was used
      if (scamResult.tokens && scamResult.tokens > 0) {
        await db.auditLog.create({
          data: {
            guildId: message.guild.id,
            action: 'AI_TOKENS_USED',
            userId: message.author.id,
            userName: message.author.tag,
            details: `Anti-scam image analysis`,
            metadata: { tokens: scamResult.tokens, feature: 'anti-scam' },
          },
        }).catch(() => {}); // Silent fail
        console.log(`[AI Tokens] Logged ${scamResult.tokens} tokens for anti-scam detection`);
      }
      
      // Images that could not be analysed are not treated as clean: moderators get a review notice.
      if (!scamResult.isScam && scamResult.unanalyzedImages && guildSettings.logChannelId) {
        const reviewChannel = message.guild.channels.cache.get(guildSettings.logChannelId);
        if (reviewChannel?.isTextBased()) {
          reviewChannel.send({
            content: `⚠️ Anti-Scam could not check ${scamResult.unanalyzedImages} image(s) in ${message.url} from <@${message.author.id}> (busy, too large or AI unavailable). Please review it manually.`,
            allowedMentions: { parse: [] },
          }).catch(() => {});
        }
      }

      if (scamResult.isScam) {
        console.log(`[Anti-Scam] 🚨 SCAM DETECTED! Deleting message...`);
        await message.delete().catch(() => {});
        
        const { EmbedBuilder } = await import('discord.js');
        const embed = new EmbedBuilder()
          .setColor('#dc2626')
          .setTitle('🚨 Scam Detected & Removed')
          .setDescription(`${message.author}, your message was automatically deleted because it appears to contain scam content.`)
          .addFields(
            { name: 'Detection Type', value: scamResult.type.toUpperCase(), inline: true },
            { name: 'Confidence', value: `${scamResult.confidence}%`, inline: true },
            { name: 'Reason', value: scamResult.reason }
          )
          .setFooter({ text: 'If this was a mistake, please contact a moderator.' })
          .setTimestamp();
          
        const warningMsg = await message.channel.send({ embeds: [embed] });
        
        // Log to audit channel if configured
        if (guildSettings.logChannelId) {
          const logChannel = message.guild.channels.cache.get(guildSettings.logChannelId);
          if (logChannel && logChannel.isTextBased()) {
            const logEmbed = new EmbedBuilder()
              .setColor('#dc2626')
              .setTitle('🚨 Anti-Scam: Message Deleted')
              .addFields(
                { name: 'User', value: `${message.author.tag} (${message.author.id})`, inline: true },
                { name: 'Channel', value: `<#${message.channel.id}>`, inline: true },
                { name: 'Confidence', value: `${scamResult.confidence}%`, inline: true },
                { name: 'Type', value: scamResult.type, inline: true },
                { name: 'Reason', value: scamResult.reason },
                { name: 'Content', value: message.content || '*[Image/Attachment]*' }
              )
              .setTimestamp();
            
            // Generate HTML report with embedded images
            try {
              const { generateScamReport } = await import('./utils/scamReportGenerator.js');
              const htmlReport = await generateScamReport(message, scamResult);
              
              await logChannel.send({ 
                embeds: [logEmbed],
                files: [htmlReport]
              });
            } catch (reportError: any) {
              console.error('[Scam Detector] Failed to generate HTML report:', reportError.message);
              // Fallback: send without report
              logChannel.send({ embeds: [logEmbed] }).catch(() => {});
            }
          }
        }
        
        // Delete warning after 10 seconds
        setTimeout(() => {
          warningMsg.delete().catch(() => {});
        }, 10000);
        
        return; // Stop processing further
      }
    }

    if (guildSettings?.moderationEnabled) {

      // Banned Words Check
      if (guildSettings.bannedWords.length > 0) {
        const contentLower = message.content.toLowerCase();
        const hasBannedWord = guildSettings.bannedWords.some(word => contentLower.includes(word.toLowerCase()));
        
        if (hasBannedWord) {
          await message.delete();
          
          const { EmbedBuilder } = await import('discord.js');
          const embed = new EmbedBuilder()
            .setColor('#ef4444')
            .setDescription(`⚠️ ${message.author}, that word is not allowed here!`);
            
          const warningMsg = await message.channel.send({ embeds: [embed] });
          
          // Delete warning after 5 seconds
          setTimeout(() => {
            warningMsg.delete().catch(() => {});
          }, 5000);
          
          return; // Stop processing further
        }
      }

      // Basic Anti-Spam Check
      if (guildSettings.antiSpamEnabled) {
        const now = Date.now();
        const userSpamKey = `${message.guild.id}-${message.author.id}`;
        const timestamps = spamTracker.get(userSpamKey) || [];
        
        // Keep only timestamps from the last 5 seconds
        const recentTimestamps = timestamps.filter(ts => now - ts < 5000);
        recentTimestamps.push(now);
        spamTracker.set(userSpamKey, recentTimestamps);

        // If more than 4 messages in 5 seconds -> Spam Detected
        if (recentTimestamps.length > 4) {
          await message.delete().catch(() => {});
          
          const lockKey = `${userSpamKey}-locked`;
          if (!spamTracker.has(lockKey)) {
            // Lock to prevent duplicate warnings from parallel events
            spamTracker.set(lockKey, [1]);
            setTimeout(() => spamTracker.delete(lockKey), 5000);
            
            // Clear their tracker so they don't get 10 warnings if they spam 10 times
            spamTracker.set(userSpamKey, []);
            
            const { EmbedBuilder } = await import('discord.js');
            const embed = new EmbedBuilder()
              .setColor('#f97316')
              .setDescription(`⚠️ ${message.author}, you are sending messages too quickly. Please slow down!`);
              
            const warningMsg = await message.channel.send({ embeds: [embed] });
            setTimeout(() => warningMsg.delete().catch(() => {}), 5000);
          }
          
          return; // Stop processing further
        }
      }
    }
    
    // Award 5-15 XP per message if Leveling is enabled (with cooldown to prevent farming)
    if (guildSettings?.levelingEnabled) {
      const xpCooldown = checkCooldown(message.author.id, 'xp-gain', COOLDOWNS.XP_GAIN);
      
      if (xpCooldown.allowed) {
        const baseXp = Math.floor(Math.random() * 11) + 5; // 5-15 XP
        const result = await addXP(
          message.guild.id, 
          message.author.id, 
          message.author.username, 
          baseXp,
          1.0, // Base multiplier
          'message'
        );
        
        if (result?.leveledUp) {
          // Send level up announcement
          if (result.channelId) {
            const channel = message.guild.channels.cache.get(result.channelId);
            if (channel && channel.isTextBased()) {
              const streakText = result.currentStreak > 1 ? ` 🔥 ${result.currentStreak} day streak! (+${result.streakBonus}% XP)` : '';
              channel.send(`🎉 Congratulations ${message.author}! You've reached **Level ${result.newLevel}**!${streakText}`).catch(() => {});
            }
          }
          // Assign role reward, refusing privileged roles configured from the dashboard
          if (result.roleId && message.member) {
            const { getSafeAssignableRole } = await import('./utils/safeRoles.js');
            const role = await getSafeAssignableRole(message.guild, result.roleId);
            if (role) {
              message.member.roles.add(role).catch(() => {});
            }
          }
        }

        // Announce new achievements
        if (result?.newAchievements && result.newAchievements.length > 0) {
          const achievementMessages = result.newAchievements.map(id => {
            const achievement = Object.values(ACHIEVEMENTS).find((a: any) => a.id === id);
            return achievement ? `${achievement.name} — *${achievement.description}*` : null;
          }).filter(Boolean);

          if (achievementMessages.length > 0 && result.channelId) {
            const channel = message.guild.channels.cache.get(result.channelId);
            if (channel && channel.isTextBased()) {
              channel.send(`🎖️ ${message.author} unlocked new achievement${achievementMessages.length > 1 ? 's' : ''}!\n${achievementMessages.join('\n')}`).catch(() => {});
            }
          }
        }
      }
    }

    // Log message activity (once per day per user to avoid spam)
    const today = new Date().toISOString().split('T')[0];
    const messageKey = `msg:${message.guild.id}:${message.author.id}:${today}`;
    
    const globalAny = global as any;
    if (!globalAny.messageLogCache) {
      globalAny.messageLogCache = new Map<string, number>();
      setInterval(() => {
        const now = Date.now();
        for (const [key, expiresAt] of globalAny.messageLogCache.entries()) {
          if (expiresAt < now) globalAny.messageLogCache.delete(key);
        }
      }, 3600_000).unref();
    }
    if (!globalAny.messageLogCache.has(messageKey)) {
      globalAny.messageLogCache.set(messageKey, Date.now() + 86400_000);
      if (globalAny.messageLogCache.size > 20000) {
        const oldestKey = globalAny.messageLogCache.keys().next().value;
        if (oldestKey) globalAny.messageLogCache.delete(oldestKey);
      }
      
      const loggedChannelName = 'name' in message.channel ? (message.channel as any).name : 'unknown';
      await db.auditLog.create({
        data: {
          guildId: message.guild.id,
          action: 'MESSAGE_SENT',
          userId: message.author.id,
          userName: message.author.tag,
          details: `Message in #${loggedChannelName || 'unknown'}`,
          metadata: {
            channelId: message.channel.id,
            channelName: loggedChannelName,
            hasAttachments: message.attachments.size > 0,
          },
        },
      }).catch(() => {}); // Silent fail
    }
  } catch (error) {
    console.error('Error in message processing (Moderation/DB):', error);
  }
});

// ─── Boot ────────────────────────────────────────────────────────────────────

console.log('⏳ Loading commands...');
await loadCommands();
client.login(process.env.DISCORD_TOKEN);


// ─── API Server for Dashboard Integration ───────────────────────────────────

import express from 'express';
import { bearerMatches, requireApiSecret } from './utils/apiAuth.js';
import { sendVerificationPanelHandler } from './api/send-verification-panel.js';
import { autoLockServerHandler } from './api/auto-lock-server.js';
import {
  createGiveawayHandler,
  endGiveawayHandler,
  rerollGiveawayHandler,
} from './api/giveaway-api.js';

const app = express();
app.use(express.json({ limit: '100kb' }));
// Railway terminates TLS in front of the bot, so the client address comes from one proxy hop.
app.set('trust proxy', 1);
app.use(requireApiSecret);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// On-demand, paginated member lookup for the local Layer Monitor. The API
// server is bound to loopback below, so this endpoint is not exposed publicly.
app.get('/api/guild-members/:guildId', async (req, res) => {
  const monitorSecret = process.env.MONITOR_API_SECRET;
  if (!bearerMatches(req.headers.authorization, monitorSecret)) {
    res.status(401).json({ error: 'Unauthorized.' });
    return;
  }

  const { guildId } = req.params;
  if (!/^\d{17,20}$/.test(guildId)) {
    res.status(400).json({ error: 'Invalid server ID.' });
    return;
  }

  const guild = client.guilds.cache.get(guildId);
  if (!guild) {
    res.status(404).json({ error: 'Layer is not currently in this server.' });
    return;
  }

  const rawAfter = req.query.after;
  const after = typeof rawAfter === 'string' && /^\d{17,20}$/.test(rawAfter) ? rawAfter : undefined;
  const limit = 100;

  try {
    const members = await guild.members.list({ limit, ...(after ? { after } : {}) });
    const items = [...members.values()].map((member) => ({
      id: member.user.id,
      username: member.user.username,
      displayName: member.user.globalName ?? member.displayName,
      avatar: member.user.displayAvatarURL({ extension: 'webp', size: 64 }),
      bot: member.user.bot,
    }));

    res.json({
      members: items,
      nextAfter: items.length === limit ? items[items.length - 1]?.id ?? null : null,
      total: guild.memberCount,
    });
  } catch (error) {
    console.error(`[Monitor] Could not fetch members for guild ${guildId}:`, error);
    res.status(502).json({ error: 'Could not load this server’s members. Check that the Server Members intent is enabled.' });
  }
});

// Send verification panel
app.post('/api/send-verification-panel', (req, res) => {
  sendVerificationPanelHandler(req, res, client);
});

// Auto-lock server
app.post('/api/auto-lock-server', (req, res) => {
  autoLockServerHandler(req, res, client);
});

// Giveaway endpoints
app.post('/api/create-giveaway', (req, res) => {
  createGiveawayHandler(req, res, client);
});

app.post('/api/end-giveaway', (req, res) => {
  endGiveawayHandler(req, res, client);
});

app.post('/api/reroll-giveaway', (req, res) => {
  rerollGiveawayHandler(req, res, client);
});

const PORT = process.env.PORT || process.env.BOT_API_PORT || 3001;
// Railway's public networking needs the service to listen on all interfaces.
// Sensitive routes (including member lookup) enforce bearer authentication.
const server = app.listen(Number(PORT), '0.0.0.0', () => {
  console.log(`   API Server: Running on 0.0.0.0:${PORT}`);
});

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

let isShuttingDown = false;
async function gracefulShutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\n🛑 Received ${signal}, starting graceful shutdown...`);

  server.close(() => {
    console.log('   API server closed');
  });

  try {
    client.destroy();
    console.log('   Discord client destroyed');
  } catch (err) {
    console.error('   Error destroying Discord client:', err);
  }

  try {
    await db.$disconnect();
    console.log('   Database disconnected');
  } catch (err) {
    console.error('   Error disconnecting DB:', err);
  }

  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
