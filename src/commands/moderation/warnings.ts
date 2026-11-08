import { SlashCommandBuilder, ChatInputCommandInteraction, PermissionFlagsBits } from 'discord.js';
import { infoCV2 } from '../../utils/cv2.js';
import { db } from '../../db.js';

export const data = new SlashCommandBuilder()
  .setName('warnings')
  .setDescription('Shows warnings of a user.')
  .addUserOption((o) => o.setName('user').setDescription('User whose warnings you want to see.').setRequired(true));

export async function execute(interaction: ChatInputCommandInteraction) {
  const target = interaction.options.getUser('user', true);
  const guildId = interaction.guild!.id;

  // Members may read their own warnings; reading someone else's needs moderator rights.
  if (target.id !== interaction.user.id && !interaction.memberPermissions?.has(PermissionFlagsBits.ModerateMembers)) {
    await interaction.reply({ content: '❌ You can only view your own warnings.', ephemeral: true });
    return;
  }

  // Read from DB — persistent across restarts
  const warns = await db.auditLog.findMany({
    where: { guildId, userId: target.id, action: 'WARN' },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });

  const warnsText = warns.length === 0
    ? '✅ No warnings.'
    : warns.map((w, i) => {
        const meta = w.metadata as any;
        const mod = meta?.moderatorTag ?? 'Unknown';
        const date = w.createdAt.toLocaleDateString('en-US');
        return `**${i + 1}.** ${w.details}\n-# by ${mod} • ${date}`;
      }).join('\n\n');

  await interaction.reply({
    ...infoCV2({
      title: `📋 Warnings — ${target.tag}`,
      thumbnail: target.displayAvatarURL({ size: 64 }),
      fields: [
        { label: 'Total', value: `${warns.length} Warning${warns.length !== 1 ? 's' : ''}` },
        { label: 'Log', value: warnsText },
      ],
    }),
    ephemeral: true,
  });
}
