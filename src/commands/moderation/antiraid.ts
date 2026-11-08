import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
} from 'discord.js';
import { db } from '../../db.js';
import {
  isRaidActive,
  activateRaid,
  clearRaid,
  executeServerLockdown,
  liftServerLockdown,
  cleanRecentRaiders,
} from '../../utils/antiRaid.js';

export const data = new SlashCommandBuilder()
  .setName('antiraid')
  .setDescription('🛡️ Anti-Raid protection and emergency lockdown controls.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((sub) =>
    sub
      .setName('status')
      .setDescription('Check the current Anti-Raid shield and lockdown status.')
  )
  .addSubcommand((sub) =>
    sub
      .setName('lockdown')
      .setDescription('Lock down all text channels to prevent raid messages, or lift it.')
      .addBooleanOption((opt) =>
        opt
          .setName('active')
          .setDescription('True to lock down server, False to lift lockdown')
          .setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName('panic')
      .setDescription('🚨 Trigger immediate emergency panic mode (lockdown + ban recent raiders).')
  )
  .addSubcommand((sub) =>
    sub
      .setName('clean')
      .setDescription('Bulk purge members who joined during the raid window.')
      .addIntegerOption((opt) =>
        opt
          .setName('minutes')
          .setDescription('How many minutes back to target (default: 15)')
          .setMinValue(1)
          .setMaxValue(60)
          .setRequired(false)
      )
      .addStringOption((opt) =>
        opt
          .setName('action')
          .setDescription('Action to execute on recent joins (default: ban)')
          .addChoices(
            { name: 'Ban', value: 'ban' },
            { name: 'Kick', value: 'kick' }
          )
          .setRequired(false)
      )
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const guild = interaction.guild;
  if (!guild) return;

  const member = await guild.members.fetch(interaction.user.id).catch(() => null);
  if (!member?.permissions.has(PermissionFlagsBits.ManageGuild) && !member?.permissions.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply({
      embeds: [new EmbedBuilder().setColor('#ef4444').setDescription('❌ You need the Manage Server permission to use Anti-Raid controls.')],
      ephemeral: true,
    });
  }

  const sub = interaction.options.getSubcommand();

  if (sub === 'status') {
    const settings = await (db.guild.findUnique as any)({
      where: { discordId: guild.id },
      select: {
        antiRaidEnabled: true,
        antiRaidJoinThreshold: true,
        antiRaidJoinTimeframe: true,
        antiRaidAction: true,
        antiRaidMinAccountAgeDays: true,
        antiRaidDefaultAvatarKick: true,
        antiRaidAutoLockdown: true,
        antiRaidBlockUserApps: true,
        antiRaidBlockWebhooks: true,
        antiRaidLockdownActive: true,
      },
    });

    const active = isRaidActive(guild.id);
    const lockdown = !!settings?.antiRaidLockdownActive;

    const embed = new EmbedBuilder()
      .setColor(active || lockdown ? '#ef4444' : '#1FA7BB')
      .setTitle('🛡️ Anti-Raid Shield Status')
      .addFields(
        { name: 'Shield Status', value: settings?.antiRaidEnabled ? '🟢 Enabled' : '🔴 Disabled', inline: true },
        { name: 'Active Raid State', value: active ? '🚨 RAID ACTIVE' : '✅ Clear', inline: true },
        { name: 'Lockdown State', value: lockdown ? '🔒 SERVER LOCKED' : '🔓 Normal', inline: true },
        { name: 'Join Threshold', value: `${settings?.antiRaidJoinThreshold || 5} joins / ${settings?.antiRaidJoinTimeframe || 10}s`, inline: true },
        { name: 'Raid Punishment', value: (settings?.antiRaidAction || 'kick').toUpperCase(), inline: true },
        { name: 'Min Account Age', value: `${settings?.antiRaidMinAccountAgeDays || 3} days`, inline: true },
        { name: 'User Apps Blocked', value: settings?.antiRaidBlockUserApps ? '✅ Yes' : '❌ No', inline: true },
        { name: 'Webhooks Blocked', value: settings?.antiRaidBlockWebhooks ? '✅ Yes' : '❌ No', inline: true },
        { name: 'Auto-Lockdown', value: settings?.antiRaidAutoLockdown ? '✅ Yes' : '❌ No', inline: true }
      )
      .setFooter({ text: 'Layer Anti-Raid System' })
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  }

  if (sub === 'lockdown') {
    const active = interaction.options.getBoolean('active', true);
    await interaction.deferReply();

    if (active) {
      const count = await executeServerLockdown(guild, `Manual lockdown by ${interaction.user.tag}`);
      await db.guild.update({
        where: { discordId: guild.id },
        data: { antiRaidLockdownActive: true },
      }).catch(() => {});
      activateRaid(guild.id, 30);

      const embed = new EmbedBuilder()
        .setColor('#ef4444')
        .setTitle('🔒 Server Lockdown Activated')
        .setDescription(`Successfully locked **${count}** text channels.\nMembers without staff permissions can no longer send messages.`)
        .setFooter({ text: `Triggered by ${interaction.user.tag}` })
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    } else {
      const count = await liftServerLockdown(guild);
      clearRaid(guild.id);

      const embed = new EmbedBuilder()
        .setColor('#22c55e')
        .setTitle('🔓 Server Lockdown Lifted')
        .setDescription(`Successfully restored send permissions for **${count}** channels.\nNormal chat activity is now resumed.`)
        .setFooter({ text: `Lifted by ${interaction.user.tag}` })
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }
  }

  if (sub === 'panic') {
    await interaction.deferReply();

    // 1. Activate lockdown
    const lockedCount = await executeServerLockdown(guild, `PANIC triggered by ${interaction.user.tag}`);
    await db.guild.update({
      where: { discordId: guild.id },
      data: { antiRaidLockdownActive: true },
    }).catch(() => {});
    activateRaid(guild.id, 60);

    // 2. Ban raiders from last 15 minutes
    const bannedCount = await cleanRecentRaiders(guild, 15, 'ban');

    const embed = new EmbedBuilder()
      .setColor('#ef4444')
      .setTitle('🚨 EMERGENCY PANIC MODE ACTIVATED')
      .setDescription(
        `Emergency protocol executed:\n\n` +
        `• **Channels Locked:** ${lockedCount}\n` +
        `• **Recent Raiders Banned:** ${bannedCount}\n` +
        `• **Raid Shield State:** High alert (60 minutes)\n\n` +
        `When ready to restore access, run \`/antiraid lockdown active:false\`.`
      )
      .setFooter({ text: `Executed by ${interaction.user.tag}` })
      .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
  }

  if (sub === 'clean') {
    const minutes = interaction.options.getInteger('minutes') || 15;
    const action = (interaction.options.getString('action') || 'ban') as 'kick' | 'ban';

    await interaction.deferReply();
    const count = await cleanRecentRaiders(guild, minutes, action);

    const embed = new EmbedBuilder()
      .setColor('#1FA7BB')
      .setTitle('🧹 Raid Cleanup Complete')
      .setDescription(
        `Action **${action.toUpperCase()}** executed on **${count}** member(s) who joined in the last **${minutes}** minutes.`
      )
      .setFooter({ text: `Requested by ${interaction.user.tag}` })
      .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
  }
}
