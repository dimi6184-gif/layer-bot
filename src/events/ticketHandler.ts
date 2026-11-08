import {
  ButtonInteraction,
  StringSelectMenuInteraction,
  ModalSubmitInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ChannelType,
  PermissionFlagsBits,
  TextChannel,
  OverwriteType,
  Guild,
  GuildMember,
  AttachmentBuilder,
} from 'discord.js';
import { createTranscript, ExportReturnType } from 'discord-transcript-v2';

/**
 * discord-transcript-v2 writes member names with JSON.stringify into an inline <script>,
 * so a nickname containing "</script>" could break out of it. Escape "<" inside that
 * block. Its end is the CDN script that follows, a string longer than any Discord name.
 */
function sanitizeTranscriptHtml(html: string): string {
  const start = html.indexOf('window.$discordMessage={profiles:');
  if (start === -1) return html;
  const end = html.indexOf('</script><script type="module" src="https://cdn.jsdelivr.net/npm/@derockdev/', start);
  if (end === -1) return html.slice(0, start) + '</script>';
  return html.slice(0, start) + html.slice(start, end).replace(/</g, '\\u003c') + html.slice(end);
}
import { db } from '../db.js';

interface PanelConfig {
  id: string;
  name?: string;
  maxTicketsPerUser: number;
  mentionTeam: boolean;
  channelNameFormat: string;
  showCapacity: boolean;
  onlyTeamCanClose: boolean;
  creatorCanAddUsers: boolean;
  onCreatorLeave: 'nothing' | 'close' | 'delete';
  openingHoursEnabled: boolean;
  openingHours: string[];
  categoryId: string | null;
  supportRoleIds: string[];
  color: string;
  transcriptEnabled: boolean;
  transcriptChannelId: string | null;
}

export function getPanelConfig(settings: any, panelId?: string): PanelConfig {
  const panels: any[] = (settings?.ticketPanels as any[]) || [];
  let panel = panels.find((p: any) => p.id === panelId);
  if (!panel && panels.length > 0) {
    panel = panels[0];
  }

  return {
    id: panel?.id || 'default',
    name: panel?.name || 'Support Panel',
    maxTicketsPerUser: typeof panel?.maxTicketsPerUser === 'number' ? panel.maxTicketsPerUser : 1,
    mentionTeam: panel?.mentionTeam !== false,
    channelNameFormat: panel?.channelNameFormat || 'ticket-%USERNAME%',
    showCapacity: !!panel?.showCapacity,
    onlyTeamCanClose: !!panel?.onlyTeamCanClose,
    creatorCanAddUsers: !!panel?.creatorCanAddUsers,
    onCreatorLeave: (panel?.onCreatorLeave || 'nothing') as 'nothing' | 'close' | 'delete',
    openingHoursEnabled: !!panel?.openingHoursEnabled,
    openingHours: (panel?.openingHours || []) as string[],
    categoryId: panel?.categoryId || settings?.ticketCategoryId || null,
    supportRoleIds: (panel?.supportRoleIds?.length ? panel.supportRoleIds : settings?.ticketSupportRoleIds) || [],
    color: panel?.color || settings?.ticketPanelColor || '#1FA7BB',
    transcriptEnabled: panel?.transcriptEnabled ?? settings?.ticketTranscriptEnabled ?? false,
    transcriptChannelId: panel?.transcriptChannelId || settings?.ticketTranscriptChannelId || null,
  };
}

