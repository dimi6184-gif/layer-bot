// apps/bot/src/utils/impersonationDetector.ts
import { PrismaClient } from '@prisma/client';
import { EmbedBuilder, User, Guild, GuildMember, TextChannel } from 'discord.js';
import Levenshtein from 'fast-levenshtein';

const prisma = new PrismaClient();

interface ImpersonationResult {
  isImpersonator: boolean;
  similarityScore: number;
  usernameSimilarity: number;
  avatarSimilarity?: number;
  matchReasons: string[];
  targetStaff?: {
    userId: string;
    username: string;
  };
}

export class ImpersonationDetector {
  /**
   * Check if a user is impersonating staff
   */
  static async checkImpersonation(
    member: GuildMember
  ): Promise<ImpersonationResult | null> {
    try {
      const guild = member.guild;

      // Check if impersonation detection is enabled
      const guildSettings = await prisma.guild.findUnique({
        where: { discordId: guild.id },
        select: {
          impersonationEnabled: true,
          impersonationSensitivity: true,
          protectedUserIds: true,
        },
      });

      if (!guildSettings?.impersonationEnabled) {
        return null;
      }

      // Get all protected staff profiles
      const staffProfiles = await prisma.staffProfile.findMany({
        where: {
          guildId: guild.id,
          protected: true,
        },
      });

      if (staffProfiles.length === 0) {
        return null;
      }

      // Check against each staff member
      let bestMatch: ImpersonationResult | null = null;
      let highestScore = 0;

      for (const staff of staffProfiles) {
        // Don't check if it's the actual staff member
        if (staff.userId === member.id) {
          continue;
        }

        const result = this.compareWithStaff(member, staff, guildSettings.impersonationSensitivity);

        if (result.similarityScore > highestScore) {
          highestScore = result.similarityScore;
          bestMatch = result;
        }
      }

      // Determine threshold based on sensitivity
      const threshold = this.getThreshold(guildSettings.impersonationSensitivity);

      if (bestMatch && bestMatch.similarityScore >= threshold) {
        // Log detection
        await this.logImpersonation(guild.id, member, bestMatch);
        return bestMatch;
      }

      return null;
    } catch (error) {
      console.error('[ImpersonationDetector] Error checking:', error);
      return null;
    }
  }

  /**
   * Compare user with staff member
   */
  private static compareWithStaff(
    member: GuildMember,
    staff: any,
    sensitivity: string
  ): ImpersonationResult {
    const matchReasons: string[] = [];
    let usernameSimilarity = 0;
    let avatarSimilarity: number | undefined;

    // 1. Username similarity (case-insensitive)
    const memberUsername = (member.user.username || '').toLowerCase();
    const memberDisplayName = (member.displayName || member.user.username).toLowerCase();
    const staffUsername = (staff.username || '').toLowerCase();
    const staffDisplayName = (staff.displayName || staff.username).toLowerCase();

    // Calculate Levenshtein distance (0 = identical, higher = more different)
    const usernameDistance = Math.min(
      Levenshtein.get(memberUsername, staffUsername),
      Levenshtein.get(memberDisplayName, staffDisplayName),
      Levenshtein.get(memberUsername, staffDisplayName),
      Levenshtein.get(memberDisplayName, staffUsername)
    );

    // Convert distance to similarity (0-100)
    const maxLength = Math.max(
      memberUsername.length,
      staffUsername.length,
      memberDisplayName.length,
      staffDisplayName.length
    );
    usernameSimilarity = maxLength > 0 ? ((maxLength - usernameDistance) / maxLength) * 100 : 0;

    // Check for exact or very similar match
    if (usernameSimilarity > 85) {
      matchReasons.push('very_similar_username');
    } else if (usernameSimilarity > 70) {
      matchReasons.push('similar_username');
    }

    // Check for common impersonation patterns
    if (this.hasImpersonationPattern(memberUsername, staffUsername)) {
      matchReasons.push('impersonation_pattern');
      usernameSimilarity += 20; // Boost score for obvious patterns
    }

    // 2. Avatar similarity (basic check - same avatar hash)
    if (member.user.avatar && staff.avatarHash) {
      if (member.user.avatar === staff.avatarHash) {
        avatarSimilarity = 100;
        matchReasons.push('identical_avatar');
      }
    }

    // Calculate overall similarity score
    let similarityScore = usernameSimilarity * 0.7; // Username is 70%
    if (avatarSimilarity) {
      similarityScore += avatarSimilarity * 0.3; // Avatar is 30%
    }

    similarityScore = Math.min(100, similarityScore);

    return {
      isImpersonator: similarityScore >= this.getThreshold(sensitivity),
      similarityScore: Math.round(similarityScore),
      usernameSimilarity: Math.round(usernameSimilarity),
      avatarSimilarity: avatarSimilarity ? Math.round(avatarSimilarity) : undefined,
      matchReasons,
      targetStaff: {
        userId: staff.userId,
        username: staff.username,
      },
    };
  }

