import { Message, GuildMember, EmbedBuilder } from 'discord.js';
import { db } from '../db.js';

interface AutoModSettings {
  autoModEnabled: boolean;
  
  // Spam Detection
  autoModSpamEnabled: boolean;
  autoModSpamMaxMessages: number;
  autoModSpamTimeframe: number;
  autoModSpamAction: string;
  autoModSpamTimeoutDuration: number;
  
  // Caps Filter
  autoModCapsEnabled: boolean;
  autoModCapsThreshold: number;
  autoModCapsMinLength: number;
  autoModCapsAction: string;
  
  // Link Filter
  autoModLinksEnabled: boolean;
  autoModLinksWhitelist: string[];
  autoModLinksAction: string;
  
  // Discord Invite Filter
  autoModInvitesEnabled: boolean;
  autoModInvitesAction: string;
  
  // Mention Spam
  autoModMentionsEnabled: boolean;
  autoModMentionsMax: number;
  autoModMentionsAction: string;
  
  // Emoji Spam
  autoModEmojisEnabled: boolean;
  autoModEmojisMax: number;
  autoModEmojisAction: string;
  
  // Attachment Filter
  autoModAttachmentsEnabled: boolean;
  autoModAttachmentsAction: string;
  
  // Whitelist
  autoModWhitelistChannels: string[];
  autoModWhitelistRoles: string[];
  
  // Duplicate Messages
  autoModDuplicatesEnabled: boolean;
  autoModDuplicatesTimeframe: number;
  autoModDuplicatesAction: string;
  
  logChannelId: string | null;
}

interface AutoModResult {
  violated: boolean;
  rule: string;
  reason: string;
  action: string;
}

// Track spam and duplicates
const userMessageTracker = new Map<string, { content: string; timestamp: number }[]>();
const userDuplicateTracker = new Map<string, { content: string; timestamp: number }[]>();

/**
 * Main auto-mod handler that checks all rules
 */
export async function checkAutoMod(message: Message, settings: AutoModSettings): Promise<AutoModResult | null> {
  // Don't moderate bots
  if (message.author.bot || !message.guild || !message.member) return null;
  
  // Auto-mod disabled
  if (!settings.autoModEnabled) return null;
  
  // Check whitelist (channels and roles)
  if (settings.autoModWhitelistChannels.includes(message.channel.id)) {
    return null;
  }
  
  const memberRoles = message.member.roles.cache.map(r => r.id);
  if (settings.autoModWhitelistRoles.some(roleId => memberRoles.includes(roleId))) {
    return null;
  }
  
  // Check each rule in order
  
  // 1. Spam Detection
  if (settings.autoModSpamEnabled) {
    const spamResult = checkSpam(message, settings);
    if (spamResult) return spamResult;
  }
  
  // 2. Caps Filter
  if (settings.autoModCapsEnabled) {
    const capsResult = checkCaps(message, settings);
    if (capsResult) return capsResult;
  }
  
  // 3. Link Filter
  if (settings.autoModLinksEnabled) {
    const linksResult = checkLinks(message, settings);
    if (linksResult) return linksResult;
  }
  
  // 4. Discord Invite Filter
  if (settings.autoModInvitesEnabled) {
    const invitesResult = checkInvites(message, settings);
    if (invitesResult) return invitesResult;
  }
  
  // 5. Mention Spam
  if (settings.autoModMentionsEnabled) {
    const mentionsResult = checkMentions(message, settings);
    if (mentionsResult) return mentionsResult;
  }
  
  // 6. Emoji Spam
  if (settings.autoModEmojisEnabled) {
    const emojisResult = checkEmojis(message, settings);
    if (emojisResult) return emojisResult;
  }
  
  // 7. Attachment Filter
  if (settings.autoModAttachmentsEnabled) {
    const attachmentsResult = checkAttachments(message, settings);
    if (attachmentsResult) return attachmentsResult;
  }
  
  // 8. Duplicate Messages
  if (settings.autoModDuplicatesEnabled) {
    const duplicatesResult = checkDuplicates(message, settings);
    if (duplicatesResult) return duplicatesResult;
  }
  
  return null;
}

/**
 * Execute the auto-mod action (delete, warn, timeout, kick, ban)
 */
