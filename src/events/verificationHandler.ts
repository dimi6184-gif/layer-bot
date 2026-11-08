import {
  ButtonInteraction,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  EmbedBuilder,
  ModalSubmitInteraction,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder,
} from 'discord.js';
import { randomBytes, randomInt } from 'node:crypto';
import { createCanvas } from 'canvas';
import { db, hashVerificationToken } from '../db.js';
import { getSafeAssignableRole } from '../utils/safeRoles.js';

// Store CAPTCHA codes temporarily (in production, use Redis)
const captchaCodes = new Map<string, { code: string; expires: number }>();

// Clean expired codes every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of captchaCodes.entries()) {
    if (value.expires < now) {
      captchaCodes.delete(key);
    }
  }
}, 5 * 60 * 1000);

export async function handleVerificationButton(interaction: ButtonInteraction) {
  // Acknowledge interaction immediately so Discord never times out
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: 64 }).catch(() => {});
  }

  const sendReply = async (payload: string | { content: string; components?: any[]; files?: any[] }) => {
    const data = typeof payload === 'string' ? { content: payload } : payload;
    if (interaction.deferred || interaction.replied) {
      return await interaction.editReply(data).catch((err) => console.error('[Verification] editReply error:', err));
    }
    return await interaction.reply({ ...data, flags: 64 }).catch((err) => console.error('[Verification] reply error:', err));
  };

  // Check if user is already verified
  const guild = await db.guild.findUnique({
    where: { discordId: interaction.guildId! },
    select: {
      verificationEnabled: true,
      verificationRoleId: true,
      verificationLogChannelId: true,
    },
  });

  if (!guild?.verificationEnabled) {
    await sendReply('❌ Verification is currently disabled.');
    return;
  }

  if (!guild.verificationRoleId) {
    await sendReply('❌ Verification role not configured.');
    return;
  }

  // Check if server is currently under automated raid lockdown
  const { isRaidActive } = await import('../utils/antiRaid.js');
  if (interaction.guildId && isRaidActive(interaction.guildId)) {
    await sendReply('🛡️ **Verification Temporarily Paused**\n\nThe server is currently under automated raid protection due to a traffic spike.\n\nVerification will automatically resume in a few minutes once traffic normalizes.');
    return;
  }

  const member = interaction.member as any;
  if (member?.roles?.cache?.has(guild.verificationRoleId)) {
    await sendReply('✅ **Verification Successful**\n\nYou are already verified and have full access to the server!');
    return;
  }

  // Always issue a fresh browser challenge. This keeps the ban-evasion check
  // and role assignment on one path; an existing fingerprint must not bypass it.
  // Generate a 10-minute secure link
  try {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await db.verificationChallenge.deleteMany({ where: { expiresAt: { lte: new Date() } } });
    await db.verificationChallenge.create({
      data: {
        tokenHash: hashVerificationToken(token),
        userId: interaction.user.id,
        guildId: interaction.guildId!,
        interactionToken: interaction.token,
        expiresAt,
      },
    });

    const baseUrl = (process.env.WEB_APP_URL || 'https://www.uselayer.de').replace(/\/$/, '');
    const verificationUrl = `${baseUrl}/verify/${interaction.guildId}/${interaction.user.id}#token=${encodeURIComponent(token)}`;

    const openVerification = new ButtonBuilder()
      .setLabel('Verify in Browser')
      .setStyle(ButtonStyle.Link)
      .setURL(verificationUrl);

    await sendReply({
      content: '🔒 **Verification Request**\n\nTo access this server, please complete the verification in your browser.\n\n-# ⏳ This personalized link expires in **10 minutes**.',
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(openVerification)],
    });
  } catch (error) {
    console.error('[Verification] Could not create secure verification link:', error);
    await sendReply('❌ Secure device verification is temporarily unavailable. Please contact a server moderator.');
  }
}

