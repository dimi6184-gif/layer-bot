import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { infoCV2 } from '../../utils/cv2.js';
import { db } from '../../db.js';

// XP Multipliers for different activities
export const XP_MULTIPLIERS = {
  MESSAGE: 1.0,          // Base message XP
  VOICE_MINUTE: 0.5,     // XP per minute in voice
  REACTION_RECEIVED: 0.2, // When someone reacts to your message
  THREAD_CREATE: 2.0,    // Creating a thread
  HELPED_TICKET: 5.0,    // Helping in support tickets
};

// Achievements system
export const ACHIEVEMENTS = {
  FIRST_MESSAGE: { id: 'first_message', name: '👋 First Steps', description: 'Send your first message', xpReward: 10 },
  LEVEL_10: { id: 'level_10', name: '🔟 Decathlon', description: 'Reach level 10', xpReward: 100 },
  LEVEL_25: { id: 'level_25', name: '🎯 Quarter Century', description: 'Reach level 25', xpReward: 250 },
  LEVEL_50: { id: 'level_50', name: '⭐ Half Century', description: 'Reach level 50', xpReward: 500 },
  LEVEL_100: { id: 'level_100', name: '💯 Centurion', description: 'Reach level 100', xpReward: 1000 },
  STREAK_7: { id: 'streak_7', name: '🔥 Week Warrior', description: '7 day activity streak', xpReward: 50 },
  STREAK_30: { id: 'streak_30', name: '📅 Monthly Master', description: '30 day activity streak', xpReward: 300 },
  TOP_3: { id: 'top_3', name: '🥉 Top 3', description: 'Reach top 3 on leaderboard', xpReward: 200 },
  HELPFUL: { id: 'helpful', name: '💝 Helpful Hero', description: 'Help in 10 support tickets', xpReward: 150 },
};

// Streak calculation
function calculateStreak(lastActive: Date | null): { currentStreak: number; isActiveToday: boolean } {
  if (!lastActive) return { currentStreak: 0, isActiveToday: false };
  
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const lastActiveDay = new Date(lastActive.getFullYear(), lastActive.getMonth(), lastActive.getDate());
  
  const daysDiff = Math.floor((today.getTime() - lastActiveDay.getTime()) / (1000 * 60 * 60 * 24));
  
  if (daysDiff === 0) {
    return { currentStreak: 1, isActiveToday: true }; // Active today
  } else if (daysDiff === 1) {
    return { currentStreak: 1, isActiveToday: false }; // Was active yesterday
  } else {
    return { currentStreak: 0, isActiveToday: false }; // Streak broken
  }
}

