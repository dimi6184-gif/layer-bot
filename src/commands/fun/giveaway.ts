import { randomInt } from 'node:crypto';
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  ContainerBuilder,
  TextDisplayBuilder,
  SectionBuilder,
  SeparatorBuilder,
  MessageFlags,
} from 'discord.js';
import { db } from '../../db.js';
import { getGuildEmbedColor } from '../../utils/embedColor.js';
import ms from 'ms';

export const data = new SlashCommandBuilder()
  .setName('giveaway')
  .setDescription('Manage giveaways')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((sub) =>
    sub
      .setName('start')
      .setDescription('Start a new giveaway')
      .addStringOption((o) => o.setName('prize').setDescription('What are you giving away?').setRequired(true))
      .addStringOption((o) => o.setName('duration').setDescription('Duration (e.g., 1h, 30m, 1d)').setRequired(true))
      .addIntegerOption((o) => o.setName('winners').setDescription('Number of winners').setRequired(true).setMinValue(1).setMaxValue(20))
      .addStringOption((o) => o.setName('description').setDescription('Optional description'))
      .addRoleOption((o) => o.setName('required_role').setDescription('Required role to enter'))
      .addIntegerOption((o) => o.setName('required_level').setDescription('Minimum level to enter').setMinValue(1))
      .addBooleanOption((o) => o.setName('require_boost').setDescription('Require server boost to enter'))
      .addRoleOption((o) => o.setName('blacklist_role').setDescription('Role that cannot enter'))
  )
  .addSubcommand((sub) =>
    sub
      .setName('end')
      .setDescription('End a giveaway early')
      .addStringOption((o) => o.setName('message_id').setDescription('Message ID of the giveaway').setRequired(true))
  )
  .addSubcommand((sub) =>
    sub
      .setName('reroll')
      .setDescription('Reroll winners')
      .addStringOption((o) => o.setName('message_id').setDescription('Message ID of the giveaway').setRequired(true))
      .addIntegerOption((o) => o.setName('winners').setDescription('Number of winners to reroll').setMinValue(1))
  )
  .addSubcommand((sub) =>
    sub.setName('list').setDescription('List all active giveaways')
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const sub = interaction.options.getSubcommand();

  if (sub === 'start') {
    return handleStart(interaction);
  } else if (sub === 'end') {
    return handleEnd(interaction);
  } else if (sub === 'reroll') {
    return handleReroll(interaction);
  } else if (sub === 'list') {
    return handleList(interaction);
  }
}

async function handleStart(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: 64 });

  const prize = interaction.options.getString('prize', true);
  const durationStr = interaction.options.getString('duration', true);
  const winnerCount = interaction.options.getInteger('winners', true);
  const description = interaction.options.getString('description');
  const requiredRole = interaction.options.getRole('required_role');
  const requiredLevel = interaction.options.getInteger('required_level');
  const requireBoost = interaction.options.getBoolean('require_boost') ?? false;
  const blacklistRole = interaction.options.getRole('blacklist_role');

  // Fetch guild settings for custom emoji
  const guildSettings = await db.guild.findUnique({
    where: { discordId: interaction.guildId! },
    select: { customGiveawayEmoji: true },
  });

  const giveawayEmoji = guildSettings?.customGiveawayEmoji || '🎉';
  const embedColor = await getGuildEmbedColor(interaction.guildId!);

  // Parse duration
  const durationMs = ms(durationStr);
  if (!durationMs || durationMs < 1000) {
    return interaction.editReply('❌ Invalid duration! Use formats like: 1h, 30m, 1d, 2h30m');
  }

  if (durationMs > 30 * 24 * 60 * 60 * 1000) {
    return interaction.editReply('❌ Duration cannot exceed 30 days!');
  }

  const endsAt = new Date(Date.now() + durationMs);
  const endsAtTimestamp = Math.floor(endsAt.getTime() / 1000);

  // Build requirements text
  const requirements: string[] = [];
  if (requiredRole) requirements.push(`• Role: ${requiredRole}`);
  if (requiredLevel) requirements.push(`• Level: ${requiredLevel}+`);
  if (requireBoost) requirements.push(`• Must be a Server Booster`);
  if (blacklistRole) requirements.push(`• Cannot have role: ${blacklistRole}`);

  // Create Components v2 message with Container
  const container = new ContainerBuilder()
    .setAccentColor(embedColor)
    .addTextDisplayComponents(
      (textDisplay) => textDisplay.setContent(`# 🎉 GIVEAWAY\n\n**${prize}**`),
      (textDisplay) => 
        textDisplay.setContent(
          (description ? `${description}\n\n` : '') +
          `**Winners:** ${winnerCount}\n` +
          `**Ends:** <t:${endsAtTimestamp}:R> (<t:${endsAtTimestamp}:f>)\n` +
          `**Hosted by:** ${interaction.user}\n` +
          `**Participants:** 0`
        )
    );

  // Add requirements section if needed
  if (requirements.length > 0) {
    container
      .addSeparatorComponents((separator) => separator.setDivider(true))
      .addTextDisplayComponents((textDisplay) =>
        textDisplay.setContent(`**Requirements:**\n${requirements.join('\n')}`)
      );
  }

  // Add separator before button
  container
    .addSeparatorComponents((separator) => separator.setDivider(false))
    .addSectionComponents((section) =>
      section
        .addTextDisplayComponents((textDisplay) =>
          textDisplay.setContent('Click the button below to enter the giveaway!')
        )
        .setButtonAccessory((button) =>
          button
            .setCustomId('giveaway:enter')
            .setLabel('Enter Giveaway')
            .setEmoji(giveawayEmoji as any)
            .setStyle(ButtonStyle.Success)
        )
    );

  // Add footer
  container.addSeparatorComponents((separator) => separator.setDivider(true)).addTextDisplayComponents((textDisplay) =>
    textDisplay.setContent(
      `*${winnerCount} winner${winnerCount > 1 ? 's' : ''} • Ends ${endsAt.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })} at ${endsAt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}*`
    )
  );

  const message = await (interaction.channel as any)!.send({
    components: [container] as any,
    flags: MessageFlags.IsComponentsV2 as any,
  });

  // Save to database
  await db.giveaway.create({
    data: {
      guildId: interaction.guildId!,
      channelId: interaction.channelId,
      messageId: message.id,
      hostId: interaction.user.id,
      hostName: interaction.user.tag,
      prize,
      description,
      winnerCount,
      requiredRoleIds: requiredRole ? [requiredRole.id] : [],
      requiredLevel,
      requireBoost,
      blacklistedRoleIds: blacklistRole ? [blacklistRole.id] : [],
      duration: Math.floor(durationMs / 1000),
      endsAt,
    },
  });

  await interaction.editReply(`✅ **Giveaway started!** Check ${interaction.channel}`);
}