export async function handleCaptchaOpenButton(interaction: ButtonInteraction) {
  const stored = captchaCodes.get(`${interaction.guildId}-${interaction.user.id}`);
  if (!stored || stored.expires < Date.now()) {
    await interaction.reply({ content: '❌ CAPTCHA expired. Please press Verify again.', flags: 64 });
    return;
  }

  const captchaInput = new TextInputBuilder()
    .setCustomId('captcha_code')
    .setLabel('Code from the image')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(6)
    .setMaxLength(6);

  const modal = new ModalBuilder()
    .setCustomId('verification:captcha')
    .setTitle('Verification - CAPTCHA')
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(captchaInput));

  await interaction.showModal(modal);
}

export async function handleVerificationModal(interaction: ModalSubmitInteraction) {
  await interaction.deferReply({ flags: 64 }); // Ephemeral flag

  const key = `${interaction.guildId}-${interaction.user.id}`;
  const stored = captchaCodes.get(key);

  if (!stored || stored.expires < Date.now()) {
    await interaction.editReply('❌ CAPTCHA expired. Please press Verify again.');
    return;
  }

  const userCode = interaction.fields.getTextInputValue('captcha_code').toUpperCase();

  if (userCode !== stored.code) {
    captchaCodes.delete(key);
    await interaction.editReply('❌ Incorrect code. Please press Verify again for a new one.');
    return;
  }

  captchaCodes.delete(key);

  const guild = await db.guild.findUnique({
    where: { discordId: interaction.guildId! },
    select: {
      verificationRoleId: true,
      verificationLogChannelId: true,
    },
  });

  if (!guild?.verificationRoleId) {
    await interaction.editReply('❌ Verification role not configured.');
    return;
  }

  await verifyMember(interaction, guild.verificationRoleId, guild.verificationLogChannelId);
}

