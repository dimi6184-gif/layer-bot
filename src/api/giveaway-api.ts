import { Request, Response } from 'express';
import { bearerMatches } from '../utils/apiAuth.js';
import { Client, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { db } from '../db.js';
import { randomInt } from 'crypto';
import { endGiveaway as endGiveawayHelper } from '../commands/fun/giveaway.js';
import { getGuildEmbedColor } from '../utils/embedColor.js';

/** Cryptographically fair Fisher-Yates shuffle */
function cryptoShuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Create Giveaway
export async function createGiveawayHandler(req: Request, res: Response, client: Client) {
  try {
    // Auth check
    const authHeader = req.headers.authorization;
    const secret = process.env.BOT_API_SECRET;
    if (!secret) {
      console.error('[API] BOT_API_SECRET is not configured!');
      return res.status(500).send('Server misconfiguration');
    }
    if (!bearerMatches(authHeader, secret)) {
      return res.status(401).send('Unauthorized');
    }

    const {
      guildId,
      channelId,
      prize,
      description,
      duration,
      winnerCount,
      endsAt,
      requiredRoleIds,
      requiredLevel,
      requireBoost,
      blacklistedRoleIds,
    } = req.body;

    if (!guildId || !channelId || !prize || !winnerCount || !endsAt) {
      return res.status(400).send('Missing required fields');
    }

    // Get channel
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased()) {
      return res.status(404).send('Channel not found or not text-based');
    }
    // The channel must belong to the guild the dashboard user is authorized for.
    if (channel.isDMBased() || channel.guildId !== guildId) {
      return res.status(403).send('Channel does not belong to this server');
    }

    const endsAtDate = new Date(endsAt);
    const endsAtTimestamp = Math.floor(endsAtDate.getTime() / 1000);

    // Build requirements text
    const requirements: string[] = [];
    if (requiredRoleIds && requiredRoleIds.length > 0) {
      requirements.push(`• Role: <@&${requiredRoleIds[0]}>`);
    }
    if (requiredLevel) requirements.push(`• Level: ${requiredLevel}+`);
    if (requireBoost) requirements.push(`• Must be a Server Booster`);
    if (blacklistedRoleIds && blacklistedRoleIds.length > 0) {
      requirements.push(`• Cannot have role: <@&${blacklistedRoleIds[0]}>`);
    }

    // Create embed
    const embedColor = await getGuildEmbedColor(guildId);
    const embed = new EmbedBuilder()
      .setColor(embedColor)
      .setTitle('🎉 GIVEAWAY 🎉')
      .setDescription(
        `**Prize:** ${prize}\n\n` +
          (description ? `${description}\n\n` : '') +
          `**Winners:** ${winnerCount}\n` +
          `**Ends:** <t:${endsAtTimestamp}:R> (<t:${endsAtTimestamp}:F>)\n` +
          `**Hosted by:** Dashboard\n\n` +
          (requirements.length > 0 ? `**Requirements:**\n${requirements.join('\n')}\n\n` : '') +
          `Click the button below to enter!`
      )
      .setFooter({ text: `${winnerCount} winner${winnerCount > 1 ? 's' : ''} | Ends` })
      .setTimestamp(endsAtDate);

    const button = new ButtonBuilder()
      .setCustomId('giveaway:enter')
      .setLabel('🎉 Enter Giveaway')
      .setStyle(ButtonStyle.Primary);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(button);

    const message = await (channel as any).send({
      embeds: [embed],
      components: [row],
    });

    // Save to database
    const giveaway = await db.giveaway.create({
      data: {
        guildId,
        channelId,
        messageId: message.id,
        hostId: 'dashboard',
        hostName: 'Dashboard',
        prize,
        description,
        winnerCount,
        requiredRoleIds: requiredRoleIds || [],
        requiredLevel,
        requireBoost: requireBoost || false,
        blacklistedRoleIds: blacklistedRoleIds || [],
        duration,
        endsAt: endsAtDate,
      },
    });

    console.log(`[API] Giveaway created: ${prize} in ${guildId}`);

    res.status(200).json({
      success: true,
      giveawayId: giveaway.id,
      messageId: message.id,
    });
  } catch (error: any) {
    console.error('[API] Error creating giveaway:', error);
    res.status(500).send(error.message || 'Internal server error');
  }
}

