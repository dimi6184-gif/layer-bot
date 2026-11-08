import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { xpToLevel } from './rank.js';
import { db } from '../../db.js';

export const data = new SlashCommandBuilder()
  .setName('leaderboard')
  .setDescription('Shows the server leaderboard.')
  .addStringOption((o) =>
    o.setName('type')
      .setDescription('Leaderboard type')
      .setRequired(false)
      .addChoices(
        { name: '🏆 Top XP', value: 'xp' },
        { name: '🔥 Top Streaks', value: 'streak' },
        { name: '💬 Top Messages', value: 'messages' }
      )
  );

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

  const leaderboardType = interaction.options.getString('type') || 'xp';
  
  const guild = await db.guild.findUnique({
    where: { discordId: interaction.guild!.id },
    select: { id: true }
  });

  if (!guild) {
    return interaction.reply({ 
      content: '❌ Guild not found.', 
      ephemeral: true 
    });
  }

  let sorted;
  let title;
  let description;

  if (leaderboardType === 'streak') {
    sorted = await db.guildMember.findMany({
      where: { guildId: guild.id },
      orderBy: { currentStreak: 'desc' },
      take: 10,
      include: { user: true },
    });
    title = '🔥 Top Streaks';
    description = 'Users with the longest daily activity streaks';
  } else if (leaderboardType === 'messages') {
    sorted = await db.guildMember.findMany({
      where: { guildId: guild.id },
      orderBy: { totalMessages: 'desc' },
      take: 10,
      include: { user: true },
    });
    title = '💬 Top Messagers';
    description = 'Users with the most messages sent';
  } else {
    // Default: XP leaderboard
    sorted = await db.guildMember.findMany({
      where: { guildId: guild.id },
      orderBy: { xp: 'desc' },
      take: 10,
      include: { user: true },
    });
    title = '🏆 Server Leaderboard';
    description = 'Top users by total XP';
  }

  if (sorted.length === 0) {
    const embed = new EmbedBuilder()
      .setColor(0x8b5cf6)
      .setTitle(title)
      .setDescription('No activity data yet. Start chatting to earn XP!');
    
    return interaction.reply({ embeds: [embed] });
  }

  const medals = ['🥇', '🥈', '🥉'];
  const lines = sorted.map((entry, i) => {
    const medal = medals[i] ?? `**${i + 1}.**`;
    const username = entry.user.username;
    
    if (leaderboardType === 'streak') {
      const streakBonus = Math.min(50, (entry.currentStreak - 1) * 5);
      return `${medal} **${username}** — ${entry.currentStreak} days (+${streakBonus}% XP)`;
    } else if (leaderboardType === 'messages') {
      const level = xpToLevel(entry.xp);
      return `${medal} **${username}** — ${entry.totalMessages.toLocaleString()} messages (Level ${level})`;
    } else {
      const level = xpToLevel(entry.xp);
      return `${medal} **${username}** — Level ${level} (${entry.xp.toLocaleString()} XP)`;
    }
  });

  // Get user's rank if not in top 10
  const userId = interaction.user.id;
  const user = await db.user.findUnique({
    where: { discordId: userId },
    select: { id: true }
  });

  let userRankText = '';
  if (user) {
    const allMembers = await db.guildMember.findMany({
      where: { guildId: guild.id },
      orderBy: leaderboardType === 'streak' ? { currentStreak: 'desc' } : 
               leaderboardType === 'messages' ? { totalMessages: 'desc' } : 
               { xp: 'desc' },
      select: { userId: true }
    });
    
    const userRank = allMembers.findIndex(m => m.userId === user.id) + 1;
    
    if (userRank > 10) {
      const userMember = await db.guildMember.findUnique({
        where: { userId_guildId: { userId: user.id, guildId: guild.id } },
      });
      
      if (userMember) {
        if (leaderboardType === 'streak') {
          userRankText = `\n\n**Your Rank:** #${userRank} — ${userMember.currentStreak} days streak`;
        } else if (leaderboardType === 'messages') {
          userRankText = `\n\n**Your Rank:** #${userRank} — ${userMember.totalMessages.toLocaleString()} messages`;
        } else {
          const level = xpToLevel(userMember.xp);
          userRankText = `\n\n**Your Rank:** #${userRank} — Level ${level} (${userMember.xp.toLocaleString()} XP)`;
        }
      }
    }
  }

  const embed = new EmbedBuilder()
    .setColor(0x8b5cf6)
    .setTitle(title)
    .setDescription(description)
    .addFields({
      name: 'Top 10',
      value: lines.join('\n') + userRankText,
      inline: false
    })
    .setFooter({ text: `Total active members: ${sorted.length}` })
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}