function checkOperatingHours(hours: string[] | undefined): { inside: boolean; notice?: string } {
  if (!hours || hours.length === 0) return { inside: true };

  const now = new Date();
  const utcDay = now.getUTCDay(); // 0 = Sun, 1 = Mon ...
  const currentMins = now.getUTCHours() * 60 + now.getUTCMinutes();
  const dayMap: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

  let matchedAny = false;
  let isInside = false;

  for (const slot of hours) {
    const match = slot.match(/(Mon|Tue|Wed|Thu|Fri|Sat|Sun)-(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/i);
    if (match) {
      matchedAny = true;
      const startDay = dayMap[match[1].toLowerCase()];
      const endDay = dayMap[match[2].toLowerCase()];
      const startMins = parseInt(match[3], 10) * 60 + parseInt(match[4], 10);
      const endMins = parseInt(match[5], 10) * 60 + parseInt(match[6], 10);

      let inDay = false;
      if (startDay <= endDay) {
        inDay = utcDay >= startDay && utcDay <= endDay;
      } else {
        inDay = utcDay >= startDay || utcDay <= endDay;
      }

      if (inDay && currentMins >= startMins && currentMins <= endMins) {
        isInside = true;
        break;
      }
    }
  }

  if (matchedAny && !isInside) {
    return {
      inside: false,
      notice: `The support team is currently outside operating hours (${hours.join(', ')}). Your ticket is logged and staff will reply once available.`,
    };
  }

  return { inside: true };
}

function formatTicketChannelName(
  format: string | undefined,
  data: {
    username: string;
    userId: string;
    displayName: string;
    nickname: string;
    ticketNumber: string;
    caseId: string;
    prefix: string;
    emote: string;
  }
) {
  const tpl = format || 'ticket-%USERNAME%';
  let name = tpl
    .replace(/%CASEID%/gi, data.caseId)
    .replace(/%TICKET_NUMBER%/gi, data.ticketNumber)
    .replace(/%PREFIX%/gi, data.prefix)
    .replace(/%USERNAME%/gi, data.username)
    .replace(/%USER_ID%/gi, data.userId)
    .replace(/%USER_NICK_NAME%/gi, data.nickname)
    .replace(/%DISPLAY_NAME%/gi, data.displayName)
    .replace(/%EMOTE%/gi, data.emote);

  // Discord channel name formatting: lowercase, alphanumeric and dashes, max 95 chars
  name = name.toLowerCase().replace(/[^a-z0-9-_]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return name.slice(0, 95) || `ticket-${data.username}`;
}

async function getUserOpenTicketChannels(guild: Guild, userId: string): Promise<TextChannel[]> {
  const openEntries = await db.ticketAnalytics.findMany({
    where: {
      guildId: guild.id,
      userId,
      closedAt: null,
    },
    select: { ticketId: true },
  });

  const activeChannels: TextChannel[] = [];
  for (const entry of openEntries) {
    const channel = guild.channels.cache.get(entry.ticketId) as TextChannel | undefined;
    if (channel) {
      activeChannels.push(channel);
    } else {
      // Channel was removed outside the bot; close analytics entry
      await db.ticketAnalytics.updateMany({
        where: { ticketId: entry.ticketId },
        data: { closedAt: new Date() },
      }).catch(() => {});
    }
  }
  return activeChannels;
}

export async function handleTicketButton(interaction: ButtonInteraction | StringSelectMenuInteraction) {
  const { customId, guild, user, guildId } = interaction;
  if (!guild || !guildId) return;

  // ── Open via Dropdown Select Menu ──────────────────────────────────────────
  if (customId.startsWith('ticket:select_reason') && interaction.isStringSelectMenu()) {
    const parts = customId.split(':');
    const panelId = parts[2];
    const selectedReason = interaction.values[0];

    const settings = await (db.guild.findUnique as any)({
      where: { discordId: guildId },
    });

    const panels = (settings?.ticketPanels as any[]) || [];
    const panelConfig = getPanelConfig(settings, panelId);

    // Get reason details
    let reasons: any[] = [];
    if (panelId) {
      const p = panels.find((x: any) => x.id === panelId);
      if (p?.reasons) reasons = p.reasons;
    }
    if (reasons.length === 0 && settings?.ticketReasons) {
      reasons = settings.ticketReasons as any[];
    }

    const reasonData = reasons?.find((r: any) => r.value === selectedReason);
    const reasonLabel = reasonData?.label || selectedReason;

    // Check open tickets limit per user
    const openChannels = await getUserOpenTicketChannels(guild, user.id);
    if (panelConfig.maxTicketsPerUser > 0 && openChannels.length >= panelConfig.maxTicketsPerUser) {
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor('#f97316')
            .setDescription(
              `❌ You have reached the maximum allowed open tickets (${panelConfig.maxTicketsPerUser}).\n\nPlease close your open ticket(s) first: ${openChannels.map(c => `<#${c.id}>`).join(', ')}`
            ),
        ],
        ephemeral: true,
      });
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      // Build permission overwrites
      const overwrites: any[] = [
        {
          id: guild.roles.everyone.id,
          deny: [PermissionFlagsBits.ViewChannel],
          type: OverwriteType.Role,
        },
        {
          id: user.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.AttachFiles,
            PermissionFlagsBits.EmbedLinks,
          ],
          type: OverwriteType.Member,
        },
      ];

      for (const roleId of panelConfig.supportRoleIds) {
        overwrites.push({
          id: roleId,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.ManageMessages,
            PermissionFlagsBits.AttachFiles,
            PermissionFlagsBits.EmbedLinks,
          ],
          type: OverwriteType.Role,
        });
      }

      const totalCount = await db.ticketAnalytics.count({ where: { guildId } });
      const ticketNumber = String(totalCount + 1).padStart(4, '0');
      const caseId = Date.now().toString().slice(-4);
      const member = await guild.members.fetch(user.id).catch(() => null);

      const channelName = formatTicketChannelName(panelConfig.channelNameFormat, {
        username: user.username,
        userId: user.id,
        displayName: member?.displayName || user.displayName || user.username,
        nickname: member?.nickname || user.username,
        ticketNumber,
        caseId,
        prefix: 'ticket',
        emote: 'ticket',
      });

      const ticketChannel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: panelConfig.categoryId || undefined,
        permissionOverwrites: overwrites,
        topic: `Creator: ${user.id} | Panel: ${panelConfig.id} | Reason: ${reasonLabel}`,
      });

      // Create ticket analytics entry
      await db.ticketAnalytics.create({
        data: {
          guildId,
          ticketId: ticketChannel.id,
          userId: user.id,
          userName: user.tag || user.username,
          category: reasonLabel,
          aiHandled: false,
          aiResolved: false,
          escalated: false,
          messageCount: 0,
          aiMessageCount: 0,
        },
      }).catch(() => {});

      const colorInt = parseInt(panelConfig.color.replace('#', ''), 16) || 0x1fa7bb;
      const hoursCheck = checkOperatingHours(panelConfig.openingHours);

      const { buildTicketWelcomeCV2 } = await import('../utils/cv2.js');
      const welcomePayload = buildTicketWelcomeCV2({
        reason: reasonLabel,
        userMention: `<@${user.id}>`,
        creatorTag: user.tag || user.username,
        accentColor: colorInt,
        closeCustomId: `ticket:close:${user.id}:${panelConfig.id}`,
        addUserCustomId: panelConfig.creatorCanAddUsers ? `ticket:adduser:${user.id}:${panelConfig.id}` : undefined,
        operatingHoursNotice: hoursCheck.inside ? undefined : hoursCheck.notice,
      });

      const mentionLine = (panelConfig.mentionTeam && panelConfig.supportRoleIds.length > 0)
        ? panelConfig.supportRoleIds.map((id: string) => `<@&${id}>`).join(' ')
        : '';

      await (ticketChannel as any).send({
        content: mentionLine || undefined,
        ...welcomePayload,
      });

      await db.ticketMessage.create({
        data: {
          guildId,
          ticketId: ticketChannel.id,
          userId: guild.client.user?.id || 'system',
          userName: '🤖 Ticket System',
          content: `🎫 **Ticket opened** by ${user.tag || user.username} for **${reasonLabel}**.\nSupport will be with you shortly.`,
          isAI: true,
        },
      }).catch(() => {});

      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor('#22c55e')
            .setDescription(`✅ Your ticket has been created: <#${ticketChannel.id}>`),
        ],
      });
    } catch (err) {
      console.error('[Ticket Open Error]', err);
      await interaction.editReply({
        embeds: [new EmbedBuilder().setColor('#ef4444').setDescription('❌ Failed to create ticket. Check bot permissions.')],
      });
    }
    return;
  }

  // ── Open via Button ─────────────────────────────────────────────────────────
  if (customId.startsWith('ticket:open') && interaction.isButton()) {
    const parts = customId.split(':');
    const panelId = parts[2];

    const settings = await (db.guild.findUnique as any)({
      where: { discordId: guildId },
    });

    const panelConfig = getPanelConfig(settings, panelId);

    // Check open tickets limit per user
    const openChannels = await getUserOpenTicketChannels(guild, user.id);
    if (panelConfig.maxTicketsPerUser > 0 && openChannels.length >= panelConfig.maxTicketsPerUser) {
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor('#f97316')
            .setDescription(
              `❌ You have reached the maximum allowed open tickets (${panelConfig.maxTicketsPerUser}).\n\nPlease close your open ticket(s) first: ${openChannels.map(c => `<#${c.id}>`).join(', ')}`
            ),
        ],
        ephemeral: true,
      });
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      const overwrites: any[] = [
        {
          id: guild.roles.everyone.id,
          deny: [PermissionFlagsBits.ViewChannel],
          type: OverwriteType.Role,
        },
        {
          id: user.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.AttachFiles,
            PermissionFlagsBits.EmbedLinks,
          ],
          type: OverwriteType.Member,
        },
      ];

      for (const roleId of panelConfig.supportRoleIds) {
        overwrites.push({
          id: roleId,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.ManageMessages,
            PermissionFlagsBits.AttachFiles,
            PermissionFlagsBits.EmbedLinks,
          ],
          type: OverwriteType.Role,
        });
      }

      const totalCount = await db.ticketAnalytics.count({ where: { guildId } });
      const ticketNumber = String(totalCount + 1).padStart(4, '0');
      const caseId = Date.now().toString().slice(-4);
      const member = await guild.members.fetch(user.id).catch(() => null);

      const channelName = formatTicketChannelName(panelConfig.channelNameFormat, {
        username: user.username,
        userId: user.id,
        displayName: member?.displayName || user.displayName || user.username,
        nickname: member?.nickname || user.username,
        ticketNumber,
        caseId,
        prefix: 'ticket',
        emote: 'ticket',
      });

      const ticketChannel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: panelConfig.categoryId || undefined,
        permissionOverwrites: overwrites,
        topic: `Creator: ${user.id} | Panel: ${panelConfig.id} | Reason: General Support`,
      });

      await db.ticketAnalytics.create({
        data: {
          guildId,
          ticketId: ticketChannel.id,
          userId: user.id,
          userName: user.tag || user.username,
          category: 'General Support',
          aiHandled: false,
          aiResolved: false,
          escalated: false,
          messageCount: 0,
          aiMessageCount: 0,
        },
      }).catch(() => {});

      const colorInt = parseInt(panelConfig.color.replace('#', ''), 16) || 0x1fa7bb;
      const hoursCheck = checkOperatingHours(panelConfig.openingHours);

      const { buildTicketWelcomeCV2 } = await import('../utils/cv2.js');
      const welcomePayload = buildTicketWelcomeCV2({
        reason: 'General Support',
        userMention: `<@${user.id}>`,
        creatorTag: user.tag || user.username,
        accentColor: colorInt,
        closeCustomId: `ticket:close:${user.id}:${panelConfig.id}`,
        addUserCustomId: panelConfig.creatorCanAddUsers ? `ticket:adduser:${user.id}:${panelConfig.id}` : undefined,
        operatingHoursNotice: hoursCheck.inside ? undefined : hoursCheck.notice,
      });

      const mentionLine = (panelConfig.mentionTeam && panelConfig.supportRoleIds.length > 0)
        ? panelConfig.supportRoleIds.map((id: string) => `<@&${id}>`).join(' ')
        : '';

      await (ticketChannel as any).send({
        content: mentionLine || undefined,
        ...welcomePayload,
      });

      await db.ticketMessage.create({
        data: {
          guildId,
          ticketId: ticketChannel.id,
          userId: guild.client.user?.id || 'system',
          userName: '🤖 Ticket System',
          content: `🎫 **Ticket opened** by ${user.tag || user.username} for **General Support**.\nSupport will be with you shortly.`,
          isAI: true,
        },
      }).catch(() => {});

      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor('#22c55e')
            .setDescription(`✅ Your ticket has been created: <#${ticketChannel.id}>`),
        ],
      });
    } catch (err) {
      console.error('[Ticket Open Error]', err);
      await interaction.editReply({
        embeds: [new EmbedBuilder().setColor('#ef4444').setDescription('❌ Failed to create ticket. Check bot permissions.')],
      });
    }
    return;
  }

  // ── Add User Modal Trigger ──────────────────────────────────────────────────
  if (customId.startsWith('ticket:adduser:') && interaction.isButton()) {
    const parts = customId.split(':');
    const creatorId = parts[2];
    const panelId = parts[3];

    const settings = await (db.guild.findUnique as any)({
      where: { discordId: guildId },
    });
    const panelConfig = getPanelConfig(settings, panelId);

    // Verify permission: creator or staff
    const member = await guild.members.fetch(user.id).catch(() => null);
    const isStaff = member?.permissions.has(PermissionFlagsBits.ManageChannels) ||
      member?.permissions.has(PermissionFlagsBits.Administrator) ||
      panelConfig.supportRoleIds.some((r: string) => member?.roles.cache.has(r));

    if (user.id !== creatorId && !isStaff) {
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor('#ef4444').setDescription('❌ You do not have permission to add users to this ticket.')],
        ephemeral: true,
      });
    }

    const modal = new ModalBuilder()
      .setCustomId(`ticket:modal_adduser:${interaction.channelId}`)
      .setTitle('Add User to Ticket');

    const input = new TextInputBuilder()
      .setCustomId('user_query')
      .setLabel('User ID or Username')
      .setPlaceholder('Enter User ID or exact username')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
    await interaction.showModal(modal);
    return;
  }

  // ── Close Ticket ─────────────────────────────────────────────────────────────
  if (customId.startsWith('ticket:close:') && interaction.isButton()) {
    const ticketChannel = interaction.channel as TextChannel;
    const parts = customId.split(':');
    const originalUserId = parts[2];
    const panelId = parts[3];

    const settings = await (db.guild.findUnique as any)({
      where: { discordId: guildId },
    });
    const panelConfig = getPanelConfig(settings, panelId);

    // Staff may always close. The creator may close unless "Only Staff Can Close" is on.
    // Anyone else who can see the ticket may not.
    const member = await guild.members.fetch(interaction.user.id).catch(() => null);
    const isStaff = member?.permissions.has(PermissionFlagsBits.ManageChannels) ||
      member?.permissions.has(PermissionFlagsBits.Administrator) ||
      panelConfig.supportRoleIds.some((r: string) => member?.roles.cache.has(r));
    const isCreator = interaction.user.id === originalUserId;

    if (!isStaff && (!isCreator || panelConfig.onlyTeamCanClose)) {
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor('#ef4444')
            .setDescription(isCreator
              ? '❌ Only staff members are allowed to close this ticket.'
              : '❌ Only staff or the ticket creator can close this ticket.'),
        ],
        ephemeral: true,
      });
    }

    const isTranscriptOn = panelConfig.transcriptEnabled && panelConfig.transcriptChannelId;

    const closingEmbed = new EmbedBuilder()
      .setColor('#ef4444')
      .setTitle('🔒 Ticket Closing...')
      .setDescription(
        isTranscriptOn
          ? 'Generating transcript... This ticket will be deleted shortly.'
          : 'This ticket will be deleted in 5 seconds.'
      )
      .setTimestamp();

    await interaction.reply({ embeds: [closingEmbed] });

    // Sync messages to db
    try {
      const fetchedMsgs = await ticketChannel.messages.fetch({ limit: 100 }).catch(() => null);
      if (fetchedMsgs) {
        for (const msg of Array.from(fetchedMsgs.values()).reverse()) {
          const content = msg.content || (msg.attachments.size > 0 ? `[${msg.attachments.size} attachment(s)]` : '');
          if (!content) continue;

          const exists = await db.ticketMessage.findFirst({
            where: {
              ticketId: ticketChannel.id,
              userId: msg.author.id,
              content,
            },
          });

          if (!exists) {
            await db.ticketMessage.create({
              data: {
                guildId,
                ticketId: ticketChannel.id,
                userId: msg.author.id,
                userName: msg.author.tag || msg.author.username,
                content,
                isAI: msg.author.bot,
                createdAt: msg.createdAt,
              },
            }).catch(() => {});
          }
        }
      }
    } catch (err) {
      console.error('[Ticket Transcript Sync Error]', err);
    }

    // Update ticket analytics
    const totalMsgs = await db.ticketMessage.count({
      where: { ticketId: ticketChannel.id },
    }).catch(() => 0);

    await db.ticketAnalytics.updateMany({
      where: { ticketId: ticketChannel.id },
      data: {
        closedAt: new Date(),
        messageCount: totalMsgs > 0 ? totalMsgs : undefined,
      },
    }).catch(() => {});

    // Generate and send transcript if enabled
    if (isTranscriptOn && panelConfig.transcriptChannelId) {
      try {
        const transcriptHtml = await createTranscript(ticketChannel, {
          limit: -1,
          saveImages: false,
          poweredBy: false,
          returnType: ExportReturnType.String,
        });
        const transcript = new AttachmentBuilder(Buffer.from(sanitizeTranscriptHtml(transcriptHtml), 'utf8'), {
          name: `transcript-${ticketChannel.id}.html`,
        });

        const transcriptChannel = await guild.channels.fetch(panelConfig.transcriptChannelId);
        if (transcriptChannel && transcriptChannel.isTextBased()) {
          const transcriptEmbed = new EmbedBuilder()
            .setColor('#1FA7BB')
            .setTitle('📝 Ticket Transcript')
            .setDescription(
              `**Ticket:** ${ticketChannel.name}\n` +
              `**Closed by:** ${interaction.user.tag || interaction.user.username}\n` +
              `**Closed at:** <t:${Math.floor(Date.now() / 1000)}:F>`
            )
            .setFooter({ text: 'Ticket closed' })
            .setTimestamp();

          await (transcriptChannel as TextChannel).send({
            embeds: [transcriptEmbed],
            files: [transcript],
          });
        }
      } catch (error) {
        console.error('[Transcript Error]', error);
      }
    }

    setTimeout(async () => {
      await ticketChannel.delete('Ticket closed').catch(() => {});
    }, 5000);
  }
}

