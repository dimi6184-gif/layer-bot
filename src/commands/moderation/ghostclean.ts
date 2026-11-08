// apps/bot/src/commands/moderation/ghostclean.ts
import { 
  SlashCommandBuilder, 
  ChatInputCommandInteraction, 
  EmbedBuilder, 
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { GhostCleaner } from '../../utils/ghostCleaner';
import { getGuildEmbedColor } from '../../utils/embedColor';

export const data = new SlashCommandBuilder()
  .setName('ghostclean')
  .setDescription('👻 Manage inactive/ghost members')
  .addSubcommand(subcommand =>
    subcommand
      .setName('scan')
      .setDescription('Scan server for inactive members')
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('list')
      .setDescription('List inactive members')
      .addIntegerOption(option =>
        option
          .setName('limit')
          .setDescription('Number of members to show (default: 20)')
          .setMinValue(1)
          .setMaxValue(100)
          .setRequired(false)
      )
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('kick')
      .setDescription('Schedule inactive members for removal')
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('whitelist')
      .setDescription('Protect a user from ghost cleaning')
      .addUserOption(option =>
        option
          .setName('user')
          .setDescription('User to whitelist')
          .setRequired(true)
      )
      .addStringOption(option =>
        option
          .setName('reason')
          .setDescription('Reason for whitelisting')
          .setRequired(false)
      )
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setDMPermission(false);

export async function execute(interaction: ChatInputCommandInteraction) {
  try {
    const subcommand = interaction.options.getSubcommand();

    if (!interaction.guild) {
      await interaction.reply({
        content: 'This command can only be used in a server.',
        ephemeral: true,
      });
      return;
    }

    switch (subcommand) {
      case 'scan':
        await handleScan(interaction);
        break;
      case 'list':
        await handleList(interaction);
        break;
      case 'kick':
        await handleKick(interaction);
        break;
      case 'whitelist':
        await handleWhitelist(interaction);
        break;
    }
  } catch (error) {
    console.error('[GhostClean Command] Error:', error);
    const replyMethod = interaction.replied || interaction.deferred ? 'editReply' : 'reply';
    await interaction[replyMethod]({
      content: `An error occurred: ${error instanceof Error ? error.message : 'Unknown error'}`,
    });
  }
}

async function handleScan(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();

  const stats = await GhostCleaner.scanServer(interaction.guild!);
  const embedColor = await getGuildEmbedColor(interaction.guild!.id);

  const embed = new EmbedBuilder()
    .setColor(embedColor)
    .setTitle('👻 Ghost Member Scan Complete')
    .setDescription('Server scan finished. Here are the results:')
    .addFields(
      { name: '👥 Total Members', value: stats.totalMembers.toString(), inline: true },
      { name: '💤 Inactive Members', value: stats.inactiveMembers.toString(), inline: true },
      { name: '👻 Ghost Members', value: stats.ghostMembers.toString(), inline: true },
      { name: '🛡️ Whitelisted', value: stats.whitelistedMembers.toString(), inline: true },
      { name: '🚮 Kickable', value: stats.kickableMembers.toString(), inline: true },
      { name: '\u200B', value: '\u200B', inline: true }
    )
    .setFooter({ text: 'Use /ghostclean list to see details' })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

async function handleList(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();

  const limit = interaction.options.getInteger('limit') || 20;
  const ghosts = await GhostCleaner.getGhostMembers(interaction.guild!.id, limit);

  if (ghosts.length === 0) {
    await interaction.editReply({
      content: 'No inactive members found. Run `/ghostclean scan` first.',
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setColor('#FFA500')
    .setTitle('👻 Inactive Members')
    .setDescription(`Showing ${ghosts.length} inactive member${ghosts.length !== 1 ? 's' : ''}`)
    .setTimestamp();

  // Add fields for each ghost
  const chunks = [];
  for (let i = 0; i < ghosts.length; i += 10) {
    const chunk = ghosts.slice(i, i + 10);
    const text = chunk.map(ghost => {
      const status = ghost.isWhitelisted ? '🛡️' : '👻';
      return `${status} <@${ghost.userId}> - ${ghost.inactiveDays} days (${ghost.messageCount} msgs)`;
    }).join('\n');
    
    chunks.push(text);
  }

  chunks.forEach((chunk, index) => {
    embed.addFields({
      name: index === 0 ? 'Members' : '\u200B',
      value: chunk || 'None',
      inline: false,
    });
  });

  embed.addFields({
    name: '📝 Legend',
    value: '👻 = Can be kicked\n🛡️ = Whitelisted (protected)',
    inline: false,
  });

  await interaction.editReply({ embeds: [embed] });
}

async function handleKick(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();

  // Confirmation button
  const row = new ActionRowBuilder<ButtonBuilder>()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('confirm_ghost_kick')
        .setLabel('Confirm Kick')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('🚮'),
      new ButtonBuilder()
        .setCustomId('cancel_ghost_kick')
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary)
    );

  const ghosts = await GhostCleaner.getGhostMembers(interaction.guild!.id);
  const kickable = ghosts.filter(g => !g.isWhitelisted);

  const embed = new EmbedBuilder()
    .setColor('#FF0000')
    .setTitle('⚠️ Confirm Ghost Member Removal')
    .setDescription(
      `Are you sure you want to schedule **${kickable.length}** inactive members for removal?\n\n` +
      `They will receive a warning DM (if enabled) and be kicked after the warning period.`
    )
    .addFields(
      { name: '👻 Total Kickable', value: kickable.length.toString(), inline: true },
      { name: '⏰ Action', value: 'Scheduled kick', inline: true }
    )
    .setFooter({ text: 'This action cannot be easily undone!' })
    .setTimestamp();

  const reply = await interaction.editReply({
    embeds: [embed],
    components: [row],
  });

  // Wait for button click
  const filter = (i: any) => {
    return i.user.id === interaction.user.id && 
           (i.customId === 'confirm_ghost_kick' || i.customId === 'cancel_ghost_kick');
  };

  const collector = reply.createMessageComponentCollector({
    filter,
    time: 30000, // 30 seconds
  });

  collector.on('collect', async (i) => {
    if (i.customId === 'confirm_ghost_kick') {
      await i.deferUpdate();
      
      const scheduled = await GhostCleaner.scheduleKicks(interaction.guild!);

      const successEmbed = new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle('✅ Ghost Members Scheduled')
        .setDescription(`Successfully scheduled **${scheduled}** inactive members for removal.`)
        .setTimestamp();

      await interaction.editReply({
        embeds: [successEmbed],
        components: [],
      });
    } else {
      await i.deferUpdate();
      
      const cancelEmbed = new EmbedBuilder()
        .setColor('#808080')
        .setTitle('❌ Cancelled')
        .setDescription('Ghost member removal cancelled.')
        .setTimestamp();

      await interaction.editReply({
        embeds: [cancelEmbed],
        components: [],
      });
    }

    collector.stop();
  });

  collector.on('end', (collected) => {
    if (collected.size === 0) {
      interaction.editReply({
        content: 'Command timed out.',
        embeds: [],
        components: [],
      });
    }
  });
}

async function handleWhitelist(interaction: ChatInputCommandInteraction) {
  const user = interaction.options.getUser('user', true);
  const reason = interaction.options.getString('reason') || 'Manual whitelist';

  await GhostCleaner.whitelistUser(user.id, interaction.guild!.id, reason);

  const embed = new EmbedBuilder()
    .setColor('#00FF00')
    .setTitle('🛡️ User Whitelisted')
    .setDescription(`${user.username} has been protected from ghost cleaning.`)
    .addFields(
      { name: 'User', value: `<@${user.id}>`, inline: true },
      { name: 'Reason', value: reason, inline: true }
    )
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}