// End Giveaway
export async function endGiveawayHandler(req: Request, res: Response, client: Client) {
  try {
    // Auth check
    const authHeader = req.headers.authorization;
    const secret = process.env.BOT_API_SECRET;
    if (!secret) {
      console.error('[API] BOT_API_SECRET is not configured!');
      return res.status(500).send('Server misconfiguration');
    }
    if (!bearerMatches(authHeader, secret)) {
      return res.status(401).send('Unauthorized');
    }

    const { guildId, messageId } = req.body;

    if (!guildId || !messageId) {
      return res.status(400).send('Missing required fields');
    }

    // Find giveaway
    const giveaway = await db.giveaway.findFirst({
      where: { guildId, messageId, ended: false },
    });

    if (!giveaway) {
      return res.status(404).send('Giveaway not found or already ended');
    }

    // End it
    await endGiveawayHelper(giveaway.id, client);

    console.log(`[API] Giveaway ended: ${giveaway.prize} in ${guildId}`);

    res.status(200).json({ success: true });
  } catch (error: any) {
    console.error('[API] Error ending giveaway:', error);
    res.status(500).send(error.message || 'Internal server error');
  }
}

// Reroll Giveaway
export async function rerollGiveawayHandler(req: Request, res: Response, client: Client) {
  try {
    // Auth check
    const authHeader = req.headers.authorization;
    const secret = process.env.BOT_API_SECRET;
    if (!secret) {
      console.error('[API] BOT_API_SECRET is not configured!');
      return res.status(500).send('Server misconfiguration');
    }
    if (!bearerMatches(authHeader, secret)) {
      return res.status(401).send('Unauthorized');
    }

    const { guildId, messageId, winnersCount = 1 } = req.body;

    // Validate winnersCount
    const safeWinnersCount = Number(winnersCount);
    if (!Number.isInteger(safeWinnersCount) || safeWinnersCount < 1 || safeWinnersCount > 20) {
      return res.status(400).send('winnersCount must be between 1 and 20');
    }

    if (!guildId || !messageId) {
      return res.status(400).send('Missing required fields');
    }

    // Find giveaway
    const giveaway = await db.giveaway.findFirst({
      where: { guildId, messageId, ended: true },
    });

    if (!giveaway) {
      return res.status(404).send('Giveaway not found or not ended yet');
    }

    if (giveaway.participants.length === 0) {
      return res.status(400).send('No participants to reroll');
    }

    // Filter out previous winners
    const availableParticipants = giveaway.participants.filter(
      (id) => !giveaway.winnerIds.includes(id)
    );

    if (availableParticipants.length === 0) {
      return res.status(400).send('No more participants available to reroll');
    }

    // Pick new winners using cryptographically fair shuffle
    const pickWinners = (participants: string[], count: number) => {
      return cryptoShuffle(participants).slice(0, count);
    };

    const newWinnerIds = pickWinners(
      availableParticipants,
      Math.min(safeWinnersCount, availableParticipants.length)
    );

    // Fetch winner details
    const winners = await Promise.all(
      newWinnerIds.map(async (id) => {
        try {
          const user = await client.users.fetch(id);
          return { id: user.id, tag: user.tag, mention: `<@${user.id}>` };
        } catch {
          return null;
        }
      })
    );

    const validWinners = winners.filter((w) => w !== null) as {
      id: string;
      tag: string;
      mention: string;
    }[];

    if (validWinners.length === 0) {
      return res.status(500).send('Could not fetch any valid winners');
    }

    // Update database
    await db.giveaway.update({
      where: { id: giveaway.id },
      data: {
        winnerIds: [...giveaway.winnerIds, ...validWinners.map((w) => w.id)],
        winnerNames: [...giveaway.winnerNames, ...validWinners.map((w) => w.tag)],
      },
    });

    // Send announcement
    const channel = await client.channels.fetch(giveaway.channelId);
    if (channel?.isTextBased()) {
      await (channel as any).send(
        `🎉 **Giveaway Rerolled!**\n\n` +
          `**Prize:** ${giveaway.prize}\n` +
          `**New Winner${validWinners.length > 1 ? 's' : ''}:** ${validWinners
            .map((w) => w.mention)
            .join(', ')}\n\n` +
          `Congratulations! 🎊`
      );
    }

    console.log(`[API] Giveaway rerolled: ${giveaway.prize} in ${guildId}`);

    res.status(200).json({
      success: true,
      winners: validWinners,
    });
  } catch (error: any) {
    console.error('[API] Error rerolling giveaway:', error);
    res.status(500).send(error.message || 'Internal server error');
  }
}
