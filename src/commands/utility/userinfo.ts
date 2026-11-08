import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { infoCV2 } from '../../utils/cv2.js';

export const data = new SlashCommandBuilder()
  .setName('userinfo')
  .setDescription('Shows information about a user.')
  .addUserOption((o) => o.setName('user').setDescription('User (empty = yourself).'));

export async function execute(interaction: ChatInputCommandInteraction) {
  const target = interaction.options.getUser('user') ?? interaction.user;
  const member = interaction.guild!.members.cache.get(target.id);

  const roles = member?.roles.cache
    .filter((r) => r.id !== interaction.guild!.id)
    .map((r) => `<@&${r.id}>`)
    .join(' ') || 'None';

  await interaction.reply({
    ...infoCV2({
      title: `👤 ${target.tag}`,
      thumbnail: target.displayAvatarURL({ size: 64 }),
      fields: [
        { label: 'ID', value: `\`${target.id}\`` },
        { label: '📅 Account Created', value: `<t:${Math.floor(target.createdTimestamp / 1000)}:D>` },
        { label: '📥 Joined Server', value: member?.joinedTimestamp ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:D>` : 'Unknown' },
        { label: '🤖 Bot', value: target.bot ? 'Yes' : 'No' },
        { label: '🎭 Roles', value: roles.slice(0, 200) },
      ],
    }),
    ephemeral: true,
  });
}
