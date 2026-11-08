import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  AutocompleteInteraction,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  PermissionFlagsBits,
  TextChannel,
  AttachmentBuilder,
} from 'discord.js';
import { db } from '../../db.js';
import { getPanelConfig } from '../../events/ticketHandler.js';

function ticketPanelId(topic: string | null): string | undefined {
  return topic?.match(/Panel: ([^\s|]+)/)?.[1];
}
import fs from 'fs';
import path from 'path';

export const data = new SlashCommandBuilder()
  .setName('ticket')
  .setDescription('🎫 Ticket system commands.')
  .addSubcommand((sub) =>
    sub
      .setName('panel')
      .setDescription('📩 Send the ticket panel to this channel.')
  )
  .addSubcommand((sub) =>
    sub
      .setName('add')
      .setDescription('➕ Add a user to this ticket.')
      .addUserOption((opt) =>
        opt.setName('user').setDescription('User to add').setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName('remove')
      .setDescription('Remove a user from this ticket.')
      .addUserOption((opt) =>
        opt.setName('user').setDescription('User to remove').setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName('close')
      .setDescription('🔒 Close this ticket.')
  )
  .addSubcommand((sub) =>
    sub
      .setName('snippet')
      .setDescription('Send a text snippet into this ticket.')
      .addStringOption((opt) =>
        opt
          .setName('name')
          .setDescription('Name of the snippet')
          .setRequired(true)
          .setAutocomplete(true)
      )
  );

export async function autocomplete(interaction: AutocompleteInteraction) {
  const focusedOption = interaction.options.getFocused(true);

  if (focusedOption.name === 'name') {
    const settings = await (db.guild.findUnique as any)({
      where: { discordId: interaction.guildId! },
    });

    const panels = ((settings as any)?.ticketPanels as any[]) || [];
    const snippets: Array<{ name: string; text: string }> = [];

    for (const panel of panels) {
      const list = (panel.snippets || panel.cannedResponses || []) as any[];
      for (const s of list) {
        const n = s.name || s.title;
        if (n && !snippets.some((x) => x.name.toLowerCase() === n.toLowerCase())) {
          snippets.push({ name: n, text: s.text || s.content });
        }
      }
    }

    const query = focusedOption.value.toLowerCase();
    const filtered = snippets
      .filter((s) => s.name.toLowerCase().includes(query))
      .slice(0, 25)
      .map((s) => ({ name: s.name, value: s.name }));

    await interaction.respond(filtered);
  }
}

export async function execute(interaction: ChatInputCommandInteraction) {
  const sub = interaction.options.getSubcommand();

  if (sub === 'panel') {
    const member = await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
    if (!member?.permissions.has(PermissionFlagsBits.ManageChannels) && !member?.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor('#ef4444').setDescription('❌ You need Manage Channels permission to send the ticket panel.')],
        ephemeral: true,
      });
    }

    const settings = await (db.guild.findUnique as any)({
      where: { discordId: interaction.guildId! },
    });

    if (!settings?.ticketsEnabled) {
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor('#ef4444')
            .setDescription('❌ The Ticket System is disabled. Enable it in the dashboard first.'),
        ],
        ephemeral: true,
      });
    }

    await interaction.deferReply({ ephemeral: true });

    const panels = ((settings as any)?.ticketPanels as any[]) || [];
    const panel = panels[0];
    const title = panel?.title || settings.ticketPanelTitle || '🎫 Support Tickets';
    let description = panel?.description || settings.ticketPanelDescription || 'Need help or have a question?\n\nClick the button below to open a **private support ticket**. Our team will be with you shortly.';

    if (panel?.showCapacity) {
      const openCount = await db.ticketAnalytics.count({
        where: { guildId: interaction.guildId!, closedAt: null },
      });
      description += `\n\n📊 **Current Workload:** ${openCount} open ticket(s)`;
    }

    const colorHex = panel?.color || settings.ticketPanelColor || '#1FA7BB';
    const colorInt = parseInt(colorHex.replace('#', ''), 16) || 0x1fa7bb;

    let selectMenu: StringSelectMenuBuilder | undefined;
    let button: ButtonBuilder | undefined;

    const useDropdown = panel?.useDropdown ?? settings.ticketUseDropdown;
    const reasons = (panel?.reasons || settings.ticketReasons) as Array<{
      label: string;
      value: string;
      emoji?: string;
      description?: string;
    }>;

    const panelId = panel?.id || 'default';

    if (useDropdown && reasons && reasons.length > 0) {
      selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`ticket:select_reason:${panelId}`)
        .setPlaceholder('Select a reason for your ticket')
        .setMinValues(1)
        .setMaxValues(1);

      for (const reason of reasons) {
        selectMenu.addOptions({
          label: reason.label,
          value: reason.value,
          emoji: reason.emoji || undefined,
          description: reason.description || undefined,
        });
      }
    } else {
      button = new ButtonBuilder()
        .setCustomId(`ticket:open:${panelId}`)
        .setLabel(panel?.buttonLabel || settings.ticketButtonLabel || 'Open a Ticket')
        .setEmoji(panel?.buttonEmoji || settings.ticketButtonEmoji || '🎫')
        .setStyle(ButtonStyle.Primary);
    }

    const files: AttachmentBuilder[] = [];
    const imageUrl = panel?.imageUrl;
    const bannerFileName = 'ticket-banner.png';
    let bannerUrl: string | undefined;

    if (imageUrl) {
      if (imageUrl.startsWith('data:image/')) {
        const base64Data = imageUrl.replace(/^data:image\/\w+;base64,/, '');
        const buffer = Buffer.from(base64Data, 'base64');
        files.push(new AttachmentBuilder(buffer, { name: bannerFileName }));
        bannerUrl = `attachment://${bannerFileName}`;
      } else if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) {
        bannerUrl = imageUrl;
      }
    }

    if (!bannerUrl) {
      const bannerPath = path.join(process.cwd(), 'assets', bannerFileName);
      if (fs.existsSync(bannerPath)) {
        files.push(new AttachmentBuilder(bannerPath, { name: bannerFileName }));
        bannerUrl = `attachment://${bannerFileName}`;
      }
    }

    const { buildTicketPanelCV2 } = await import('../../utils/cv2.js');
    const cv2Payload = buildTicketPanelCV2({
      title,
      description,
      accentColor: colorInt,
      bannerUrl,
      selectMenu,
      button,
    });

    await (interaction.channel as any).send({
      ...cv2Payload,
      files,
    });

    await interaction.deleteReply();
    return;
  }

  if (sub === 'add') {
    const channel = interaction.channel as TextChannel;
    if (!channel.name.startsWith('ticket-')) {
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor('#ef4444').setDescription('❌ This command can only be used inside a ticket channel.')],
        ephemeral: true,
      });
    }

    const settings = await (db.guild.findUnique as any)({
      where: { discordId: interaction.guildId! },
    });
    const ticket = await db.ticketAnalytics.findFirst({ where: { ticketId: channel.id, guildId: interaction.guildId! } });
    const isCreator = ticket?.userId === interaction.user.id;
    // The ticket's own panel decides; the first panel is only a fallback when none matches.
    const creatorCanAdd = getPanelConfig(settings, ticketPanelId(channel.topic)).creatorCanAddUsers;

    const member = await interaction.guild!.members.fetch(interaction.user.id).catch(() => null);
    const isStaff = member?.permissions.has(PermissionFlagsBits.ManageChannels) ||
      member?.permissions.has(PermissionFlagsBits.Administrator) ||
      ((settings?.ticketSupportRoleIds || []) as string[]).some((r: string) => member?.roles.cache.has(r));

    if (!isStaff && (!isCreator || !creatorCanAdd)) {
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor('#ef4444').setDescription('❌ You do not have permission to add users to this ticket.')],
        ephemeral: true,
      });
    }

    const user = interaction.options.getUser('user', true);
    await channel.permissionOverwrites.create(user.id, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
      AttachFiles: true,
    });

    return interaction.reply({
      embeds: [new EmbedBuilder().setColor('#22c55e').setDescription(`✅ Added <@${user.id}> to the ticket.`)],
    });
  }

  if (sub === 'remove') {
    const channel = interaction.channel as TextChannel;
    if (!channel.name.startsWith('ticket-')) {
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor('#ef4444').setDescription('❌ This command can only be used inside a ticket channel.')],
        ephemeral: true,
      });
    }

    const member = await interaction.guild!.members.fetch(interaction.user.id).catch(() => null);
    const settings = await (db.guild.findUnique as any)({
      where: { discordId: interaction.guildId! },
    });
    const isStaff = member?.permissions.has(PermissionFlagsBits.ManageChannels) ||
      member?.permissions.has(PermissionFlagsBits.Administrator) ||
      ((settings?.ticketSupportRoleIds || []) as string[]).some((r: string) => member?.roles.cache.has(r));

    if (!isStaff) {
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor('#ef4444').setDescription('❌ Only staff members can remove users from a ticket.')],
        ephemeral: true,
      });
    }

    const user = interaction.options.getUser('user', true);
    await channel.permissionOverwrites.delete(user.id);
    return interaction.reply({
      embeds: [new EmbedBuilder().setColor('#f97316').setDescription(`✅ Removed <@${user.id}> from the ticket.`)],
    });
  }

  if (sub === 'close') {
    const channel = interaction.channel as TextChannel;
    if (!channel.name.startsWith('ticket-')) {
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor('#ef4444').setDescription('❌ This command can only be used inside a ticket channel.')],
        ephemeral: true,
      });
    }

    const settings = await (db.guild.findUnique as any)({
      where: { discordId: interaction.guildId! },
    });
    // Only channels created by the ticket system can be closed here, whatever their name.
    const ticket = await db.ticketAnalytics.findFirst({ where: { ticketId: channel.id, guildId: interaction.guildId! } });
    if (!ticket) {
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor('#ef4444').setDescription('❌ This channel is not a ticket.')],
        ephemeral: true,
      });
    }
    const panelConfig = getPanelConfig(settings, ticketPanelId(channel.topic));
    const isCreator = ticket.userId === interaction.user.id;

    const member = await interaction.guild!.members.fetch(interaction.user.id).catch(() => null);
    const isStaff = member?.permissions.has(PermissionFlagsBits.ManageChannels) ||
      member?.permissions.has(PermissionFlagsBits.Administrator) ||
      panelConfig.supportRoleIds.some((r: string) => member?.roles.cache.has(r));

    if (!isStaff && (!isCreator || panelConfig.onlyTeamCanClose)) {
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor('#ef4444').setDescription(isCreator
          ? '❌ Only staff members are allowed to close this ticket.'
          : '❌ Only staff or the ticket creator can close this ticket.')],
        ephemeral: true,
      });
    }

    // Closing here would skip the transcript, so send those tickets through the Close button.
    if (panelConfig.transcriptEnabled && panelConfig.transcriptChannelId) {
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor('#f97316').setDescription('ℹ️ This ticket saves a transcript. Please use the **Close** button on the ticket message.')],
        ephemeral: true,
      });
    }

    const closingEmbed = new EmbedBuilder()
      .setColor('#ef4444')
      .setTitle('🔒 Ticket Closing...')
      .setDescription('This ticket will be deleted in 5 seconds.')
      .setTimestamp();

    await interaction.reply({ embeds: [closingEmbed] });

    await db.ticketAnalytics.updateMany({
      where: { ticketId: channel.id },
      data: { closedAt: new Date() },
    }).catch(() => {});

    setTimeout(async () => {
      await channel.delete('Ticket closed via command').catch(() => {});
    }, 5000);
    return;
  }

  if (sub === 'snippet') {
    const channel = interaction.channel as TextChannel;
    if (!channel.name.startsWith('ticket-')) {
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor('#ef4444').setDescription('❌ This command can only be used inside a ticket channel.')],
        ephemeral: true,
      });
    }

    const snippetName = interaction.options.getString('name', true).toLowerCase();
    const settings = await (db.guild.findUnique as any)({
      where: { discordId: interaction.guildId! },
    });

    const panels = ((settings as any)?.ticketPanels as any[]) || [];
    let foundSnippet: { name: string; text: string } | null = null;

    for (const panel of panels) {
      const snippets = (panel.snippets || panel.cannedResponses || []) as any[];
      const match = snippets.find((s: any) => (s.name || s.title || '').toLowerCase() === snippetName);
      if (match) {
        foundSnippet = { name: match.name || match.title, text: match.text || match.content };
        break;
      }
    }

    if (!foundSnippet) {
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor('#ef4444').setDescription(`❌ No canned response found with the name **${interaction.options.getString('name')}**`)],
        ephemeral: true,
      });
    }

    const content = foundSnippet.text
      .replace(/%USERNAME%/g, interaction.user.username)
      .replace(/%DISPLAY_NAME%/g, interaction.user.displayName || interaction.user.username)
      .replace(/%USER_ID%/g, interaction.user.id)
      .replace(/%PREFIX%/g, '!')
      .replace(/%CASEID%/g, channel.name.replace('ticket-', ''))
      .replace(/%EMOTE%/g, '🎫');

    return interaction.reply({
      content,
    });
  }
}