// XP with multipliers and streak bonus
export async function addXP(
  guildId: string, 
  userId: string, 
  username: string, 
  baseAmount: number,
  multiplier: number = 1.0,
  source: string = 'message'
) {
  // First, ensure the user exists in the User table and get their internal ID
  const user = await db.user.upsert({
    where: { discordId: userId },
    update: { username }, // Update username in case it changed
    create: { discordId: userId, username },
  });

  // Get the guild's internal ID
  const guild = await db.guild.findUnique({
    where: { discordId: guildId },
    select: { id: true }
  });

  if (!guild) {
    throw new Error(`Guild ${guildId} not found in database`);
  }

  // Get current member data
  const existingMember = await db.guildMember.findUnique({
    where: { userId_guildId: { userId: user.id, guildId: guild.id } },
  });

  // Calculate streak
  const streakData = calculateStreak(existingMember?.lastActiveAt || null);
  let newStreak = existingMember?.currentStreak || 0;
  
  if (!streakData.isActiveToday) {
    // New day! Increment streak if was active yesterday
    if (existingMember?.lastActiveAt) {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = yesterday.toISOString().split('T')[0];
      const lastActiveStr = existingMember.lastActiveAt.toISOString().split('T')[0];
      
      if (lastActiveStr === yesterdayStr) {
        newStreak = (existingMember.currentStreak || 0) + 1;
      } else if (lastActiveStr === new Date().toISOString().split('T')[0]) {
        newStreak = existingMember.currentStreak || 1;
      } else {
        newStreak = 1; // Reset streak
      }
    } else {
      newStreak = 1;
    }
  } else {
    newStreak = existingMember?.currentStreak || 1;
  }

  // Streak bonus: +5% XP per streak day (max 50% at 10 days)
  const streakBonus = Math.min(0.5, (newStreak - 1) * 0.05);
  const totalMultiplier = multiplier * (1 + streakBonus);
  const finalAmount = Math.floor(baseAmount * totalMultiplier);

  // Update member with XP and streak
  const member = await db.guildMember.upsert({
    where: { userId_guildId: { userId: user.id, guildId: guild.id } },
    update: { 
      xp: { increment: finalAmount },
      lastActiveAt: new Date(),
      currentStreak: newStreak,
      totalMessages: { increment: source === 'message' ? 1 : 0 },
    },
    create: { 
      userId: user.id, 
      guildId: guild.id, 
      xp: finalAmount,
      lastActiveAt: new Date(),
      currentStreak: newStreak,
      totalMessages: source === 'message' ? 1 : 0,
    },
    include: { guild: true },
  });

  const oldLevel = member.level;
  const newLevel = xpToLevel(member.xp);

  // Check for achievements
  const newAchievements: string[] = [];
  const currentAchievements = (member.achievements as string[]) || [];
  
  // Level achievements
  if (newLevel >= 10 && !currentAchievements.includes('level_10')) newAchievements.push('level_10');
  if (newLevel >= 25 && !currentAchievements.includes('level_25')) newAchievements.push('level_25');
  if (newLevel >= 50 && !currentAchievements.includes('level_50')) newAchievements.push('level_50');
  if (newLevel >= 100 && !currentAchievements.includes('level_100')) newAchievements.push('level_100');
  
  // Streak achievements
  if (newStreak >= 7 && !currentAchievements.includes('streak_7')) newAchievements.push('streak_7');
  if (newStreak >= 30 && !currentAchievements.includes('streak_30')) newAchievements.push('streak_30');

  // First message achievement
  if (member.totalMessages === 1 && !currentAchievements.includes('first_message')) {
    newAchievements.push('first_message');
  }

  if (newLevel > oldLevel || newAchievements.length > 0) {
    // Update DB with new level and achievements
    await db.guildMember.update({
      where: { userId_guildId: { userId: user.id, guildId: guild.id } },
      data: { 
        level: newLevel,
        achievements: [...currentAchievements, ...newAchievements],
      },
    });

    const guildSettings = member.guild;
    const rewards = guildSettings.levelRewards as Record<string, string> | null;
    const roleId = rewards ? rewards[newLevel.toString()] : null;
    
    return {
      leveledUp: newLevel > oldLevel,
      newLevel,
      channelId: guildSettings.levelUpChannelId,
      roleId,
      newAchievements,
      streakBonus: Math.floor(streakBonus * 100),
      currentStreak: newStreak,
    };
  }
  
  return { 
    leveledUp: false, 
    streakBonus: Math.floor(streakBonus * 100),
    currentStreak: newStreak,
  };
}

export async function getXP(guildId: string, userId: string) {
  // Get internal IDs
  const user = await db.user.findUnique({
    where: { discordId: userId },
    select: { id: true }
  });

  const guild = await db.guild.findUnique({
    where: { discordId: guildId },
    select: { id: true }
  });

  if (!user || !guild) return 0;

  const member = await db.guildMember.findUnique({
    where: { userId_guildId: { userId: user.id, guildId: guild.id } },
  });
  return member?.xp ?? 0;
}

export function xpToLevel(xp: number) {
  return Math.floor(0.1 * Math.sqrt(xp));
}

export function levelToXP(level: number) {
  return Math.pow(level / 0.1, 2);
}

export const data = new SlashCommandBuilder()
  .setName('rank')
  .setDescription('Shows detailed level stats and achievements.')
  .addUserOption((o) => o.setName('user').setDescription('Another user (optional).'));