async function handleEnd(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: 64 });

  const messageId = interaction.options.getString('message_id', true);

  const giveaway = await db.giveaway.findFirst({
    where: {
      guildId: interaction.guildId!,
      messageId,
      ended: false,
    },
  });

  if (!giveaway) {
    return interaction.editReply('❌ Giveaway not found or already ended!');
  }

  await endGiveaway(giveaway.id, interaction.client);
  await interaction.editReply('✅ Giveaway ended!');
}

async function handleReroll(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: 64 });

  const messageId = interaction.options.getString('message_id', true);
  const winnersToReroll = interaction.options.getInteger('winners') ?? 1;

  const giveaway = await db.giveaway.findFirst({
    where: {
      guildId: interaction.guildId!,
      messageId,
      ended: true,
    },
  });

  if (!giveaway) {
    return interaction.editReply('❌ Giveaway not found or not ended yet!');
  }

  if (giveaway.participants.length === 0) {
    return interaction.editReply('❌ No participants to reroll!');
  }

  // Filter out previous winners
  const availableParticipants = giveaway.participants.filter((id) => !giveaway.winnerIds.includes(id));

  if (availableParticipants.length === 0) {
    return interaction.editReply('❌ No more participants available to reroll!');
  }

  // Pick new winners
  const newWinners = pickWinners(availableParticipants, Math.min(winnersToReroll, availableParticipants.length));

  // Fetch winner details
  const winners = await Promise.all(
    newWinners.map(async (id) => {
      try {
        const user = await interaction.client.users.fetch(id);
        return { id: user.id, tag: user.tag, mention: `<@${user.id}>` };
      } catch {
        return null;
      }
    })
  );

  const validWinners = winners.filter((w) => w !== null) as { id: string; tag: string; mention: string }[];

  if (validWinners.length === 0) {
    return interaction.editReply('❌ Could not fetch any valid winners!');
  }

  // Update database
  await db.giveaway.update({
    where: { id: giveaway.id },
    data: {
      winnerIds: [...giveaway.winnerIds, ...validWinners.map((w) => w.id)],
      winnerNames: [...giveaway.winnerNames, ...validWinners.map((w) => w.tag)],
    },
  });

  // Send announcement
  const channel = await interaction.client.channels.fetch(giveaway.channelId);
  if (channel?.isTextBased()) {
    const embedColor = await getGuildEmbedColor(giveaway.guildId);
    const rerollContainer = new ContainerBuilder()
      .setAccentColor(embedColor)
      .addTextDisplayComponents(
        (textDisplay) => textDisplay.setContent(`# 🎉 Giveaway Rerolled!\n\n**${giveaway.prize}**`),
        (textDisplay) =>
          textDisplay.setContent(
            `**New Winner${validWinners.length > 1 ? 's' : ''}:** ${validWinners.map((w) => w.mention).join(', ')}\n\n` +
              `Congratulations! 🎊`
          )
      );

    await (channel as any).send({
      components: [rerollContainer] as any,
      flags: MessageFlags.IsComponentsV2 as any,
    });
  }

  await interaction.editReply(`✅ Rerolled ${validWinners.length} new winner(s)!`);
}

