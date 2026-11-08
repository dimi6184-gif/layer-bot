import { MessageReaction, User, PartialMessageReaction, PartialUser } from 'discord.js';
import { db } from '../db.js';

const DEFAULT_EMOJIS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣'];

// Helper to check if emoji is a poll emoji (default or custom)
async function isPollEmoji(guildId: string, emoji: string): Promise<{ isValid: boolean; index: number }> {
  const guildSettings = await db.guild.findUnique({
    where: { discordId: guildId },
    select: { customPollEmojis: true },
  });

  const pollEmojis = guildSettings?.customPollEmojis && guildSettings.customPollEmojis.length === 4
    ? guildSettings.customPollEmojis
    : DEFAULT_EMOJIS;

  const index = pollEmojis.indexOf(emoji);
  return { isValid: index !== -1, index };
}

export async function handlePollReactionAdd(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser
) {
  // Ignore bot reactions
  if (user.bot) return;

  // Fetch partial data
  if (reaction.partial) {
    try {
      await reaction.fetch();
    } catch (error) {
      console.error('[Poll] Failed to fetch reaction:', error);
      return;
    }
  }

  // Check if reaction is a poll emoji
  const emojiCheck = await isPollEmoji(reaction.message.guildId!, reaction.emoji.name || '');
  if (!emojiCheck.isValid) return;

  try {
    // Read and write the votes under a row lock, so concurrent reactions cannot
    // overwrite each other's votes.
    const poll = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Poll" WHERE "messageId" = ${reaction.message.id} FOR UPDATE`;
      const current = await tx.poll.findUnique({ where: { messageId: reaction.message.id } });
      if (!current || current.ended || emojiCheck.index >= current.options.length) return null;

      const votes = current.votes as Array<{ option: string; userIds: string[] }>;
      // Remove user from all options (single choice), then add to the selected one
      votes.forEach((vote) => {
        vote.userIds = vote.userIds.filter((id) => id !== user.id);
      });
      votes[emojiCheck.index].userIds.push(user.id);

      await tx.poll.update({ where: { id: current.id }, data: { votes } });
      return current;
    });
    if (!poll) return;
    const optionIndex = emojiCheck.index;

    console.log(`[Poll] User ${user.tag} voted for option ${optionIndex + 1} in poll ${poll.id}`);
  } catch (error) {
    console.error('[Poll] Failed to handle reaction add:', error);
  }
}

export async function handlePollReactionRemove(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser
) {
  // Ignore bot reactions
  if (user.bot) return;

  // Fetch partial data
  if (reaction.partial) {
    try {
      await reaction.fetch();
    } catch (error) {
      console.error('[Poll] Failed to fetch reaction:', error);
      return;
    }
  }

  // Check if reaction is a poll emoji
  const emojiCheck = await isPollEmoji(reaction.message.guildId!, reaction.emoji.name || '');
  if (!emojiCheck.isValid) return;

  try {
    // Same row lock as on add, so a removal cannot drop someone else's vote.
    const poll = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Poll" WHERE "messageId" = ${reaction.message.id} FOR UPDATE`;
      const current = await tx.poll.findUnique({ where: { messageId: reaction.message.id } });
      if (!current || current.ended || emojiCheck.index >= current.options.length) return null;

      const votes = current.votes as Array<{ option: string; userIds: string[] }>;
      votes[emojiCheck.index].userIds = votes[emojiCheck.index].userIds.filter((id) => id !== user.id);

      await tx.poll.update({ where: { id: current.id }, data: { votes } });
      return current;
    });
    if (!poll) return;
    const optionIndex = emojiCheck.index;

    console.log(`[Poll] User ${user.tag} removed vote from option ${optionIndex + 1} in poll ${poll.id}`);
  } catch (error) {
    console.error('[Poll] Failed to handle reaction remove:', error);
  }
}
