import { GuildMember, EmbedBuilder, AttachmentBuilder } from 'discord.js';
import { db } from '../db.js';
import { createCanvas, loadImage } from 'canvas';
import { getSafeAssignableRole } from '../utils/safeRoles.js';
import { fetchPublicImage } from '../utils/safeFetch.js';
import { getCanvasFont, safeCanvasText } from '../utils/canvasFonts.js';

export async function handleMemberJoin(member: GuildMember) {
  try {
    const settings = await db.guild.findUnique({
      where: { discordId: member.guild.id },
      select: {
        welcomeEnabled: true,
        welcomeChannelId: true,
        welcomeMessage: true,
        welcomeEmbedEnabled: true,
        welcomeEmbedTitle: true,
        welcomeEmbedDescription: true,
        welcomeEmbedColor: true,
        welcomeImageEnabled: true,
        welcomeImageConfig: true,
        welcomeDMEnabled: true,
        welcomeDMMessage: true,
        autoRoleIds: true,
      },
    });

    if (!settings?.welcomeEnabled) return;

    const memberCount = member.guild.memberCount;

    // Replace placeholders
    const replacePlaceholders = (text: string) => {
      return text
        .replace(/{user}/g, `<@${member.id}>`)
        .replace(/{username}/g, member.user.username)
        .replace(/{server}/g, member.guild.name)
        .replace(/{memberCount}/g, memberCount.toString());
    };

    // Auto-assign roles
    if (settings.autoRoleIds && settings.autoRoleIds.length > 0) {
      for (const roleId of settings.autoRoleIds) {
        try {
          const role = await getSafeAssignableRole(member.guild, roleId);
          if (!role) continue;
          await member.roles.add(role);
          console.log(`[Welcome] Auto-assigned role ${roleId} to ${member.user.tag}`);
        } catch (error) {
          console.error(`[Welcome] Failed to assign role ${roleId}:`, error);
        }
      }
    }

    // Send welcome message to channel
    if (settings.welcomeChannelId) {
      try {
        const channel = await member.guild.channels.fetch(settings.welcomeChannelId);
        if (!channel?.isTextBased()) return;

        const messageOptions: any = {};

        // Generate welcome image if enabled
        if (settings.welcomeImageEnabled) {
          try {
            const image = await generateWelcomeImage(member, memberCount, settings.welcomeImageConfig as any);
            messageOptions.files = [new AttachmentBuilder(image, { name: 'welcome.png' })];
          } catch (error) {
            console.error('[Welcome] Failed to generate image:', error);
          }
        }

        // Create embed if enabled
        if (settings.welcomeEmbedEnabled) {
          // Safe color parse — fall back to Discord blue on invalid hex
          const rawColor = settings.welcomeEmbedColor?.replace('#', '') || '5865F2';
          const colorInt = parseInt(rawColor, 16);
          const safeColor = isNaN(colorInt) ? 0x5865F2 : colorInt;

          const embed = new EmbedBuilder()
            .setColor(safeColor)
            .setTitle(replacePlaceholders(settings.welcomeEmbedTitle || 'Welcome!'))
            .setDescription(replacePlaceholders(settings.welcomeEmbedDescription || 'A new member has joined.'))
            .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
            .setTimestamp();

          if (settings.welcomeImageEnabled && messageOptions.files) {
            embed.setImage('attachment://welcome.png');
          }

          messageOptions.embeds = [embed];
        }

        // Custom message (without embed)
        if (settings.welcomeMessage && !settings.welcomeEmbedEnabled) {
          messageOptions.content = replacePlaceholders(settings.welcomeMessage);
        }

        await channel.send({ ...messageOptions, allowedMentions: { users: [member.id] } });
        console.log(`[Welcome] Sent welcome message for ${member.user.tag}`);
      } catch (error) {
        console.error('[Welcome] Failed to send welcome message:', error);
      }
    }

    // Send DM if enabled
    if (settings.welcomeDMEnabled && settings.welcomeDMMessage) {
      try {
        await member.send(replacePlaceholders(settings.welcomeDMMessage));
        console.log(`[Welcome] Sent DM to ${member.user.tag}`);
      } catch (error) {
        console.error('[Welcome] Failed to send DM:', error);
      }
    }

    // Audit log
    await db.auditLog.create({
      data: {
        guildId: member.guild.id,
        action: 'MEMBER_JOINED',
        userId: member.id,
        userName: member.user.tag,
        details: `${member.user.tag} joined the server`,
        metadata: { memberCount },
      },
    });
  } catch (error) {
    console.error('[Welcome] Error handling member join:', error);
  }
}

