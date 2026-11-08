// apps/bot/src/utils/ghostCleaner.ts
import { PrismaClient } from '@prisma/client';
import { EmbedBuilder, Guild, GuildMember, TextChannel } from 'discord.js';

const prisma = new PrismaClient();

interface GhostStats {
  totalMembers: number;
  inactiveMembers: number;
  ghostMembers: number;
  whitelistedMembers: number;
  kickableMembers: number;
}

export class GhostCleaner {
  /**
   * Scan server for ghost/inactive members
   */
  /**
   * Last message activity. The bot logs one MESSAGE_SENT audit entry per member and day,
   * which is the only activity record written for every guild.
   */
  private static async getLastActivity(guildId: string, userId: string): Promise<Date | null> {
    const entry = await prisma.auditLog.findFirst({
      where: { guildId, userId, action: 'MESSAGE_SENT' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    return entry?.createdAt ?? null;
  }

  static async scanServer(guild: Guild): Promise<GhostStats> {
    try {
      // Get settings
      const settings = await prisma.guild.findUnique({
        where: { discordId: guild.id },
        select: {
          ghostCleanerEnabled: true,
          ghostInactiveDays: true,
          ghostWhitelistRoles: true,
        },
      });

      if (!settings?.ghostCleanerEnabled) {
        throw new Error('Ghost cleaner not enabled');
      }

      const inactiveDays = settings.ghostInactiveDays || 90;
      const cutoffDate = new Date(Date.now() - inactiveDays * 24 * 60 * 60 * 1000);

      // Fetch all members
      await guild.members.fetch();
      const members = guild.members.cache;

      let inactiveCount = 0;
      let ghostCount = 0;
      let whitelistedCount = 0;

      for (const [memberId, member] of members) {
        // Skip bots
        if (member.user.bot) continue;

        // Check if whitelisted (has protected role)
        const isWhitelisted = settings.ghostWhitelistRoles.some(roleId =>
          member.roles.cache.has(roleId)
        );

        const joinedAt = member.joinedAt || new Date();
        const lastMessageAt = await this.getLastActivity(guild.id, member.id);
        const messageCount = lastMessageAt
          ? await prisma.auditLog.count({ where: { guildId: guild.id, userId: member.id, action: 'MESSAGE_SENT' } })
          : 0;

        // Determine if inactive
        const lastActivity = lastMessageAt || joinedAt;
        const isInactive = lastActivity < cutoffDate;
        const inactiveDaysSince = Math.floor((Date.now() - lastActivity.getTime()) / (1000 * 60 * 60 * 24));

        if (isInactive) {
          inactiveCount++;

          // Store/update in database
          await prisma.inactiveMember.upsert({
            where: {
              userId_guildId: {
                userId: member.id,
                guildId: guild.id,
              },
            },
            update: {
              username: member.user.username,
              lastMessageAt,
              messageCount,
              isInactive: true,
              inactiveDays: inactiveDaysSince,
              isWhitelisted,
              whitelistReason: isWhitelisted ? 'Protected role' : null,
              lastChecked: new Date(),
            },
            create: {
              userId: member.id,
              guildId: guild.id,
              username: member.user.username,
              joinedAt,
              lastMessageAt,
              messageCount,
              isInactive: true,
              inactiveDays: inactiveDaysSince,
              isWhitelisted,
              whitelistReason: isWhitelisted ? 'Protected role' : null,
            },
          });

          if (isWhitelisted) {
            whitelistedCount++;
          } else {
            ghostCount++;
          }
        }
      }

      return {
        totalMembers: members.size,
        inactiveMembers: inactiveCount,
        ghostMembers: ghostCount,
        whitelistedMembers: whitelistedCount,
        kickableMembers: ghostCount, // Non-whitelisted inactive members
      };
    } catch (error) {
      console.error('[GhostCleaner] Error scanning server:', error);
      throw error;
    }
  }

  /**
   * Get list of ghost members
   */
  static async getGhostMembers(
    guildId: string,
    limit = 100
  ): Promise<Array<{
    userId: string;
    username: string;
    inactiveDays: number;
    messageCount: number;
    isWhitelisted: boolean;
  }>> {
    try {
      const ghosts = await prisma.inactiveMember.findMany({
        where: {
          guildId,
          isInactive: true,
        },
        orderBy: {
          inactiveDays: 'desc',
        },
        take: limit,
        select: {
          userId: true,
          username: true,
          inactiveDays: true,
          messageCount: true,
          isWhitelisted: true,
        },
      });

      return ghosts;
    } catch (error) {
      console.error('[GhostCleaner] Error getting ghost members:', error);
      return [];
    }
  }

  /**
   * Schedule kicks for ghost members
   */
  static async scheduleKicks(
    guild: Guild,
    userIds?: string[]
  ): Promise<number> {
    try {
      const settings = await prisma.guild.findUnique({
        where: { discordId: guild.id },
        select: {
          ghostKickEnabled: true,
          ghostWarnBeforeKick: true,
          ghostWarningDays: true,
          ghostLogChannelId: true,
        },
      });

      if (!settings?.ghostKickEnabled) {
        throw new Error('Ghost kick not enabled');
      }

      // Get target members
      const whereClause: any = {
        guildId: guild.id,
        isInactive: true,
        isWhitelisted: false,
        kickScheduled: false,
      };

      if (userIds && userIds.length > 0) {
        whereClause.userId = { in: userIds };
      }

      const targets = await prisma.inactiveMember.findMany({
        where: whereClause,
      });

      let scheduled = 0;

      for (const target of targets) {
        const member = await guild.members.fetch(target.userId).catch(() => null);
        if (!member) continue;

        // Send warning DM if enabled
        if (settings.ghostWarnBeforeKick) {
          const warned = await this.sendWarning(member, target.inactiveDays, settings.ghostWarningDays);

          // Schedule kick
          const kickDate = new Date(Date.now() + settings.ghostWarningDays * 24 * 60 * 60 * 1000);
          await prisma.inactiveMember.update({
            where: { id: target.id },
            data: {
              kickScheduled: true,
              kickScheduledAt: kickDate,
              kickWarned: warned,
            },
          });
        } else {
          // Immediate kick
          const kickDate = new Date();
          await prisma.inactiveMember.update({
            where: { id: target.id },
            data: {
              kickScheduled: true,
              kickScheduledAt: kickDate,
              kickWarned: false,
            },
          });
        }

        scheduled++;
      }

      // Log to channel
      if (settings.ghostLogChannelId && scheduled > 0) {
        await this.logScheduledKicks(guild, scheduled, settings.ghostLogChannelId);
      }

      return scheduled;
    } catch (error) {
      console.error('[GhostCleaner] Error scheduling kicks:', error);
      return 0;
    }
  }

  /**
   * Execute scheduled kicks
   */
  static async executeScheduledKicks(guild: Guild): Promise<number> {
    try {
      const now = new Date();

      // Get members scheduled for kick
      const targets = await prisma.inactiveMember.findMany({
        where: {
          guildId: guild.id,
          kickScheduled: true,
          kickScheduledAt: {
            lte: now,
          },
        },
      });

      let kicked = 0;

      // Settings may have changed since the kicks were scheduled.
      const current = await prisma.guild.findUnique({
        where: { discordId: guild.id },
        select: { ghostCleanerEnabled: true, ghostKickEnabled: true, ghostInactiveDays: true, ghostWhitelistRoles: true },
      });
      if (!current?.ghostCleanerEnabled || !current.ghostKickEnabled) return 0;
      const cutoffDate = new Date(Date.now() - (current.ghostInactiveDays || 90) * 24 * 60 * 60 * 1000);

      for (const target of targets) {
        const member = await guild.members.fetch(target.userId).catch(() => null);
        if (!member) {
          // Member already left, cleanup
          await prisma.inactiveMember.delete({ where: { id: target.id } });
          continue;
        }

        // Skip members who became active or protected after being scheduled.
        const lastActivity = await this.getLastActivity(guild.id, member.id);
        const isWhitelisted = current.ghostWhitelistRoles.some((roleId) => member.roles.cache.has(roleId));
        if (isWhitelisted || target.isWhitelisted || (lastActivity && lastActivity >= cutoffDate)) {
          await prisma.inactiveMember.delete({ where: { id: target.id } });
          continue;
        }

        try {
          await member.kick(`Inactive for ${target.inactiveDays} days`);
          await prisma.inactiveMember.delete({ where: { id: target.id } });
          kicked++;
        } catch (error) {
          console.error(`[GhostCleaner] Failed to kick ${target.username}:`, error);
        }
      }

      // Log results
      const settings = await prisma.guild.findUnique({
        where: { discordId: guild.id },
        select: { ghostLogChannelId: true },
      });

      if (settings?.ghostLogChannelId && kicked > 0) {
        await this.logExecutedKicks(guild, kicked, settings.ghostLogChannelId);
      }

      return kicked;
    } catch (error) {
      console.error('[GhostCleaner] Error executing kicks:', error);
      return 0;
    }
  }

  /**
   * Send warning DM to user
   */
  private static async sendWarning(
    member: GuildMember,
    inactiveDays: number,
    warningDays: number
  ): Promise<boolean> {
    try {
      const embed = new EmbedBuilder()
        .setColor('#FFA500')
        .setTitle(`⚠️ Inactivity Warning - ${member.guild.name}`)
        .setDescription(
          `You've been inactive in **${member.guild.name}** for **${inactiveDays} days**.\n\n` +
          `If you don't become active within the next **${warningDays} days**, ` +
          `you will be automatically removed from the server.\n\n` +
          `Send any message in the server to remain a member!`
        )
        .setThumbnail(member.guild.iconURL() || '')
        .setFooter({ text: 'This is an automated message' })
        .setTimestamp();

      await member.send({ embeds: [embed] });
      return true;
    } catch (error) {
      // User has DMs disabled
      return false;
    }
  }

  /**
   * Log scheduled kicks
   */
  private static async logScheduledKicks(
    guild: Guild,
    count: number,
    channelId: string
  ): Promise<void> {
    try {
      const channel = guild.channels.cache.get(channelId) as TextChannel;
      if (!channel) return;

      const embed = new EmbedBuilder()
        .setColor('#FFA500')
        .setTitle('👻 Ghost Members - Kicks Scheduled')
        .setDescription(`Scheduled **${count}** inactive members for removal`)
        .setTimestamp();

      await channel.send({ embeds: [embed] });
    } catch (error) {
      console.error('[GhostCleaner] Error logging scheduled kicks:', error);
    }
  }

  /**
   * Log executed kicks
   */
  private static async logExecutedKicks(
    guild: Guild,
    count: number,
    channelId: string
  ): Promise<void> {
    try {
      const channel = guild.channels.cache.get(channelId) as TextChannel;
      if (!channel) return;

      const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('👻 Ghost Members - Removed')
        .setDescription(`Removed **${count}** inactive members from the server`)
        .setTimestamp();

      await channel.send({ embeds: [embed] });
    } catch (error) {
      console.error('[GhostCleaner] Error logging executed kicks:', error);
    }
  }

  /**
   * Whitelist a user from ghost cleaning
   */
  static async whitelistUser(
    userId: string,
    guildId: string,
    reason: string
  ): Promise<void> {
    try {
      await prisma.inactiveMember.updateMany({
        where: {
          userId,
          guildId,
        },
        data: {
          isWhitelisted: true,
          whitelistReason: reason,
          kickScheduled: false,
        },
      });
    } catch (error) {
      console.error('[GhostCleaner] Error whitelisting user:', error);
    }
  }

  /**
   * Cancel scheduled kick for a user
   */
  static async cancelKick(
    userId: string,
    guildId: string
  ): Promise<void> {
    try {
      await prisma.inactiveMember.updateMany({
        where: {
          userId,
          guildId,
        },
        data: {
          kickScheduled: false,
          kickScheduledAt: null,
        },
      });
    } catch (error) {
      console.error('[GhostCleaner] Error canceling kick:', error);
    }
  }
}