async function handleList(interaction: ChatInputCommandInteraction) {
  const giveaways = await db.giveaway.findMany({
    where: {
      guildId: interaction.guildId!,
      ended: false,
    },
    orderBy: { endsAt: 'asc' },
  });

  if (giveaways.length === 0) {
    return interaction.reply({
      content: '📭 No active giveaways!',
      flags: 64,
    });
  }

  const embed = new EmbedBuilder()
    .setColor(await getGuildEmbedColor(interaction.guildId!))
    .setTitle('🎁 Active Giveaways')
    .setDescription(
      giveaways
        .map(
          (g, i) =>
            `**${i + 1}.** ${g.prize}\n` +
            `└ Ends: <t:${Math.floor(g.endsAt.getTime() / 1000)}:R> | Winners: ${g.winnerCount} | [Jump](https://discord.com/channels/${g.guildId}/${g.channelId}/${g.messageId})`
        )
        .join('\n\n')
    )
    .setFooter({ text: `${giveaways.length} active giveaway${giveaways.length > 1 ? 's' : ''}` });

  await interaction.reply({ embeds: [embed], flags: 64 });
}

// Helper: Pick random winners
function pickWinners(participants: string[], count: number): string[] {
  // Unbiased Fisher-Yates shuffle with a cryptographic random source
  const shuffled = [...new Set(participants)];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, count);
}

// Helper: End giveaway and pick winners
export async function endGiveaway(giveawayId: string, client: any) {
  const giveaway = await db.giveaway.findUnique({ where: { id: giveawayId } });
  if (!giveaway || giveaway.ended) return;

  const participants = giveaway.participants;

  if (participants.length === 0) {
    // No participants
    await db.giveaway.update({
      where: { id: giveawayId },
      data: { ended: true },
    });

    const channel = await client.channels.fetch(giveaway.channelId);
    if (channel?.isTextBased()) {
      const message = await channel.messages.fetch(giveaway.messageId!);

      // Use embed instead of Components v2 for editing
      const endedEmbed = new EmbedBuilder()
        .setColor('#ed4245')
        .setTitle('🎉 GIVEAWAY ENDED')
        .setDescription(`**${giveaway.prize}**\n\n❌ **No valid entries were received.**`)
        .setFooter({ text: `Hosted by ${giveaway.hostName} • Ended` })
        .setTimestamp();

      await message.edit({
        embeds: [endedEmbed],
        components: [],
      });
    }
    return;
  }

  // Pick winners
  const winnerIds = pickWinners(participants, Math.min(giveaway.winnerCount, participants.length));

  // Fetch winner details
  const winners = await Promise.all(
    winnerIds.map(async (id) => {
      try {
        const user = await client.users.fetch(id);
        return { id: user.id, tag: user.tag, mention: `<@${user.id}>` };
      } catch {
        return null;
      }
    })
  );

  const validWinners = winners.filter((w) => w !== null) as { id: string; tag: string; mention: string }[];

  // Update database
  await db.giveaway.update({
    where: { id: giveawayId },
    data: {
      ended: true,
      winnerIds: validWinners.map((w) => w.id),
      winnerNames: validWinners.map((w) => w.tag),
    },
  });

  // Update message - use embed instead of Components v2
  const channel = await client.channels.fetch(giveaway.channelId);
  if (channel?.isTextBased()) {
    const message = await channel.messages.fetch(giveaway.messageId!);

    const endedEmbed = new EmbedBuilder()
      .setColor('#57f287')
      .setTitle('🎉 GIVEAWAY ENDED')
      .setDescription(
        `**${giveaway.prize}**\n\n` +
          `**Winner${validWinners.length > 1 ? 's' : ''}:** ${validWinners.map((w) => w.mention).join(', ')}\n\n` +
          `**Total Entries:** ${participants.length}`
      )
      .setFooter({ text: `Hosted by ${giveaway.hostName} • Ended` })
      .setTimestamp();

    await message.edit({
      embeds: [endedEmbed],
      components: [],
    });

    // Announce winners with Components v2 (new message)
    const winnerContainer = new ContainerBuilder()
      .setAccentColor(0x57f287)
      .addTextDisplayComponents(
        (textDisplay) => textDisplay.setContent(`# 🎊 Giveaway Ended!\n\n**${giveaway.prize}**`),
        (textDisplay) =>
          textDisplay.setContent(
            `**Winner${validWinners.length > 1 ? 's' : ''}:** ${validWinners.map((w) => w.mention).join(', ')}\n\n` +
              `[Jump to Giveaway](https://discord.com/channels/${giveaway.guildId}/${giveaway.channelId}/${giveaway.messageId})`
          )
      )
      .addSeparatorComponents((separator) => separator.setDivider(false))
      .addTextDisplayComponents((textDisplay) => textDisplay.setContent('*Congratulations! 🎉*'));

    await channel.send({
      components: [winnerContainer],
      flags: MessageFlags.IsComponentsV2,
    });
  }
}
