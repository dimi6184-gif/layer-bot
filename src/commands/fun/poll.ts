import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
} from 'discord.js';
import { db } from '../../db.js';

export const data = new SlashCommandBuilder()
  .setName('poll')
  .setDescription('Creates a poll.')
  .addStringOption((o) => o.setName('question').setDescription('The poll question.').setRequired(true))
  .addStringOption((o) => o.setName('option1').setDescription('Option 1').setRequired(true))
  .addStringOption((o) => o.setName('option2').setDescription('Option 2').setRequired(true))
  .addStringOption((o) => o.setName('option3').setDescription('Option 3 (optional)'))
  .addStringOption((o) => o.setName('option4').setDescription('Option 4 (optional)'));

const emojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣'];

export async function execute(interaction: ChatInputCommandInteraction) {
  const question = interaction.options.getString('question', true);
  const options = [
    interaction.options.getString('option1', true),
    interaction.options.getString('option2', true),
    interaction.options.getString('option3'),
    interaction.options.getString('option4'),
  ].filter(Boolean) as string[];

  // Fetch guild settings for custom emojis
  const guildSettings = await db.guild.findUnique({
    where: { discordId: interaction.guildId! },
    select: { customPollEmojis: true },
  });

  // Use custom emojis if configured, otherwise use defaults
  const pollEmojis = guildSettings?.customPollEmojis && guildSettings.customPollEmojis.length === 4
    ? guildSettings.customPollEmojis
    : emojis;

  const optionText = options.map((o, i) => `${pollEmojis[i]} ${o}`).join('\n');

  const container = new ContainerBuilder()
    .setAccentColor(0x7c3aed)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## 📊 Poll\n${question}`),
    )
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(optionText));

  await interaction.reply({
    components: [container],
    flags: MessageFlags.IsComponentsV2,
  });

  const msg = await interaction.fetchReply();
  
  // Add reactions
  for (let i = 0; i < options.length; i++) {
    await msg.react(pollEmojis[i]);
  }

  // Save to database
  try {
    await db.poll.create({
      data: {
        guildId: interaction.guildId!,
        channelId: interaction.channelId,
        messageId: msg.id,
        creatorId: interaction.user.id,
        creatorName: interaction.user.tag,
        question,
        options,
        votes: options.map((option) => ({ option, userIds: [] })),
      },
    });
  } catch (error) {
    console.error('[Poll] Failed to save to database:', error);
  }
}