export async function executeAutoModAction(
  message: Message,
  result: AutoModResult,
  settings: AutoModSettings
): Promise<void> {
  try {
    // Always delete the message first
    await message.delete().catch(() => {});
    
    const member = message.member;
    if (!member) return;
    
    // Send warning message
    const embed = new EmbedBuilder()
      .setColor('#ef4444')
      .setTitle('⚠️ Auto-Mod Violation')
      .setDescription(`${message.author}, your message violated the **${result.rule}** rule.`)
      .addFields(
        { name: 'Reason', value: result.reason },
        { name: 'Action', value: result.action.toUpperCase() }
      )
      .setFooter({ text: 'Please follow the server rules.' })
      .setTimestamp();
    
    const warningMsg = await (message.channel as any).send({ embeds: [embed] });
    
    // Delete warning after 8 seconds
    setTimeout(() => {
      warningMsg.delete().catch(() => {});
    }, 8000);
    
    // Execute additional actions
    switch (result.action) {
      case 'warn':
        // Already sent warning message above
        break;
        
      case 'timeout':
        await member.timeout(
          settings.autoModSpamTimeoutDuration * 1000,
          `Auto-Mod: ${result.rule}`
        ).catch(() => {});
        break;
        
      case 'kick':
        await member.kick(`Auto-Mod: ${result.rule}`).catch(() => {});
        break;
        
      case 'ban':
        await member.ban({ reason: `Auto-Mod: ${result.rule}` }).catch(() => {});
        break;
    }
    
    // Log to audit channel
    if (settings.logChannelId) {
      const logChannel = message.guild?.channels.cache.get(settings.logChannelId);
      if (logChannel && logChannel.isTextBased()) {
        const logEmbed = new EmbedBuilder()
          .setColor('#ef4444')
          .setTitle('🛡️ Auto-Mod: Action Taken')
          .addFields(
            { name: 'User', value: `${message.author.tag} (${message.author.id})`, inline: true },
            { name: 'Channel', value: `<#${message.channel.id}>`, inline: true },
            { name: 'Rule', value: result.rule, inline: true },
            { name: 'Action', value: result.action.toUpperCase(), inline: true },
            { name: 'Reason', value: result.reason },
            { name: 'Content', value: message.content || '*[No text content]*' }
          )
          .setTimestamp();
        logChannel.send({ embeds: [logEmbed] }).catch(() => {});
      }
    }
    
    if (!message.guild) return;
    
    // Log to database
    await db.auditLog.create({
      data: {
        guildId: message.guild.id,
        action: 'AUTO_MOD_ACTION',
        userId: message.author.id,
        userName: message.author.tag,
        details: `Auto-Mod: ${result.rule}`,
        metadata: {
          rule: result.rule,
          action: result.action,
          reason: result.reason,
          channelId: message.channel.id,
        },
      },
    }).catch(() => {});
  } catch (error) {
    console.error('[Auto-Mod] Error executing action:', error);
  }
}

/**
 * Check spam (multiple messages in short time)
 */
function checkSpam(message: Message, settings: AutoModSettings): AutoModResult | null {
  const now = Date.now();
  const userKey = `${message.guild!.id}-${message.author.id}`;
  
  const messages = userMessageTracker.get(userKey) || [];
  
  // Keep only messages within timeframe
  const recentMessages = messages.filter(m => now - m.timestamp < settings.autoModSpamTimeframe * 1000);
  recentMessages.push({ content: message.content, timestamp: now });
  userMessageTracker.set(userKey, recentMessages);
  
  // Check if spam threshold exceeded
  if (recentMessages.length > settings.autoModSpamMaxMessages) {
    // Clear tracker to prevent multiple triggers
    userMessageTracker.set(userKey, []);
    
    return {
      violated: true,
      rule: 'Spam Detection',
      reason: `Sent ${recentMessages.length} messages in ${settings.autoModSpamTimeframe} seconds`,
      action: settings.autoModSpamAction,
    };
  }
  
  return null;
}

/**
 * Check excessive caps
 */
function checkCaps(message: Message, settings: AutoModSettings): AutoModResult | null {
  const content = message.content;
  
  // Ignore short messages
  if (content.length < settings.autoModCapsMinLength) return null;
  
  const letters = content.replace(/[^a-zA-Z]/g, '');
  if (letters.length === 0) return null;
  
  const upperCaseCount = (content.match(/[A-Z]/g) || []).length;
  const capsPercentage = (upperCaseCount / letters.length) * 100;
  
  if (capsPercentage >= settings.autoModCapsThreshold) {
    return {
      violated: true,
      rule: 'Caps Filter',
      reason: `${Math.round(capsPercentage)}% of message is in caps (limit: ${settings.autoModCapsThreshold}%)`,
      action: settings.autoModCapsAction,
    };
  }
  
  return null;
}

/**
 * Check for links (with whitelist)
 */
