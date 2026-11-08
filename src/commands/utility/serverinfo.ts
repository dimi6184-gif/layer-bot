import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { infoCV2 } from '../../utils/cv2.js';

export const data = new SlashCommandBuilder()
  .setName('serverinfo')
  .setDescription('Shows detailed information about this server.');

export async function execute(interaction: ChatInputCommandInteraction) {
  const guild = interaction.guild!;
  await guild.fetch();

  const owner = await guild.fetchOwner();
  const channels = guild.channels.cache;
  const textCount = channels.filter((c) => c.isTextBased() && !c.isThread()).size;
  const voiceCount = channels.filter((c) => c.isVoiceBased()).size;
  const boostLevel = guild.premiumTier;
  const boosts = guild.premiumSubscriptionCount ?? 0;

  await interaction.reply(infoCV2({
    title: `ℹ️ ${guild.name}`,
    thumbnail: guild.iconURL({ size: 64 }) ?? undefined,
    fields: [
      { label: '👑 Owner', value: owner.user.tag },
      { label: '📅 Created', value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:D>` },
      { label: '👥 Members', value: `${guild.memberCount}` },
      { label: '💬 Text Channels', value: `${textCount}` },
      { label: '🔊 Voice Channels', value: `${voiceCount}` },
      { label: '🎭 Roles', value: `${guild.roles.cache.size}` },
      { label: '✨ Boost Level', value: `Level ${boostLevel} (${boosts} Boosts)` },
    ],
  }));
}