export async function handleTicketModal(interaction: ModalSubmitInteraction) {
  if (interaction.customId.startsWith('ticket:modal_adduser:')) {
    const channelId = interaction.customId.replace('ticket:modal_adduser:', '');
    const channel = interaction.guild?.channels.cache.get(channelId) as TextChannel;
    if (!channel) {
      return interaction.reply({ content: '❌ Ticket channel not found.', ephemeral: true });
    }

    const query = interaction.fields.getTextInputValue('user_query').trim().replace(/[<@!>]/g, '');
    let targetMember = await interaction.guild!.members.fetch(query).catch(() => null);
    if (!targetMember) {
      const searchRes = await interaction.guild!.members.search({ query, limit: 1 }).catch(() => null);
      targetMember = searchRes?.first() || null;
    }

    if (!targetMember) {
      return interaction.reply({
        content: `❌ Could not find a member matching "${query}". Please check the ID or username.`,
        ephemeral: true,
      });
    }

    await channel.permissionOverwrites.edit(targetMember.id, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
      AttachFiles: true,
    });

    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor('#22c55e')
          .setDescription(`✅ <@${targetMember.id}> was added to the ticket by <@${interaction.user.id}>.`),
      ],
    });

    return interaction.reply({
      content: `✅ Successfully added <@${targetMember.id}> to this ticket.`,
      ephemeral: true,
    });
  }
}