  /**
   * Check for common impersonation patterns
   */
  private static hasImpersonationPattern(suspect: string, target: string): boolean {
    // Remove spaces and special chars for comparison
    const cleanSuspect = suspect.replace(/[^a-z0-9]/gi, '');
    const cleanTarget = target.replace(/[^a-z0-9]/gi, '');

    // Pattern 1: Added/changed single character (admin → admln, admin1)
    if (Math.abs(cleanSuspect.length - cleanTarget.length) === 1) {
      if (Levenshtein.get(cleanSuspect, cleanTarget) === 1) {
        return true;
      }
    }

    // Pattern 2: Unicode lookalikes (a → а, o → о, e → е)
    const lookalikes: Record<string, string[]> = {
      a: ['а', 'ɑ', '@'],
      e: ['е', 'ė', '3'],
      o: ['о', 'ο', '0'],
      i: ['і', 'ı', '1', 'l'],
      s: ['ѕ', '$', '5'],
    };

    // Check if names are identical after replacing lookalikes
    let normalizedSuspect = cleanSuspect.toLowerCase();
    let normalizedTarget = cleanTarget.toLowerCase();

    for (const [real, fakes] of Object.entries(lookalikes)) {
      for (const fake of fakes) {
        normalizedSuspect = normalizedSuspect.replace(new RegExp(fake, 'g'), real);
      }
    }

    if (normalizedSuspect === normalizedTarget) {
      return true;
    }

    // Pattern 3: Added prefix/suffix (admin → adminn, xadmin, admin_)
    if (cleanSuspect.includes(cleanTarget) || cleanTarget.includes(cleanSuspect)) {
      return true;
    }

    return false;
  }

  /**
   * Get threshold based on sensitivity
   */
  private static getThreshold(sensitivity: string): number {
    switch (sensitivity) {
      case 'high':
        return 60; // More alerts, catch more but more false positives
      case 'low':
        return 85; // Fewer alerts, only very obvious cases
      case 'medium':
      default:
        return 75; // Balanced
    }
  }

  /**
   * Log impersonation detection
   */
  private static async logImpersonation(
    guildId: string,
    member: GuildMember,
    result: ImpersonationResult
  ): Promise<void> {
    try {
      // Store in database
      await prisma.impersonationDetection.create({
        data: {
          guildId,
          suspectUserId: member.id,
          suspectUsername: member.user.username,
          targetUserId: result.targetStaff!.userId,
          targetUsername: result.targetStaff!.username,
          similarityScore: result.similarityScore,
          usernameSimilarity: result.usernameSimilarity,
          avatarSimilarity: result.avatarSimilarity,
          matchReasons: result.matchReasons,
          status: 'pending',
        },
      });

      // Send alert to log channel
      const guildSettings = await prisma.guild.findUnique({
        where: { discordId: guildId },
        select: {
          impersonationLogChannelId: true,
          impersonationAutoAction: true,
        },
      });

      if (guildSettings?.impersonationLogChannelId) {
        await this.sendAlert(member, result, guildSettings.impersonationLogChannelId);
      }

      // Take auto-action if configured ("none" means detection is alert-only).
      const autoAction = (guildSettings?.impersonationAutoAction || '').toLowerCase();
      if (autoAction && autoAction !== 'none') {
        await this.takeAction(member, result, autoAction);
      }
    } catch (error) {
      console.error('[ImpersonationDetector] Error logging:', error);
    }
  }

