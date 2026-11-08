import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  AutocompleteInteraction,
  PermissionFlagsBits,
} from 'discord.js';
import { dangerCV2, warnCV2 } from '../../utils/cv2.js';
import { parseDuration, saveTempBan, removeTempBan } from '../../utils/tempBan.js';
import { db } from '../../db.js';
import { getEnabledBanAppealUrl, markBanAppealDmSent } from '../../utils/banAppeals.js';
import { checkModerationHierarchy } from '../../utils/hierarchy.js';

export const data = new SlashCommandBuilder()
  .setName('ban')
  .setDescription('Bans a user from the server permanently or temporarily.')
  .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
  .addUserOption((o) => o.setName('user').setDescription('The user to ban.').setRequired(true))
  .addStringOption((o) =>
    o
      .setName('duration')
      .setDescription('Ban duration (e.g. 1h, 1d, 7d, 30d). Leave empty for permanent.')
      .setAutocomplete(true)
  )
  .addStringOption((o) => o.setName('reason').setDescription('Reason for the ban.'));

const DURATION_PRESETS = [
  { name: '1 Hour (1h)', value: '1h' },
  { name: '6 Hours (6h)', value: '6h' },
  { name: '12 Hours (12h)', value: '12h' },
  { name: '1 Day (1d)', value: '1d' },
  { name: '3 Days (3d)', value: '3d' },
  { name: '7 Days (1 Week)', value: '7d' },
  { name: '14 Days (2 Weeks)', value: '14d' },
  { name: '30 Days (1 Month)', value: '30d' },
  { name: 'Permanent (No expiry)', value: 'permanent' },
];

export async function autocomplete(interaction: AutocompleteInteraction) {
  const focusedValue = interaction.options.getFocused().trim().toLowerCase();

  if (!focusedValue) {
    return interaction.respond(DURATION_PRESETS);
  }

  // Check if user is typing a custom number like "5"
  const numMatch = focusedValue.match(/^(\d+)$/);
  if (numMatch) {
    const n = numMatch[1];
    return interaction.respond([
      { name: `${n} Days (${n}d)`, value: `${n}d` },
      { name: `${n} Hours (${n}h)`, value: `${n}h` },
      { name: `${n} Weeks (${n}w)`, value: `${n}w` },
      { name: `${n} Months (${n}mo)`, value: `${n}mo` },
    ]);
  }

  const filtered = DURATION_PRESETS.filter(
    (preset) =>
      preset.name.toLowerCase().includes(focusedValue) ||
      preset.value.toLowerCase().includes(focusedValue)
  );

  return interaction.respond(
    filtered.length > 0
      ? filtered.slice(0, 25)
      : [{ name: `Custom Duration: "${focusedValue}"`, value: focusedValue }]
  );
}

