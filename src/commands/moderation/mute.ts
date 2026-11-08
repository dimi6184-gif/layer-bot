import { SlashCommandBuilder, ChatInputCommandInteraction, PermissionFlagsBits } from 'discord.js';
import { warnCV2, dangerCV2 } from '../../utils/cv2.js';
import { savePendingTimeout } from '../../utils/stickyPunishment.js';
import { checkModerationHierarchy } from '../../utils/hierarchy.js';

export const data = new SlashCommandBuilder()
  .setName('mute')
  .setDescription('Temporarily mutes a user (Timeout).')
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addUserOption((o) => o.setName('user').setDescription('User to mute.').setRequired(true))
  .addIntegerOption((o) => o.setName('minutes').setDescription('Duration in minutes (max 40320).').setRequired(true).setMinValue(1).setMaxValue(40320))
  .addStringOption((o) => o.setName('reason').setDescription('Reason for the mute.'));

export async function execute(interaction: ChatInputCommandInteraction) {
  const target = interaction.options.getUser('user', true);
  const minutes = interaction.options.getInteger('minutes', true);
  const reason = interaction.options.getString('reason') ?? 'No reason provided.';

  // Fetch member — cache may be stale after restarts or in large servers
  let member = interaction.guild!.members.cache.get(target.id);
  if (!member) {
    try { member = await interaction.guild!.members.fetch(target.id); } catch {}
  }

  if (!member) return interaction.reply({ ...dangerCV2({ title: '❌ User not found' }), ephemeral: true });
  const hierarchyError = await checkModerationHierarchy(interaction.guild!, interaction.user.id, member);
  if (hierarchyError) return interaction.reply({ ...dangerCV2({ title: '❌ Permission Denied', description: hierarchyError }), ephemeral: true });

  const durationText = minutes >= 60
    ? `${Math.floor(minutes / 60)}h ${minutes % 60}m`
    : `${minutes} minutes`;

  // Try to DM the user before muting
  try {
    await target.send(warnCV2({
      title: '🔇 You have been muted',
      description: `You were muted in **${interaction.guild!.name}**.`,
      fields: [
        { label: 'Duration', value: durationText },
        { label: 'Reason', value: reason },
        { label: 'Moderator', value: interaction.user.tag }
      ]
    }));
  } catch (err) {
    // Ignore if user has DMs disabled
  }

  await member.timeout(minutes * 60 * 1000, reason);

  // Save to sticky punishment system so it re-applies if user leaves + rejoins
  await savePendingTimeout(
    interaction.guild!.id,
    target.id,
    minutes * 60 * 1000,
    reason
  );

  await interaction.reply(warnCV2({
    title: '🔇 User muted',
    thumbnail: target.displayAvatarURL({ size: 64 }),
    fields: [
      { label: 'User', value: `${target.tag} \`${target.id}\`` },
      { label: 'Duration', value: durationText },
      { label: 'Moderator', value: interaction.user.tag },
      { label: 'Reason', value: reason },
    ],
  }));
}
