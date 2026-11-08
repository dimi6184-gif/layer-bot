import { SlashCommandBuilder, ChatInputCommandInteraction, PermissionFlagsBits } from 'discord.js';
import { successCV2, dangerCV2 } from '../../utils/cv2.js';

export const data = new SlashCommandBuilder()
  .setName('clear')
  .setDescription('Deletes messages in the current channel.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .addIntegerOption((o) =>
    o.setName('amount').setDescription('Amount of messages (1-100).').setRequired(true).setMinValue(1).setMaxValue(100),
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const amount = interaction.options.getInteger('amount', true);
  const channel = interaction.channel;

  if (!channel || !channel.isTextBased() || channel.isDMBased()) {
    return interaction.reply({ ...dangerCV2({ title: '❌ Only possible in server channels' }), ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });
  const deleted = await (channel as any).bulkDelete(amount, true);

  await interaction.editReply(successCV2({
    title: '🗑️ Messages deleted',
    fields: [
      { label: 'Deleted', value: `${deleted.size} messages` },
      { label: 'Channel', value: `<#${channel.id}>` },
      { label: 'Moderator', value: interaction.user.tag },
    ],
  }));
}
