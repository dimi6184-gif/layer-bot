// apps/bot/src/commands/moderation/avatarhistory.ts
import { 
  SlashCommandBuilder, 
  ChatInputCommandInteraction, 
  EmbedBuilder, 
  PermissionFlagsBits,
  User
} from 'discord.js';
import { AvatarTracker } from '../../utils/avatarTracker';
import { getGuildEmbedColor } from '../../utils/embedColor';

export const data = new SlashCommandBuilder()
  .setName('avatarhistory')
  .setDescription('👤 View avatar change history for a user')
  .addUserOption(option =>
    option
      .setName('user')
      .setDescription('User to check avatar history for')
      .setRequired(true)
  )
  .addIntegerOption(option =>
    option
      .setName('limit')
      .setDescription('Number of avatars to show (default: 10)')
      .setMinValue(1)
      .setMaxValue(20)
      .setRequired(false)
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .setDMPermission(false);

export async function execute(interaction: ChatInputCommandInteraction) {
  try {
    await interaction.deferReply();

    const user = interaction.options.getUser('user', true);
    const limit = interaction.options.getInteger('limit') || 10;

    if (!interaction.guildId) {
      await interaction.editReply('This command can only be used in a server.');
      return;
    }

    // Get avatar history
    const history = await AvatarTracker.getAvatarHistory(
      user.id,
      interaction.guildId,
      limit
    );
    const embedColor = await getGuildEmbedColor(interaction.guildId);

    if (history.length === 0) {
      await interaction.editReply({
        content: `No avatar history found for ${user.username}. Avatar tracking may not be enabled or user hasn't changed their avatar.`,
      });
      return;
    }

    // Create embed
    const embed = new EmbedBuilder()
      .setColor(embedColor)
      .setTitle(`👤 Avatar History - ${user.username}`)
      .setDescription(`Showing ${history.length} most recent avatar${history.length !== 1 ? 's' : ''}`)
      .setThumbnail(user.displayAvatarURL({ size: 512 }))
      .setFooter({ text: `User ID: ${user.id}` })
      .setTimestamp();

    // Add fields for each avatar
    history.forEach((entry, index) => {
      const timeAgo = `<t:${Math.floor(entry.detectedAt.getTime() / 1000)}:R>`;
      embed.addFields({
        name: `${index + 1}. ${entry.username}`,
        value: `[View Avatar](${entry.avatarUrl})\nChanged ${timeAgo}`,
        inline: true,
      });
    });

    // Show current avatar separately
    embed.addFields({
      name: '📌 Current Avatar',
      value: `[View Current](${user.displayAvatarURL({ size: 512 })})`,
      inline: false,
    });

    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    console.error('[AvatarHistory Command] Error:', error);
    await interaction.editReply({
      content: 'An error occurred while fetching avatar history.',
    });
  }
}
