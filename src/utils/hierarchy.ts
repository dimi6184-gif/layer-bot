import type { Guild, GuildMember } from 'discord.js';

/**
 * Discord only checks the bot's role against the target. This checks the human
 * invoker: the owner may act on anyone, everyone else only on members ranked below them.
 * Returns an error message, or null when the action is allowed.
 */
export async function checkModerationHierarchy(guild: Guild, invokerId: string, target: GuildMember | null): Promise<string | null> {
  if (!target) return null;
  if (target.id === guild.ownerId) return 'You cannot moderate the server owner.';
  if (invokerId === guild.ownerId) return null;

  const invoker = await guild.members.fetch(invokerId).catch(() => null);
  if (!invoker) return 'Could not verify your roles. Please try again.';
  if (invoker.roles.highest.comparePositionTo(target.roles.highest) <= 0) {
    return 'You can only moderate members whose highest role is below yours.';
  }
  return null;
}
