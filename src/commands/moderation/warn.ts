import { SlashCommandBuilder, ChatInputCommandInteraction, PermissionFlagsBits } from 'discord.js';
import { warnCV2 } from '../../utils/cv2.js';
import { db } from '../../db.js';

export const data = new SlashCommandBuilder()
  .setName('warn')
  .setDescription('Warns a user and logs it.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addUserOption((o) => o.setName('user').setDescription('User to warn.').setRequired(true))
  .addStringOption((o) => o.setName('reason').setDescription('Reason for the warning.').setRequired(true));

export async function execute(interaction: ChatInputCommandInteraction) {
  const target = interaction.options.getUser('user', true);
  const reason = interaction.options.getString('reason', true);
  const guildId = interaction.guild!.id;

  // Persist warning to DB (survives bot restarts)
  await db.auditLog.create({
    data: {
      guildId,
      action: 'WARN',
      userId: target.id,
      userName: target.tag,
      details: reason,
      metadata: {
        moderatorId: interaction.user.id,
        moderatorTag: interaction.user.tag,
      },
    },
  });

  // Count total warnings from DB
  const totalWarnings = await db.auditLog.count({
    where: { guildId, userId: target.id, action: 'WARN' },
  });

  // Try to DM the user
  try {
    await target.send(warnCV2({
      title: '⚠️ You received a warning',
      description: `You were warned in **${interaction.guild!.name}**.`,
      fields: [
        { label: 'Reason', value: reason },
        { label: 'Moderator', value: interaction.user.tag },
        { label: 'Total Warnings', value: `${totalWarnings}` },
      ],
    }));
  } catch {
    // DMs disabled — ignore
  }

  await interaction.reply(warnCV2({
    title: '⚠️ User warned',
    thumbnail: target.displayAvatarURL({ size: 64 }),
    fields: [
      { label: 'User', value: `${target.tag} \`${target.id}\`` },
      { label: 'Total Warnings', value: `${totalWarnings}` },
      { label: 'Moderator', value: interaction.user.tag },
      { label: 'Reason', value: reason },
    ],
  }));
}
