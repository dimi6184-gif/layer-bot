import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { ACHIEVEMENTS } from './rank.js';
import { db } from '../../db.js';

export const data = new SlashCommandBuilder()
  .setName('achievements')
  .setDescription('View all available achievements and your progress.')
  .addUserOption((o) => o.setName('user').setDescription('View another user\'s achievements (optional).'));

export async function execute(interaction: ChatInputCommandInteraction) {
  const guildSettings = await db.guild.findUnique({
    where: { discordId: interaction.guildId! },
  });
  
  if (!guildSettings?.levelingEnabled) {
    return interaction.reply({ 
      content: '❌ The Leveling module is disabled on this server.', 
      ephemeral: true 
    });
  }

  const target = interaction.options.getUser('user') ?? interaction.user;
  
  // Get user's achievements
  const user = await db.user.findUnique({
    where: { discordId: target.id },
    select: { id: true }
  });

  const guild = await db.guild.findUnique({
    where: { discordId: interaction.guild!.id },
    select: { id: true }
  });

  let unlockedAchievements: string[] = [];
  
  if (user && guild) {
    const member = await db.guildMember.findUnique({
      where: { userId_guildId: { userId: user.id, guildId: guild.id } },
    });
    unlockedAchievements = (member?.achievements as string[]) || [];
  }

  // Build achievement list
  const achievementGroups = {
    '🎯 Level Milestones': ['level_10', 'level_25', 'level_50', 'level_100'],
    '🔥 Streak Rewards': ['streak_7', 'streak_30'],
    '💝 Special': ['first_message', 'top_3', 'helpful'],
  };

  const embed = new EmbedBuilder()
    .setColor(0x8b5cf6)
    .setTitle(`🎖️ ${target.username}'s Achievements`)
    .setDescription(`Unlocked: **${unlockedAchievements.length}** / **${Object.keys(ACHIEVEMENTS).length}**`)
    .setThumbnail(target.displayAvatarURL({ size: 128 }));

  for (const [groupName, ids] of Object.entries(achievementGroups)) {
    const lines = ids.map(id => {
      const achievement = Object.values(ACHIEVEMENTS).find((a: any) => a.id === id);
      if (!achievement) return null;
      
      const unlocked = unlockedAchievements.includes(id);
      const status = unlocked ? '✅' : '🔒';
      const display = unlocked 
        ? `${status} **${achievement.name}**\n*${achievement.description}* (+${achievement.xpReward} XP)`
        : `${status} ${achievement.name}\n*${achievement.description}* (+${achievement.xpReward} XP)`;
      
      return display;
    }).filter(Boolean);

    if (lines.length > 0) {
      embed.addFields({
        name: groupName,
        value: lines.join('\n\n'),
        inline: false
      });
    }
  }

  embed.setFooter({ 
    text: `Keep earning XP and maintaining streaks to unlock more achievements!` 
  });

  await interaction.reply({ embeds: [embed] });
}