  /**
   * Send alert to log channel
   */
  private static async sendAlert(
    member: GuildMember,
    result: ImpersonationResult,
    channelId: string
  ): Promise<void> {
    try {
      const channel = member.guild.channels.cache.get(channelId) as TextChannel;
      if (!channel) return;

      const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('⚠️ Potential Impersonation Detected')
        .setDescription(`**${member.user.username}** may be impersonating a staff member`)
        .setThumbnail(member.user.displayAvatarURL())
        .addFields(
          { name: 'Suspect', value: `<@${member.id}>`, inline: true },
          { name: 'Target Staff', value: `<@${result.targetStaff!.userId}>`, inline: true },
          { name: 'Similarity Score', value: `${result.similarityScore}%`, inline: true },
          { 
            name: 'Match Reasons', 
            value: result.matchReasons.map(r => `• ${r.replace(/_/g, ' ')}`).join('\n') || 'None',
            inline: false 
          },
          { name: 'Joined', value: `<t:${Math.floor(member.joinedTimestamp! / 1000)}:R>`, inline: true }
        )
        .setFooter({ text: `User ID: ${member.id}` })
        .setTimestamp();

      await channel.send({ 
        content: `<@&${member.guild.roles.cache.find(r => r.permissions.has('ModerateMembers'))?.id}>`,
        embeds: [embed] 
      });
    } catch (error) {
      console.error('[ImpersonationDetector] Error sending alert:', error);
    }
  }

  /**
   * Take automated action
   */
  private static async takeAction(
    member: GuildMember,
    result: ImpersonationResult,
    action: string
  ): Promise<void> {
    try {
      switch (action) {
        case 'nickname':
          // Auto-nickname to "Impersonator-[random]"
          const randomId = Math.random().toString(36).substring(7);
          await member.setNickname(`Impersonator-${randomId}`, 'Potential impersonation detected');
          break;

        case 'kick':
          await member.kick('Potential impersonation detected');
          break;

        case 'ban':
          await member.ban({ reason: 'Potential impersonation detected' });
          break;

        case 'alert':
        default:
          // Just alert, no action
          break;
      }
    } catch (error) {
      console.error('[ImpersonationDetector] Error taking action:', error);
    }
  }

  /**
   * Sync staff profiles (should be called when roles change)
   */
  static async syncStaffProfiles(guild: Guild): Promise<void> {
    try {
      const guildSettings = await prisma.guild.findUnique({
        where: { discordId: guild.id },
        select: {
          protectedUserIds: true,
        },
      });

      if (!guildSettings?.protectedUserIds || guildSettings.protectedUserIds.length === 0) {
        return;
      }

      // Update/create profiles for all protected users
      for (const userId of guildSettings.protectedUserIds) {
        const member = await guild.members.fetch(userId).catch(() => null);
        if (!member) continue;

        await prisma.staffProfile.upsert({
          where: {
            userId_guildId: {
              userId,
              guildId: guild.id,
            },
          },
          update: {
            username: member.user.username,
            displayName: member.displayName,
            avatarUrl: member.user.displayAvatarURL({ size: 512 }),
            avatarHash: member.user.avatar,
          },
          create: {
            userId,
            guildId: guild.id,
            username: member.user.username,
            displayName: member.displayName,
            avatarUrl: member.user.displayAvatarURL({ size: 512 }),
            avatarHash: member.user.avatar,
            protected: true,
          },
        });
      }
    } catch (error) {
      console.error('[ImpersonationDetector] Error syncing staff profiles:', error);
    }
  }
}