export async function handleMemberLeave(member: GuildMember) {
  try {
    const settings = await db.guild.findUnique({
      where: { discordId: member.guild.id },
      select: {
        leaveEnabled: true,
        leaveChannelId: true,
        leaveMessage: true,
        leaveEmbedEnabled: true,
        leaveEmbedTitle: true,
        leaveEmbedDescription: true,
        leaveEmbedColor: true,
      },
    });

    if (!settings?.leaveEnabled || !settings.leaveChannelId) return;

    const memberCount = member.guild.memberCount;

    // Replace placeholders
    const replacePlaceholders = (text: string) => {
      return text
        .replace(/{user}/g, member.user.tag)
        .replace(/{username}/g, member.user.username)
        .replace(/{server}/g, member.guild.name)
        .replace(/{memberCount}/g, memberCount.toString());
    };

    try {
      const channel = await member.guild.channels.fetch(settings.leaveChannelId);
      if (!channel?.isTextBased()) return;

      const messageOptions: any = {};

      // Create embed if enabled
      if (settings.leaveEmbedEnabled) {
        const embed = new EmbedBuilder()
          .setColor(parseInt(settings.leaveEmbedColor?.replace('#', '') || 'ef4444', 16))
          .setTitle(replacePlaceholders(settings.leaveEmbedTitle))
          .setDescription(replacePlaceholders(settings.leaveEmbedDescription))
          .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
          .setTimestamp();

        messageOptions.embeds = [embed];
      }

      // Custom message (without embed)
      if (settings.leaveMessage && !settings.leaveEmbedEnabled) {
        messageOptions.content = replacePlaceholders(settings.leaveMessage);
      }

      await channel.send({ ...messageOptions, allowedMentions: { users: [member.id] } });
      console.log(`[Leave] Sent leave message for ${member.user.tag}`);
    } catch (error) {
      console.error('[Leave] Failed to send leave message:', error);
    }

    // Audit log
    await db.auditLog.create({
      data: {
        guildId: member.guild.id,
        action: 'MEMBER_LEFT',
        userId: member.id,
        userName: member.user.tag,
        details: `${member.user.tag} left the server`,
        metadata: { memberCount },
      },
    });
  } catch (error) {
    console.error('[Leave] Error handling member leave:', error);
  }
}

interface ImageConfig {
  backgroundType: 'gradient' | 'solid' | 'image';
  backgroundColor: string;
  backgroundImageUrl?: string;
  backgroundImageFit?: 'cover' | 'contain' | 'stretch';
  gradientStart: string;
  gradientEnd: string;
  gradientDirection: 'horizontal' | 'vertical' | 'diagonal';
  avatarSize: number;
  avatarX: number;
  avatarBorderColor: string;
  avatarBorderWidth: number;
  welcomeEnabled?: boolean;
  welcomeText: string;
  welcomeSize: number;
  welcomeColor: string;
  welcomeFont: string;
  welcomeX: number;
  welcomeY: number;
  usernameEnabled?: boolean;
  usernameSize: number;
  usernameColor: string;
  usernameFont: string;
  usernameX: number;
  usernameY: number;
  memberCountEnabled?: boolean;
  memberCountSize: number;
  memberCountColor: string;
  memberCountFont: string;
  memberCountX: number;
  memberCountY: number;
  serverNameEnabled?: boolean;
  serverNameSize: number;
  serverNameColor: string;
  serverNameFont: string;
  serverNameX: number;
  serverNameY: number;
}

const defaultImageConfig: ImageConfig = {
  welcomeEnabled: true,
  usernameEnabled: true,
  memberCountEnabled: true,
  serverNameEnabled: true,
  backgroundType: 'gradient',
  backgroundColor: '#5865F2',
  gradientStart: '#5865F2',
  gradientEnd: '#7289DA',
  gradientDirection: 'diagonal',
  avatarSize: 120,
  avatarX: 80,
  avatarBorderColor: '#FFFFFF',
  avatarBorderWidth: 5,
  welcomeText: 'WELCOME',
  welcomeSize: 48,
  welcomeColor: '#FFFFFF',
  welcomeFont: 'Arial',
  welcomeX: 220,
  welcomeY: 110,
  usernameSize: 36,
  usernameColor: '#FFFFFF',
  usernameFont: 'Arial',
  usernameX: 220,
  usernameY: 160,
  memberCountSize: 24,
  memberCountColor: '#CCCCCC',
  memberCountFont: 'Arial',
  memberCountX: 220,
  memberCountY: 200,
  serverNameSize: 24,
  serverNameColor: '#CCCCCC',
  serverNameFont: 'Arial',
  serverNameX: 220,
  serverNameY: 240,
};

