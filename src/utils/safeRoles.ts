import { PermissionFlagsBits, type Guild, type Role } from 'discord.js';

// Roles the bot hands out automatically (verification, auto roles, level rewards) are
// configured by dashboard users who may not hold these permissions themselves.
const PRIVILEGED_PERMISSIONS = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageWebhooks,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.ModerateMembers,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.MentionEveryone,
  PermissionFlagsBits.ManageNicknames,
  PermissionFlagsBits.ManageGuildExpressions,
  PermissionFlagsBits.ManageEvents,
  PermissionFlagsBits.ManageThreads,
  PermissionFlagsBits.ViewAuditLog,
];

/** Returns the role only when it is safe for the bot to grant automatically. */
export async function getSafeAssignableRole(guild: Guild, roleId: string): Promise<Role | null> {
  if (!/^\d{17,20}$/.test(roleId) || roleId === guild.id) return null;
  const role = guild.roles.cache.get(roleId) ?? (await guild.roles.fetch(roleId).catch(() => null));
  if (!role || role.managed) return null;
  if (PRIVILEGED_PERMISSIONS.some((permission) => role.permissions.has(permission))) {
    console.warn(`[Roles] Refused to auto-assign privileged role ${role.id} in guild ${guild.id}`);
    return null;
  }
  const me = guild.members.me;
  if (me && role.comparePositionTo(me.roles.highest) >= 0) return null;
  return role;
}