export async function execute(interaction: ChatInputCommandInteraction) {
  // Acknowledge interaction immediately to prevent Discord 3-second 10062 timeout
  await interaction.deferReply();

  const target = interaction.options.getUser('user', true);
  const durationInput = interaction.options.getString('duration');
  const reason = interaction.options.getString('reason') ?? 'No reason provided.';
  const guild = interaction.guild!;

  if (target.id === interaction.user.id) {
    return interaction.editReply(
      dangerCV2({ title: '❌ Cannot ban yourself' })
    );
  }

  if (target.id === interaction.client.user?.id) {
    return interaction.editReply(
      dangerCV2({ title: '❌ Cannot ban the bot' })
    );
  }

  // Parse duration if provided
  const duration = parseDuration(durationInput);
  if (duration === undefined) {
    return interaction.editReply(
      warnCV2({
        title: '❌ Invalid Duration Format',
        description:
          'Please enter a valid duration or pick one from the suggestions.\n\n' +
          '**Supported examples:**\n' +
          '• `1h` (1 hour)\n' +
          '• `12h` (12 hours)\n' +
          '• `1d` (1 day)\n' +
          '• `7d` (7 days / 1 week)\n' +
          '• `30d` (30 days)\n' +
          '• `permanent` (no expiration)',
      })
    );
  }

  // Fetch member if present on the server
  let member = guild.members.cache.get(target.id);
  if (!member) {
    try {
      member = await guild.members.fetch(target.id);
    } catch {}
  }

  const hierarchyError = await checkModerationHierarchy(guild, interaction.user.id, member ?? null);
  if (hierarchyError) {
    return interaction.editReply(dangerCV2({ title: '❌ Permission Denied', description: hierarchyError }));
  }

  if (member && !member.bannable) {
    return interaction.editReply(
      dangerCV2({
        title: '❌ Permission Denied',
        description: 'I do not have high enough role hierarchy permissions to ban this user.',
      })
    );
  }

  const isTempBan = duration !== null;
  const expiresAt = isTempBan ? new Date(Date.now() + duration.ms) : null;
  const expiresUnix = expiresAt ? Math.floor(expiresAt.getTime() / 1000) : null;

  // Build DM notification fields
  const dmFields = [
    { label: 'Server', value: guild.name },
    { label: 'Reason', value: reason },
    { label: 'Moderator', value: interaction.user.tag },
    {
      label: 'Duration',
      value: isTempBan
        ? `${duration.text} (Expires <t:${expiresUnix}:R>)`
        : 'Permanent',
    },
  ];

  const appealLink = await getEnabledBanAppealUrl(guild.id).catch(() => null);
  if (appealLink) {
    dmFields.push({ label: 'Submit an Appeal', value: appealLink });
    // The GuildBanAdd event also sends appeal links for manual Discord bans.
    // Avoid sending a duplicate DM for this slash command.
    markBanAppealDmSent(guild.id, target.id);
  }

  if (isTempBan && expiresUnix) {
    dmFields.push({
      label: 'Unban Date',
      value: `<t:${expiresUnix}:F>`,
    });
  }

  // Try to DM user before ban with a 1.5s timeout so slow DMs never stall the interaction
  try {
    await Promise.race([
      target.send(
        dangerCV2({
          title: isTempBan ? '⏳ You have been temporarily banned' : '🔨 You have been banned',
          description: `You have been banned from **${guild.name}**.`,
          fields: dmFields,
        })
      ),
      new Promise((_, reject) => setTimeout(() => reject(new Error('DM timeout')), 1500)),
    ]);
  } catch {
    // Ignore if user has DMs closed or timeout reached
  }

  // Execute ban
  const banReason = isTempBan
    ? `[Temp-Ban ${duration.text}] ${reason}`
    : reason;

  try {
    if (member) {
      await member.ban({ reason: banReason });
    } else {
      await guild.bans.create(target.id, { reason: banReason });
    }
  } catch (err: any) {
    return interaction.editReply(
      dangerCV2({
        title: '❌ Ban Failed',
        description: `Failed to ban user: ${err?.message || 'Unknown error'}`,
      })
    );
  }

  // Update DB state
  if (isTempBan && expiresAt) {
    await saveTempBan(guild.id, target.id, expiresAt, reason).catch((err) => {
      console.error('[Ban] Failed to save temporary ban in DB:', err);
    });
  } else {
    await removeTempBan(guild.id, target.id).catch(() => {});
  }

  // Log to audit log
  await db.auditLog.create({
    data: {
      guildId: guild.id,
      action: isTempBan ? 'TEMPBAN' : 'BAN',
      userId: target.id,
      userName: target.tag,
      details: reason,
      metadata: {
        moderatorId: interaction.user.id,
        moderatorTag: interaction.user.tag,
        isTempBan,
        duration: isTempBan ? duration.text : 'permanent',
        expiresAt: expiresAt ? expiresAt.toISOString() : null,
      },
    },
  }).catch(() => {});

  // Build reply fields
  const replyFields = [
    { label: 'User', value: `${target.tag} \`${target.id}\`` },
    { label: 'Moderator', value: interaction.user.tag },
    {
      label: 'Duration',
      value: isTempBan
        ? `${duration.text} • <t:${expiresUnix}:R>`
        : 'Permanent',
    },
  ];

  if (isTempBan && expiresUnix) {
    replyFields.push({
      label: 'Automatic Unban',
      value: `<t:${expiresUnix}:F>`,
    });
  }

  replyFields.push({ label: 'Reason', value: reason });

  await interaction.editReply(
    dangerCV2({
      title: isTempBan ? '⏳ User temporarily banned' : '🔨 User banned',
      thumbnail: target.displayAvatarURL({ size: 64 }),
      fields: replyFields,
    })
  );
}
