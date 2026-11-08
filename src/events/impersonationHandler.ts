import { GuildMember, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } from 'discord.js';
import { ImpersonationDetector } from '../utils/impersonationDetector.js';
import { checkModerationHierarchy } from '../utils/hierarchy.js';

/**
 * Event Handler: Impersonation Detection
 * Checks new members for staff impersonation attempts
 */
export async function handleNewMember(member: GuildMember) {
  try {
    const { db } = await import('../db.js');
    
    // Check if guild has impersonation detection enabled
    const guildSettings = await db.guild.findUnique({
      where: { discordId: member.guild.id },
    });

    if (!guildSettings?.impersonationEnabled) {
      return;
    }

    console.log(`[Impersonation Detector] Checking ${member.user.tag} in ${member.guild.name}`);

    const results: any = await ImpersonationDetector.checkImpersonation(member);
    if (!results) return;

    const autoAction = (guildSettings.impersonationAutoAction || '').toLowerCase();
    const shouldAutoAct = ['kick', 'ban', 'nickname'].includes(autoAction);

    // If HIGH risk and auto-action enabled, take action immediately
    if (results.riskLevel === 'HIGH' && shouldAutoAct) {
      console.log(`[Impersonation Detector] 🚨 HIGH RISK detected! Taking action...`);

      const action = autoAction.toUpperCase();

      if (action === 'KICK') {
        await member.kick(`Suspected staff impersonation: ${results.reason}`);
      } else if (action === 'BAN') {
        await member.ban({ reason: `Suspected staff impersonation: ${results.reason}` });
      } else if (action === 'NICKNAME') {
        const randomId = Math.random().toString(36).substring(7);
        await member.setNickname(`Impersonator-${randomId}`, 'Suspected staff impersonation');
      }

      // Send alert to log channel
      if (guildSettings.logChannelId) {
        const logChannel = member.guild.channels.cache.get(guildSettings.logChannelId);
        if (logChannel && logChannel.isTextBased()) {
          const { EmbedBuilder } = await import('discord.js');
          
          const embed = new EmbedBuilder()
            .setColor('#dc2626')
            .setTitle('🚨 Impersonation Detected - Auto Action Taken')
            .setDescription(`**${member.user.tag}** was automatically ${action.toLowerCase()}ed for suspected staff impersonation.`)
            .addFields(
              { name: 'Risk Level', value: `🔴 **${results.riskLevel}**`, inline: true },
              { name: 'Similarity', value: `${results.similarity}%`, inline: true },
              { name: 'Action', value: action, inline: true },
              { name: 'Matched Staff', value: results.matchedStaffName || 'N/A', inline: true },
              { name: 'Reason', value: results.reason }
            )
            .setThumbnail(member.user.avatarURL({ size: 512 }) || member.user.defaultAvatarURL)
            .setFooter({ text: `User ID: ${member.user.id}` })
            .setTimestamp();

          logChannel.send({ embeds: [embed] }).catch(() => {});
        }
      }

      return;
    }

    // For MEDIUM/HIGH risk without auto-action, send alert only
    if (results.riskLevel === 'MEDIUM' || results.riskLevel === 'HIGH') {
      console.log(`[Impersonation Detector] ⚠️ ${results.riskLevel} RISK detected, sending alert...`);

      if (guildSettings.logChannelId) {
        const logChannel = member.guild.channels.cache.get(guildSettings.logChannelId);
        if (logChannel && logChannel.isTextBased()) {
          
          const riskColor = results.riskLevel === 'HIGH' ? '#dc2626' : '#f59e0b';
          const riskEmoji = results.riskLevel === 'HIGH' ? '🔴' : '🟠';
          
          const embed = new EmbedBuilder()
            .setColor(riskColor)
            .setTitle(`⚠️ Potential Impersonation Detected`)
            .setDescription(`**${member.user.tag}** joined and may be impersonating a staff member.`)
            .addFields(
              { name: 'Risk Level', value: `${riskEmoji} **${results.riskLevel}**`, inline: true },
              { name: 'Similarity', value: `${results.similarity}%`, inline: true },
              { name: 'User ID', value: member.user.id, inline: true },
              { name: 'Matched Staff', value: results.matchedStaffName || 'N/A', inline: true },
              { name: 'Reason', value: results.reason }
            )
            .setThumbnail(member.user.avatarURL({ size: 512 }) || member.user.defaultAvatarURL)
            .setFooter({ text: `Enable auto-action in dashboard to automatically handle impersonators` })
            .setTimestamp();

          const row = new ActionRowBuilder<ButtonBuilder>()
            .addComponents(
              new ButtonBuilder()
                .setCustomId(`impersonation:kick:${member.user.id}`)
                .setLabel('Kick User')
                .setStyle(ButtonStyle.Danger),
              new ButtonBuilder()
                .setCustomId(`impersonation:ban:${member.user.id}`)
                .setLabel('Ban User')
                .setStyle(ButtonStyle.Danger),
              new ButtonBuilder()
                .setCustomId(`impersonation:ignore:${member.user.id}`)
                .setLabel('Ignore')
                .setStyle(ButtonStyle.Secondary)
            );

          logChannel.send({ embeds: [embed], components: [row] }).catch(() => {});
        }
      }
    }
  } catch (error) {
    console.error('[Impersonation Detector] Error checking new member:', error);
  }
}