async function generateWelcomeImage(
  member: GuildMember, 
  memberCount: number, 
  customConfig?: any
): Promise<Buffer> {
  // Merge custom config with defaults
  const config: ImageConfig = { ...defaultImageConfig, ...customConfig };

  // Canvas size
  const width = 800;
  const height = 300;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // Draw background
  if (config.backgroundType === 'image' && config.backgroundImageUrl) {
    try {
      // SECURITY: the URL is dashboard-configured. fetchPublicImage checks the resolved
      // address, refuses redirects and bounds the size; loadImage only sees the bytes.
      const bgImage = await loadImage(await fetchPublicImage(config.backgroundImageUrl));
      const fit = config.backgroundImageFit || 'cover';
      
      if (fit === 'stretch') {
        ctx.drawImage(bgImage, 0, 0, width, height);
      } else if (fit === 'contain') {
        const scale = Math.min(width / bgImage.width, height / bgImage.height);
        const scaledWidth = bgImage.width * scale;
        const scaledHeight = bgImage.height * scale;
        const x = (width - scaledWidth) / 2;
        const y = (height - scaledHeight) / 2;
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(bgImage, x, y, scaledWidth, scaledHeight);
      } else {
        const scale = Math.max(width / bgImage.width, height / bgImage.height);
        const scaledWidth = bgImage.width * scale;
        const scaledHeight = bgImage.height * scale;
        const x = (width - scaledWidth) / 2;
        const y = (height - scaledHeight) / 2;
        ctx.drawImage(bgImage, x, y, scaledWidth, scaledHeight);
      }
      
      ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
      ctx.fillRect(0, 0, width, height);
    } catch (error) {
      console.error('[Welcome] Failed to load background image:', error);
      // Fallback to gradient
      const gradient = ctx.createLinearGradient(0, 0, width, height);
      gradient.addColorStop(0, config.gradientStart);
      gradient.addColorStop(1, config.gradientEnd);
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
      ctx.fillRect(0, 0, width, height);
    }
  } else if (config.backgroundType === 'gradient') {
    let gradient;
    if (config.gradientDirection === 'horizontal') {
      gradient = ctx.createLinearGradient(0, 0, width, 0);
    } else if (config.gradientDirection === 'vertical') {
      gradient = ctx.createLinearGradient(0, 0, 0, height);
    } else {
      gradient = ctx.createLinearGradient(0, 0, width, height);
    }
    gradient.addColorStop(0, config.gradientStart);
    gradient.addColorStop(1, config.gradientEnd);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
    ctx.fillRect(0, 0, width, height);
  } else {
    ctx.fillStyle = config.backgroundColor;
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
    ctx.fillRect(0, 0, width, height);
  }

  // Load avatar
  try {
    const avatar = await loadImage(
      member.user.displayAvatarURL({ extension: 'png', size: 256 })
    );

    // Draw circular avatar
    const avatarY = height / 2;

    ctx.save();
    ctx.beginPath();
    ctx.arc(config.avatarX, avatarY, config.avatarSize / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(
      avatar, 
      config.avatarX - config.avatarSize / 2, 
      avatarY - config.avatarSize / 2, 
      config.avatarSize, 
      config.avatarSize
    );
    ctx.restore();

    // Avatar border
    if (config.avatarBorderWidth > 0) {
      ctx.strokeStyle = config.avatarBorderColor;
      ctx.lineWidth = config.avatarBorderWidth;
      ctx.beginPath();
      ctx.arc(config.avatarX, avatarY, config.avatarSize / 2, 0, Math.PI * 2);
      ctx.stroke();
    }
  } catch (error) {
    console.error('[Welcome] Failed to load avatar:', error);
  }

  // Welcome text
  if (config.welcomeEnabled) {
    ctx.fillStyle = config.welcomeColor;
    ctx.font = getCanvasFont(config.welcomeSize, 'bold', config.welcomeFont);
    ctx.textAlign = 'left';
    ctx.fillText(safeCanvasText(config.welcomeText || 'WELCOME', 30), config.welcomeX, config.welcomeY);
  }

  // Username
  if (config.usernameEnabled) {
    ctx.fillStyle = config.usernameColor;
    ctx.font = getCanvasFont(config.usernameSize, 'bold', config.usernameFont);
    const username = member.user.username;
    ctx.fillText(safeCanvasText(username, 20), config.usernameX, config.usernameY);
  }

  // Member count
  if (config.memberCountEnabled) {
    ctx.fillStyle = config.memberCountColor;
    ctx.font = getCanvasFont(config.memberCountSize, 'normal', config.memberCountFont);
    ctx.fillText(safeCanvasText(`You are member #${memberCount}`, 30), config.memberCountX, config.memberCountY);
  }

  // Server name
  if (config.serverNameEnabled) {
    ctx.fillStyle = config.serverNameColor;
    ctx.font = getCanvasFont(config.serverNameSize, 'normal', config.serverNameFont);
    const serverName = member.guild.name;
    ctx.fillText(safeCanvasText(serverName, 32), config.serverNameX, config.serverNameY);
  }

  return canvas.toBuffer('image/png');
}
