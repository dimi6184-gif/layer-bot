import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  TextChannel,
} from 'discord.js';
import { db } from '../../db.js';

export const data = new SlashCommandBuilder()
  .setName('verification')
  .setDescription('Manage verification system')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((sub) =>
    sub
      .setName('setup')
      .setDescription('Send verification panel to a channel')
      .addChannelOption((opt) =>
        opt
          .setName('channel')
          .setDescription('Channel to send verification panel')
          .setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub.setName('test').setDescription('Test verification (verify yourself)')
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === 'setup') {
    await handleSetup(interaction);
  } else if (subcommand === 'test') {
    await handleTest(interaction);
  }
}

async function handleSetup(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const channel = interaction.options.getChannel('channel', true) as TextChannel;

  if (!channel.isTextBased()) {
    await interaction.editReply('❌ Please select a text channel!');
    return;
  }

  // Get guild settings
  const guild = await db.guild.findUnique({
    where: { discordId: interaction.guildId! },
    select: {
      verificationEnabled: true,
      verificationRoleId: true,
      verificationPanelTitle: true,
      verificationPanelDescription: true,
      verificationPanelColor: true,
      verificationButtonLabel: true,
      verificationButtonEmoji: true,
    },
  });

  if (!guild?.verificationEnabled) {
    await interaction.editReply(
      '❌ Verification is not enabled! Please enable it in the dashboard first.'
    );
    return;
  }

  if (!guild.verificationRoleId) {
    await interaction.editReply(
      '❌ No verification role set! Please configure it in the dashboard first.'
    );
    return;
  }

  // Create embed
  const embed = new EmbedBuilder()
    .setTitle(guild.verificationPanelTitle || '🔒 Server Verification')
    .setDescription(
      guild.verificationPanelDescription ||
        'Welcome to the server!\n\nClick the button below to verify yourself and gain access to the server.'
    )
    .setColor(parseInt(guild.verificationPanelColor?.replace('#', '') || '10b981', 16))
    .setTimestamp();

  // Create button
  const button = new ButtonBuilder()
    .setCustomId('verification:verify')
    .setLabel(guild.verificationButtonLabel || 'Verify Me')
    .setEmoji(guild.verificationButtonEmoji || '✅')
    .setStyle(ButtonStyle.Success);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(button);

  // Send panel
  try {
    await channel.send({
      embeds: [embed],
      components: [row],
    });

    // Update channel ID in database
    await db.guild.update({
      where: { discordId: interaction.guildId! },
      data: { verificationChannelId: channel.id },
    });

    await interaction.editReply(
      `✅ Verification panel sent to ${channel}!\n\nUsers can now verify themselves.`
    );

    // Log
    await db.auditLog.create({
      data: {
        guildId: interaction.guildId!,
        action: 'VERIFICATION_PANEL_SENT',
        userId: interaction.user.id,
        userName: interaction.user.tag,
        details: `Verification panel sent to #${channel.name}`,
        metadata: { channelId: channel.id },
      },
    });
  } catch (error) {
    console.error('[Verification] Error sending panel:', error);
    await interaction.editReply('❌ Failed to send verification panel. Check bot permissions!');
  }
}

async function handleTest(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const guild = await db.guild.findUnique({
    where: { discordId: interaction.guildId! },
    select: {
      verificationEnabled: true,
      verificationRoleId: true,
    },
  });

  if (!guild?.verificationEnabled) {
    await interaction.editReply('❌ Verification is not enabled!');
    return;
  }

  if (!guild.verificationRoleId) {
    await interaction.editReply('❌ No verification role configured!');
    return;
  }

  const member = interaction.member as any;
  if (member.roles.cache.has(guild.verificationRoleId)) {
    await interaction.editReply('✅ You are already verified!');
    return;
  }

  try {
    await member.roles.add(guild.verificationRoleId);
    await interaction.editReply('✅ Test successful! You have been verified.');
  } catch (error) {
    console.error('[Verification] Test error:', error);
    await interaction.editReply('❌ Failed to add role. Check bot permissions!');
  }
}