export async function execute(interaction: ChatInputCommandInteraction) {
  const guildSettings = await db.guild.findUnique({
    where: { discordId: interaction.guildId! },
  });
  if (!guildSettings?.levelingEnabled) {
    return interaction.reply({ content: '❌ The Leveling module is disabled on this server.', ephemeral: true });
  }

  const target = interaction.options.getUser('user') ?? interaction.user;
  
  // Get user's internal ID
  const user = await db.user.findUnique({
    where: { discordId: target.id },
    select: { id: true }
  });

  const guild = await db.guild.findUnique({
    where: { discordId: interaction.guild!.id },
    select: { id: true }
  });

  if (!user || !guild) {
    return interaction.reply({ content: '❌ No leveling data found for this user.', ephemeral: true });
  }

  const member = await db.guildMember.findUnique({
    where: { userId_guildId: { userId: user.id, guildId: guild.id } },
  });

  if (!member) {
    return interaction.reply({ content: '❌ No leveling data found for this user.', ephemeral: true });
  }

  const xp = member.xp;
  const level = xpToLevel(xp);
  const nextLevelXP = levelToXP(level + 1);
  const currentLevelXP = levelToXP(level);
  const xpProgress = xp - currentLevelXP;
  const xpNeeded = nextLevelXP - currentLevelXP;
  const progress = Math.min(100, Math.floor((xpProgress / xpNeeded) * 100));
  const bar = buildBar(progress);

  // Get user's rank
  const allMembers = await db.guildMember.findMany({
    where: { guildId: guild.id },
    orderBy: { xp: 'desc' },
    select: { userId: true, xp: true }
  });
  const rank = allMembers.findIndex(m => m.userId === user.id) + 1;

  // Achievements
  const userAchievements = (member.achievements as string[]) || [];
  const achievementList = userAchievements
    .map(id => {
      const achievement = Object.values(ACHIEVEMENTS).find(a => a.id === id);
      return achievement ? `${achievement.name}` : null;
    })
    .filter(Boolean)
    .slice(0, 5); // Show max 5

  // Streak info
  const streakEmoji = member.currentStreak >= 7 ? '🔥' : '📅';
  const streakBonus = Math.min(50, (member.currentStreak - 1) * 5);

  // Build beautiful embed
  const embed = new EmbedBuilder()
    .setColor(level >= 50 ? 0xffd700 : level >= 25 ? 0x8b5cf6 : 0x6366f1) // Gold, Purple, Blue
    .setTitle(`🏅 ${target.username}'s Rank Card`)
    .setThumbnail(target.displayAvatarURL({ size: 128 }))
    .addFields(
      { name: '📊 Level', value: `**${level}**`, inline: true },
      { name: '🏆 Rank', value: `**#${rank}** / ${allMembers.length}`, inline: true },
      { name: '⚡ Total XP', value: `**${xp.toLocaleString()}**`, inline: true },
      { name: '📈 Progress to Next Level', value: `${bar}\n${xpProgress.toLocaleString()} / ${xpNeeded.toLocaleString()} XP (**${progress}%**)`, inline: false },
      { name: `${streakEmoji} Daily Streak`, value: `**${member.currentStreak} days** (+${streakBonus}% XP bonus)`, inline: true },
      { name: '💬 Messages', value: `**${member.totalMessages.toLocaleString()}**`, inline: true },
      { name: '📅 Last Active', value: member.lastActiveAt ? `<t:${Math.floor(member.lastActiveAt.getTime() / 1000)}:R>` : 'Never', inline: true },
    )
    .setFooter({ text: `${achievementList.length > 0 ? achievementList.length : 'No'} Achievement${achievementList.length !== 1 ? 's' : ''} Unlocked` })
    .setTimestamp();

  if (achievementList.length > 0) {
    embed.addFields({
      name: '🎖️ Recent Achievements',
      value: achievementList.join(' • '),
      inline: false
    });
  }

  await interaction.reply({ embeds: [embed] });
}

function buildBar(percent: number): string {
  const filled = Math.floor(percent / 5);
  const empty = 20 - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}