async function verifyMember(
  interaction: ButtonInteraction | ModalSubmitInteraction,
  roleId: string,
  logChannelId?: string | null
) {
  const member = interaction.member as any;

  try {
    const evasionResult = await import('../utils/banEvasionDetector.js')
      .then(({ BanEvasionDetector }) => BanEvasionDetector.analyzeUser(
        interaction.user.id,
        interaction.guildId!,
        undefined,
        interaction.user.tag,
        interaction.user.createdAt,
        member?.joinedAt ?? undefined,
      ));
    if (evasionResult && evasionResult.linkScore >= 70) {
      const evasionSettings = await db.guild.findUnique({
        where: { discordId: interaction.guildId! },
        select: { banEvasionLogChannelId: true },
      });
      const alertChannelId = evasionSettings?.banEvasionLogChannelId || logChannelId;
      await db.auditLog.create({
        data: {
          guildId: interaction.guildId!,
          action: 'BAN_EVASION_REVIEW_REQUIRED',
          userId: interaction.user.id,
          userName: interaction.user.tag,
          details: evasionResult.bannedUser
            ? `Possible ban-evasion link (score ${evasionResult.linkScore}; not a probability)`
            : `Possible shared-device account link (score ${evasionResult.linkScore}; review required)`,
          metadata: {
            score: evasionResult.linkScore,
            linkedUserId: evasionResult.bannedUser?.id || evasionResult.linkedUser?.id || null,
            matchType: evasionResult.bannedUser ? 'banned_account' : 'shared_device',
            signals: evasionResult.signals,
          },
        },
      }).catch(() => {});
      if (alertChannelId) {
        const reviewChannel = await interaction.guild?.channels.fetch(alertChannelId).catch(() => null);
        if (reviewChannel?.isTextBased()) {
          const matchLabel = evasionResult.bannedUser ? 'possible ban evasion' : 'possible account link from a shared device';
          const linkedAccount = evasionResult.bannedUser || evasionResult.linkedUser;
          const linkedText = linkedAccount ? ` Possible related account: <@${linkedAccount.id}>.` : '';
          await reviewChannel.send(`⚠️ Layer flagged ${interaction.user} for ${matchLabel} (link score ${evasionResult.linkScore}/100; not a probability).${linkedText} This may be a shared device, so please review before taking action. Verification is paused for moderator review.`).catch(() => {});
        }
      }
      const reviewMessage = 'Verification is paused while the server team reviews a possible account link. Shared devices can cause a match, so please contact a moderator if this is a mistake.';
      if (interaction.deferred || interaction.replied) await interaction.editReply(reviewMessage).catch(() => {});
      else await interaction.reply({ content: reviewMessage, flags: 64 }).catch(() => {});
      return;
    }

    const role = interaction.guild ? await getSafeAssignableRole(interaction.guild, roleId) : null;
    if (!role) throw new Error(`Verification role ${roleId} is missing or too privileged to assign automatically`);
    await member.roles.add(role);

    // Reply based on interaction type and state
    const successMessage = '✅ **Verification Successful**\n\nYour account has been verified and your role has been assigned. You now have full access to the server! Welcome!';
    
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(successMessage);
    } else {
      await interaction.reply({
        content: successMessage,
        flags: 64, // Ephemeral flag
      });
    }

    // Log to audit
    await db.auditLog.create({
      data: {
        guildId: interaction.guildId!,
        action: 'USER_VERIFIED',
        userId: interaction.user.id,
        userName: interaction.user.tag,
        details: `${interaction.user.tag} verified successfully`,
        metadata: { roleId },
      },
    });

    // Log to channel if configured
    if (logChannelId) {
      try {
        const logChannel = await interaction.guild?.channels.fetch(logChannelId);
        if (logChannel?.isTextBased()) {
          const embed = new EmbedBuilder()
            .setColor(0x10b981)
            .setTitle('✅ User Verified')
            .setDescription(`${interaction.user} has been verified`)
            .addFields(
              { name: 'User', value: `${interaction.user.tag}`, inline: true },
              { name: 'User ID', value: interaction.user.id, inline: true }
            )
            .setTimestamp();

          await logChannel.send({ embeds: [embed] });
        }
      } catch (error) {
        console.error('[Verification] Failed to log to channel:', error);
      }
    }
  } catch (error) {
    console.error('[Verification] Error adding role:', error);
    const errorMsg = '❌ Failed to verify. Please contact an administrator.';
    
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(errorMsg);
      } else {
        await interaction.reply({
          content: errorMsg,
          flags: 64, // Ephemeral flag
        });
      }
    } catch (replyError) {
      console.error('[Verification] Error sending error message:', replyError);
    }
  }
}

function generateCaptchaCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(randomInt(chars.length));
  }
  return code;
}

function renderCaptchaImage(code: string): Buffer {
  const width = 320;
  const height = 110;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#1e1f26';
  ctx.fillRect(0, 0, width, height);

  for (let i = 0; i < 8; i++) {
    ctx.strokeStyle = `hsla(${randomInt(360)}, 60%, 60%, 0.5)`;
    ctx.lineWidth = 1 + randomInt(3);
    ctx.beginPath();
    ctx.moveTo(randomInt(width), randomInt(height));
    ctx.bezierCurveTo(randomInt(width), randomInt(height), randomInt(width), randomInt(height), randomInt(width), randomInt(height));
    ctx.stroke();
  }
  for (let i = 0; i < 160; i++) {
    ctx.fillStyle = `rgba(255, 255, 255, ${(randomInt(30) + 10) / 100})`;
    ctx.fillRect(randomInt(width), randomInt(height), 2, 2);
  }

  ctx.textBaseline = 'middle';
  const step = (width - 40) / code.length;
  for (let i = 0; i < code.length; i++) {
    ctx.save();
    ctx.translate(26 + step * i + randomInt(8), height / 2 + randomInt(20) - 10);
    ctx.rotate(((randomInt(50) - 25) * Math.PI) / 180);
    ctx.font = `bold ${38 + randomInt(10)}px sans-serif`;
    ctx.fillStyle = `hsl(${randomInt(360)}, 70%, 75%)`;
    ctx.fillText(code[i], 0, 0);
    ctx.restore();
  }

  return canvas.toBuffer('image/png');
}