/**
 * Handle button clicks for impersonation alerts
 */
export async function handleImpersonationButton(interaction: any) {
  if (!interaction.customId.startsWith('impersonation:')) return;

  const [, action, userId] = interaction.customId.split(':');

  try {
    if (!interaction.guild || !['kick', 'ban', 'ignore'].includes(action)) {
      await interaction.reply({
        content: '❌ This action is not available here.',
        ephemeral: true,
      });
      return;
    }

    const permissions = interaction.memberPermissions;
    const canModerate = action === 'kick'
      ? permissions?.has(PermissionFlagsBits.KickMembers)
      : action === 'ban'
        ? permissions?.has(PermissionFlagsBits.BanMembers)
        : [
            PermissionFlagsBits.KickMembers,
            PermissionFlagsBits.BanMembers,
            PermissionFlagsBits.ManageMessages,
          ].some((permission) => permissions?.has(permission));

    if (!canModerate) {
      const requiredPermission = action === 'kick'
        ? 'Kick Members'
        : action === 'ban'
          ? 'Ban Members'
          : 'moderation permissions';
      await interaction.reply({
        content: `❌ You need ${requiredPermission} permission to use this action.`,
        ephemeral: true,
      });
      return;
    }

    const member = await interaction.guild.members.fetch(userId).catch(() => null);

    if (!member) {
      await interaction.reply({
        content: '❌ User has already left the server.',
        ephemeral: true,
      });
      return;
    }

    if (action === 'kick' || action === 'ban') {
      const hierarchyError = await checkModerationHierarchy(interaction.guild, interaction.user.id, member);
      if (hierarchyError) {
        await interaction.reply({ content: `❌ ${hierarchyError}`, ephemeral: true });
        return;
      }
    }

    if (action === 'kick') {
      await member.kick('Staff impersonation - Manual action by moderator');
      await interaction.reply({
        content: `✅ Kicked ${member.user.tag} for suspected impersonation.`,
        ephemeral: true,
      });
    } else if (action === 'ban') {
      await member.ban({ reason: 'Staff impersonation - Manual action by moderator' });
      await interaction.reply({
        content: `✅ Banned ${member.user.tag} for suspected impersonation.`,
        ephemeral: true,
      });
    } else if (action === 'ignore') {
      await interaction.reply({
        content: `✅ Ignored impersonation alert for ${member.user.tag}.`,
        ephemeral: true,
      });
    }

    // Disable buttons after action
    await interaction.message.edit({ components: [] }).catch(() => {});
  } catch (error) {
    console.error('[Impersonation Button] Error:', error);
    await interaction.reply({
      content: '❌ Failed to perform action. Check bot permissions.',
      ephemeral: true,
    });
  }
}
