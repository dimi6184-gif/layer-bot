import { GuildMember, Events } from 'discord.js';
import { AvatarTracker } from '../utils/avatarTracker.js';
import { getGuildEmbedColor } from '../utils/embedColor.js';

/**
 * Event Handler: Avatar Tracking
 * Automatically tracks when a user changes their avatar
 */
export async function handleAvatarChange(oldMember: GuildMember, newMember: GuildMember) {
  try {
    // Only track if avatar actually changed
    if (oldMember.user.avatarURL() === newMember.user.avatarURL()) {
      return;
    }

    const { db } = await import('../db.js');
    
    // Check if guild has avatar tracking enabled
    const guildSettings = await db.guild.findUnique({
      where: { discordId: newMember.guild.id },
    });

    if (!guildSettings?.avatarTrackingEnabled) {
      return;
    }

    console.log(`[Avatar Tracker] ${newMember.user.tag} changed their avatar in ${newMember.guild.name}`);

    await AvatarTracker.trackAvatarChange(
      newMember.user,
      newMember.guild
    );

    // Log to audit channel if configured
    const logChannelId = guildSettings.avatarLogChannelId || guildSettings.logChannelId;
    if (logChannelId) {
      const logChannel = newMember.guild.channels.cache.get(logChannelId);
      if (logChannel && logChannel.isTextBased()) {
        const { EmbedBuilder } = await import('discord.js');
        
        const embed = new EmbedBuilder()
          .setColor(await getGuildEmbedColor(newMember.guild.id))
          .setTitle('🖼️ Avatar Changed')
          .setDescription(`**${newMember.user.tag}** changed their profile picture.`)
          .addFields(
            { name: 'User', value: `<@${newMember.user.id}>`, inline: true },
            { name: 'User ID', value: newMember.user.id, inline: true }
          )
          .setThumbnail(newMember.user.avatarURL({ size: 512 }) || newMember.user.defaultAvatarURL)
          .setFooter({ text: `Use /avatarhistory to view full history` })
          .setTimestamp();

        logChannel.send({ embeds: [embed] }).catch(() => {});
      }
    }
  } catch (error) {
    console.error('[Avatar Tracker] Error handling avatar change:', error);
  }
}