export async function handleTicketCreatorLeave(member: GuildMember) {
  const guild = member.guild;
  const settings = await (db.guild.findUnique as any)({
    where: { discordId: guild.id },
  });
  if (!settings) return;

  const openTickets = await db.ticketAnalytics.findMany({
    where: {
      guildId: guild.id,
      userId: member.id,
      closedAt: null,
    },
  });

  if (openTickets.length === 0) return;

  const panels: any[] = (settings.ticketPanels as any[]) || [];

  for (const ticket of openTickets) {
    const channel = guild.channels.cache.get(ticket.ticketId) as TextChannel | undefined;
    if (!channel) {
      await db.ticketAnalytics.updateMany({
        where: { ticketId: ticket.ticketId },
        data: { closedAt: new Date() },
      }).catch(() => {});
      continue;
    }

    let action = 'nothing';
    for (const p of panels) {
      if (channel.topic?.includes(`Panel: ${p.id}`)) {
        action = p.onCreatorLeave || 'nothing';
        break;
      }
    }
    if (action === 'nothing' && panels[0]?.onCreatorLeave) {
      action = panels[0].onCreatorLeave;
    }

    if (action === 'delete') {
      await channel.send({
        embeds: [
          new EmbedBuilder()
            .setColor('#ef4444')
            .setDescription(`⚠️ **Ticket Creator Left:** <@${member.id}> left the server. Deleting ticket...`),
        ],
      }).catch(() => {});

      await db.ticketAnalytics.updateMany({
        where: { ticketId: ticket.ticketId },
        data: { closedAt: new Date() },
      }).catch(() => {});

      setTimeout(() => channel.delete('Creator left server').catch(() => {}), 3000);
    } else if (action === 'close') {
      await channel.send({
        embeds: [
          new EmbedBuilder()
            .setColor('#ef4444')
            .setDescription(`⚠️ **Ticket Creator Left:** <@${member.id}> left the server. Closing ticket...`),
        ],
      }).catch(() => {});

      await db.ticketAnalytics.updateMany({
        where: { ticketId: ticket.ticketId },
        data: { closedAt: new Date() },
      }).catch(() => {});

      setTimeout(() => channel.delete('Creator left server').catch(() => {}), 5000);
    } else {
      await channel.send({
        embeds: [
          new EmbedBuilder()
            .setColor('#f97316')
            .setDescription(`ℹ️ **Note:** The ticket creator (<@${member.id}>) has left the server.`),
        ],
      }).catch(() => {});
    }
  }
}
