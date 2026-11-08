import { ButtonInteraction, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { db } from '../db.js';
import { xpToLevel } from '../commands/leveling/rank.js';
import { getGuildEmbedColor } from '../utils/embedColor.js';

export async function handleGiveawayEnter(interaction: ButtonInteraction) {
  const giveaway = await db.giveaway.findFirst({
    where: {
      guildId: interaction.guildId!,
      messageId: interaction.message.id,
      ended: false,
    },
  });

  if (!giveaway) {
    return interaction.reply({
      content: '❌ This giveaway has ended or was not found!',
      flags: 64,
    });
  }

  // Fetch guild settings for custom emoji
  const guildSettings = await db.guild.findUnique({
    where: { discordId: interaction.guildId! },
    select: { customGiveawayEmoji: true },
  });

  const giveawayEmoji = guildSettings?.customGiveawayEmoji || '🎉';

  // Check if already entered
  if (giveaway.participants.includes(interaction.user.id)) {
    // Remove participant (toggle off). array_remove changes only this user's entry,
    // so a stale copy of the list cannot erase entries made in the meantime.
    await db.$executeRaw`UPDATE "Giveaway" SET "participants" = array_remove("participants", ${interaction.user.id}), "updatedAt" = NOW() WHERE "id" = ${giveaway.id}`;

    // Update message with new participant count
    try {
      const message = interaction.message;
      const newParticipantCount = giveaway.participants.length - 1;

      const updatedGiveaway = await db.giveaway.findUnique({
        where: { id: giveaway.id },
      });

      if (updatedGiveaway) {
        const endsAtTimestamp = Math.floor(updatedGiveaway.endsAt.getTime() / 1000);

        // Build requirements text
        const requirements: string[] = [];
        if (updatedGiveaway.requiredRoleIds.length > 0)
          requirements.push(`• Role: ${updatedGiveaway.requiredRoleIds.map((id) => `<@&${id}>`).join(', ')}`);
        if (updatedGiveaway.requiredLevel) requirements.push(`• Level: ${updatedGiveaway.requiredLevel}+`);
        if (updatedGiveaway.requireBoost) requirements.push(`• Must be a Server Booster`);
        if (updatedGiveaway.blacklistedRoleIds.length > 0)
          requirements.push(`• Cannot have role: ${updatedGiveaway.blacklistedRoleIds.map((id) => `<@&${id}>`).join(', ')}`);

        // Use classic embed for editing old messages (Components v2 can't be edited)
        let description = (updatedGiveaway.description ? `${updatedGiveaway.description}\n\n` : '') +
          `**Winners:** ${updatedGiveaway.winnerCount}\n` +
          `**Ends:** <t:${endsAtTimestamp}:R> (<t:${endsAtTimestamp}:f>)\n` +
          `**Hosted by:** <@${updatedGiveaway.hostId}>\n` +
          `**Participants:** ${newParticipantCount}`;

        if (requirements.length > 0) {
          description += `\n\n**Requirements:**\n${requirements.join('\n')}`;
        }

        const embed = new EmbedBuilder()
          .setColor(await getGuildEmbedColor(updatedGiveaway.guildId))
          .setTitle('🎉 GIVEAWAY')
          .setDescription(`**${updatedGiveaway.prize}**\n\n${description}`)
          .setFooter({
            text: `${updatedGiveaway.winnerCount} winner${updatedGiveaway.winnerCount > 1 ? 's' : ''} • Ends ${updatedGiveaway.endsAt.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })} at ${updatedGiveaway.endsAt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`
          });

        const button = new ButtonBuilder()
          .setCustomId('giveaway:enter')
          .setLabel('Enter Giveaway')
          .setEmoji(giveawayEmoji)
          .setStyle(ButtonStyle.Success);

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(button);

        await message.edit({
          embeds: [embed],
          components: [row],
        });
      }
    } catch (error) {
      console.error('[Giveaway] Failed to update message:', error);
    }

    return interaction.reply({
      content: '❌ You have left the giveaway!',
      flags: 64,
    });
  }

  const member = interaction.member as any;

  // Check requirements
  // 1. Required roles
  if (giveaway.requiredRoleIds.length > 0) {
    const hasRole = giveaway.requiredRoleIds.some((roleId) => member.roles.cache.has(roleId));
    if (!hasRole) {
      const roleNames = giveaway.requiredRoleIds
        .map((id) => `<@&${id}>`)
        .join(', ');
      return interaction.reply({
        content: `❌ You need one of these roles to enter: ${roleNames}`,
        flags: 64,
      });
    }
  }

  // 2. Blacklisted roles
  if (giveaway.blacklistedRoleIds.length > 0) {
    const hasBlacklistedRole = giveaway.blacklistedRoleIds.some((roleId) => member.roles.cache.has(roleId));
    if (hasBlacklistedRole) {
      return interaction.reply({
        content: '❌ You cannot enter this giveaway due to role restrictions!',
        flags: 64,
      });
    }
  }

  // 3. Server boost requirement
  if (giveaway.requireBoost) {
    if (!member.premiumSince) {
      return interaction.reply({
        content: '❌ You must be a Server Booster to enter this giveaway!',
        flags: 64,
      });
    }
  }

  // 4. Level requirement
  if (giveaway.requiredLevel) {
    const guildMember = await db.guildMember.findUnique({
      where: {
        userId_guildId: {
          userId: interaction.user.id,
          guildId: interaction.guildId!,
        },
      },
    });

    const userLevel = guildMember ? xpToLevel(guildMember.xp) : 0;

    if (userLevel < giveaway.requiredLevel) {
      return interaction.reply({
        content: `❌ You need to be at least level ${giveaway.requiredLevel} to enter! (You are level ${userLevel})`,
        flags: 64,
      });
    }
  }

  // Add participant once, even if the button is clicked twice at the same moment
  await db.$executeRaw`UPDATE "Giveaway" SET "participants" = array_append("participants", ${interaction.user.id}), "updatedAt" = NOW() WHERE "id" = ${giveaway.id} AND NOT (${interaction.user.id} = ANY("participants"))`;

  // Update message with new participant count
  try {
    const message = interaction.message;
    const newParticipantCount = giveaway.participants.length + 1;

    const updatedGiveaway = await db.giveaway.findUnique({
      where: { id: giveaway.id },
    });

    if (updatedGiveaway) {
      const endsAtTimestamp = Math.floor(updatedGiveaway.endsAt.getTime() / 1000);

      // Build requirements text
      const requirements: string[] = [];
      if (updatedGiveaway.requiredRoleIds.length > 0)
        requirements.push(`• Role: ${updatedGiveaway.requiredRoleIds.map((id) => `<@&${id}>`).join(', ')}`);
      if (updatedGiveaway.requiredLevel) requirements.push(`• Level: ${updatedGiveaway.requiredLevel}+`);
      if (updatedGiveaway.requireBoost) requirements.push(`• Must be a Server Booster`);
      if (updatedGiveaway.blacklistedRoleIds.length > 0)
        requirements.push(`• Cannot have role: ${updatedGiveaway.blacklistedRoleIds.map((id) => `<@&${id}>`).join(', ')}`);

      // Use classic embed for editing old messages (Components v2 can't be edited)
      let description = (updatedGiveaway.description ? `${updatedGiveaway.description}\n\n` : '') +
        `**Winners:** ${updatedGiveaway.winnerCount}\n` +
        `**Ends:** <t:${endsAtTimestamp}:R> (<t:${endsAtTimestamp}:f>)\n` +
        `**Hosted by:** <@${updatedGiveaway.hostId}>\n` +
        `**Participants:** ${newParticipantCount}`;

      if (requirements.length > 0) {
        description += `\n\n**Requirements:**\n${requirements.join('\n')}`;
      }

      const embed = new EmbedBuilder()
        .setColor(await getGuildEmbedColor(updatedGiveaway.guildId))
        .setTitle('🎉 GIVEAWAY')
        .setDescription(`**${updatedGiveaway.prize}**\n\n${description}`)
        .setFooter({
          text: `${updatedGiveaway.winnerCount} winner${updatedGiveaway.winnerCount > 1 ? 's' : ''} • Ends ${updatedGiveaway.endsAt.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })} at ${updatedGiveaway.endsAt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`
        });

      const button = new ButtonBuilder()
        .setCustomId('giveaway:enter')
        .setLabel('Enter Giveaway')
        .setEmoji(giveawayEmoji)
        .setStyle(ButtonStyle.Success);

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(button);

      await message.edit({
        embeds: [embed],
        components: [row],
      });
    }
  } catch (error) {
    console.error('[Giveaway] Failed to update message:', error);
  }

  await interaction.reply({
    content: '🎉 You have successfully entered the giveaway! Good luck!',
    flags: 64,
  });
}
