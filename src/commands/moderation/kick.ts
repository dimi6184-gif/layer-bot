import { SlashCommandBuilder, ChatInputCommandInteraction, PermissionFlagsBits } from 'discord.js';
import { dangerCV2 } from '../../utils/cv2.js';
import { checkModerationHierarchy } from '../../utils/hierarchy.js';

export const data = new SlashCommandBuilder()
  .setName('kick')
  .setDescription('Kicks a user from the server.')
  .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
  .addUserOption((o) => o.setName('user').setDescription('The user to kick.').setRequired(true))
  .addStringOption((o) => o.setName('reason').setDescription('Reason for the kick.'));

export async function execute(interaction: ChatInputCommandInteraction) {
  const target = interaction.options.getUser('user', true);
  const reason = interaction.options.getString('reason') ?? 'No reason provided.';
  const member = interaction.guild!.members.cache.get(target.id);

  if (!member) return interaction.reply({ ...dangerCV2({ title: '❌ User not found' }), ephemeral: true });
  const hierarchyError = await checkModerationHierarchy(interaction.guild!, interaction.user.id, member);
  if (hierarchyError) return interaction.reply({ ...dangerCV2({ title: '❌ Permission Denied', description: hierarchyError }), ephemeral: true });
  if (!member.kickable) return interaction.reply({ ...dangerCV2({ title: '❌ Permission Denied', description: 'I cannot kick this user.' }), ephemeral: true });

  // Try to DM the user before kicking
  try {
    await target.send(dangerCV2({
      title: '👢 You have been kicked',
      description: `You were kicked from **${interaction.guild!.name}**. You may rejoin if you have an invite.`,
      fields: [
        { label: 'Reason', value: reason },
        { label: 'Moderator', value: interaction.user.tag }
      ]
    }));
  } catch (err) {
    // Ignore if user has DMs disabled
  }

  await member.kick(reason);

  await interaction.reply(dangerCV2({
    title: '👢 User kicked',
    thumbnail: target.displayAvatarURL({ size: 64 }),
    fields: [
      { label: 'User', value: `${target.tag} \`${target.id}\`` },
      { label: 'Moderator', value: interaction.user.tag },
      { label: 'Reason', value: reason },
    ],
  }));
}