function checkLinks(message: Message, settings: AutoModSettings): AutoModResult | null {
  const urlRegex = /(https?:\/\/[^\s]+)/gi;
  const urls = message.content.match(urlRegex);
  
  if (!urls || urls.length === 0) return null;
  
  // Check if any URL is not in whitelist
  for (const url of urls) {
    const isWhitelisted = settings.autoModLinksWhitelist.some(domain => url.toLowerCase().includes(domain.toLowerCase()));
    
    if (!isWhitelisted) {
      return {
        violated: true,
        rule: 'Link Filter',
        reason: 'Message contains non-whitelisted links',
        action: settings.autoModLinksAction,
      };
    }
  }
  
  return null;
}

/**
 * Check for Discord invites
 */
function checkInvites(message: Message, settings: AutoModSettings): AutoModResult | null {
  const inviteRegex = /(discord\.(gg|io|me|li)|discordapp\.com\/invite|discord\.com\/invite)\/[a-zA-Z0-9]+/gi;
  
  if (inviteRegex.test(message.content)) {
    return {
      violated: true,
      rule: 'Discord Invite Filter',
      reason: 'Message contains a Discord invite link',
      action: settings.autoModInvitesAction,
    };
  }
  
  return null;
}

/**
 * Check for mention spam
 */
function checkMentions(message: Message, settings: AutoModSettings): AutoModResult | null {
  const mentionCount = message.mentions.users.size + message.mentions.roles.size;
  
  if (mentionCount > settings.autoModMentionsMax) {
    return {
      violated: true,
      rule: 'Mention Spam',
      reason: `Message contains ${mentionCount} mentions (limit: ${settings.autoModMentionsMax})`,
      action: settings.autoModMentionsAction,
    };
  }
  
  return null;
}

/**
 * Check for emoji spam
 */
function checkEmojis(message: Message, settings: AutoModSettings): AutoModResult | null {
  // Count custom emojis <:name:id> and <a:name:id>
  const customEmojiRegex = /<a?:\w+:\d+>/g;
  const customEmojis = message.content.match(customEmojiRegex) || [];
  
  // Count unicode emojis (rough estimate)
  const unicodeEmojiRegex = /[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu;
  const unicodeEmojis = message.content.match(unicodeEmojiRegex) || [];
  
  const totalEmojis = customEmojis.length + unicodeEmojis.length;
  
  if (totalEmojis > settings.autoModEmojisMax) {
    return {
      violated: true,
      rule: 'Emoji Spam',
      reason: `Message contains ${totalEmojis} emojis (limit: ${settings.autoModEmojisMax})`,
      action: settings.autoModEmojisAction,
    };
  }
  
  return null;
}

/**
 * Check for attachments
 */
function checkAttachments(message: Message, settings: AutoModSettings): AutoModResult | null {
  if (message.attachments.size > 0) {
    return {
      violated: true,
      rule: 'Attachment Filter',
      reason: 'Message contains attachments',
      action: settings.autoModAttachmentsAction,
    };
  }
  
  return null;
}

/**
 * Check for duplicate messages
 */
function checkDuplicates(message: Message, settings: AutoModSettings): AutoModResult | null {
  const now = Date.now();
  const userKey = `${message.guild!.id}-${message.author.id}`;
  
  const duplicates = userDuplicateTracker.get(userKey) || [];
  
  // Keep only recent duplicates
  const recentDuplicates = duplicates.filter(d => 
    now - d.timestamp < settings.autoModDuplicatesTimeframe * 1000 &&
    d.content === message.content
  );
  
  // Check if this is a duplicate
  if (recentDuplicates.length > 0) {
    return {
      violated: true,
      rule: 'Duplicate Message',
      reason: 'Same message sent multiple times',
      action: settings.autoModDuplicatesAction,
    };
  }
  
  // Add to tracker
  recentDuplicates.push({ content: message.content, timestamp: now });
  userDuplicateTracker.set(userKey, recentDuplicates);
  
  return null;
}

// Clean up old entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  const maxAge = 60 * 1000; // 1 minute
  
  for (const [key, messages] of userMessageTracker.entries()) {
    const filtered = messages.filter(m => now - m.timestamp < maxAge);
    if (filtered.length === 0) {
      userMessageTracker.delete(key);
    } else {
      userMessageTracker.set(key, filtered);
    }
  }
  
  for (const [key, duplicates] of userDuplicateTracker.entries()) {
    const filtered = duplicates.filter(d => now - d.timestamp < maxAge);
    if (filtered.length === 0) {
      userDuplicateTracker.delete(key);
    } else {
      userDuplicateTracker.set(key, filtered);
    }
  }
}, 5 * 60 * 1000);
