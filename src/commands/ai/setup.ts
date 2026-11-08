import { randomUUID } from 'node:crypto';
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ModalSubmitInteraction,
  ChannelType,
  PermissionFlagsBits,
  ButtonBuilder,
  ButtonStyle,
  ButtonInteraction,
  ChannelSelectMenuBuilder,
  ChannelSelectMenuInteraction,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  ContainerBuilder,
  TextDisplayBuilder,
  MessageFlags,
  type GuildBasedChannel,
  type TextChannel,
  type VoiceChannel,
} from 'discord.js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { consumeAIBudget } from '../../utils/aiBudget.js';
import { infoCV2, successCV2, dangerCV2, warnCV2 } from '../../utils/cv2.js';

export type SeparatorStyle = 'thick_pipe' | 'thin_pipe' | 'dot' | 'dash' | 'arrow' | 'double_arrow' | 'none';
export type FontStyle = 'small_caps' | 'normal' | 'monospace' | 'bold' | 'italic';

export const SEPARATOR_MAP: Record<SeparatorStyle, string> = {
  thick_pipe: '┃',
  thin_pipe: '|',
  dot: '・',
  dash: '―',
  arrow: '›',
  double_arrow: '»',
  none: '',
};

export const FONT_LABELS: Record<FontStyle, string> = {
  small_caps: 'Small Caps (ɢɪᴠᴇᴀᴡᴀʏꜱ)',
  normal: 'Standard (giveaways)',
  monospace: 'Typewriter (𝚐𝚒ᴠ𝚎𝚊𝚠𝚊𝚢𝚜)',
  bold: 'Bold Sans (𝗴𝗶𝘃𝗲𝗮𝘄𝗮𝘆𝘀)',
  italic: 'Italic Sans (𝘨𝘪ᴠ𝒆𝘢ᴡᴀ𝘺𝘴)',
};

const SMALL_CAPS_MAP: Record<string, string> = {
  a: 'ᴀ', b: 'ʙ', c: 'ᴄ', d: 'ᴅ', e: 'ᴇ', f: 'ꜰ', g: 'ɢ', h: 'ʜ', i: 'ɪ',
  j: 'ᴊ', k: 'ᴋ', l: 'ʟ', m: 'ᴍ', n: 'ɴ', o: 'ᴏ', p: 'ᴘ', q: 'ǫ', r: 'ʀ',
  s: 'ꜱ', t: 'ᴛ', u: 'ᴜ', v: 'ᴠ', w: 'ᴡ', x: 'x', y: 'ʏ', z: 'ᴢ',
  A: 'ᴀ', B: 'ʙ', C: 'ᴄ', D: 'ᴅ', E: 'ᴇ', F: 'ꜰ', G: 'ɢ', H: 'ʜ', I: 'ɪ',
  J: 'ᴊ', K: 'ᴋ', L: 'ʟ', M: 'ᴍ', N: 'ɴ', O: 'ᴏ', P: 'ᴘ', Q: 'ǫ', R: 'ʀ',
  S: 'ꜱ', T: 'ᴛ', U: 'ᴜ', V: 'ᴠ', W: 'ᴡ', X: 'x', Y: 'ʏ', Z: 'ᴢ',
};

export function applyFont(text: string, font: FontStyle): string {
  if (font === 'normal') return text.toLowerCase();
  if (font === 'small_caps') {
    return text.split('').map((c) => SMALL_CAPS_MAP[c] ?? c).join('');
  }
  if (font === 'monospace') {
    return text.toLowerCase().split('').map((c) => {
      const code = c.charCodeAt(0);
      if (code >= 97 && code <= 122) return String.fromCodePoint(0x1D68A + (code - 97));
      if (code >= 48 && code <= 57) return String.fromCodePoint(0x1D7F6 + (code - 48));
      return c;
    }).join('');
  }
  if (font === 'bold') {
    return text.toLowerCase().split('').map((c) => {
      const code = c.charCodeAt(0);
      if (code >= 97 && code <= 122) return String.fromCodePoint(0x1D5EE + (code - 97));
      if (code >= 48 && code <= 57) return String.fromCodePoint(0x1D7EC + (code - 48));
      return c;
    }).join('');
  }
  if (font === 'italic') {
    return text.toLowerCase().split('').map((c) => {
      const code = c.charCodeAt(0);
      if (code >= 97 && code <= 122) return String.fromCodePoint(0x1D622 + (code - 97));
      return c;
    }).join('');
  }
  return text;
}

export function getFallbackEmoji(name: string, type: 'text' | 'voice'): string {
  const n = name.toLowerCase();
  if (type === 'voice') {
    if (/music|musik/.test(n)) return '🎵';
    if (/gaming|game/.test(n)) return '🎮';
    return '🔊';
  }
  if (/welcome|willkommen|join/.test(n)) return '👋';
  if (/rule|regel/.test(n)) return '📜';
  if (/announcement|ankündigung|news|update/.test(n)) return '📢';
  if (/giveaway|verlosung/.test(n)) return '🎉';
  if (/general|chat|lounge|main/.test(n)) return '💬';
  if (/bot|command|cmd/.test(n)) return '🤖';
  if (/meme|media|bild|clip|video/.test(n)) return '📸';
  if (/ticket|support|help|hilfe/.test(n)) return '🎫';
  if (/mod|staff|admin|team/.test(n)) return '🛡️';
  if (/log|audit/.test(n)) return '📋';
  if (/info/.test(n)) return '📌';
  return '✨';
}

export function extractEmojiAndName(input: string, channelType: 'text' | 'voice' = 'text'): { emoji: string; name: string } {
  let cleaned = input.trim().replace(/^#+/, '').trim();
  cleaned = cleaned.replace(/^[\s\|\┃\・\―\-\-\:\>\»\›\・]+/, '').trim();
  const emojiRegex = /^(\p{Extended_Pictographic}(?:\u200D\p{Extended_Pictographic})*[\uFE0E\uFE0F]?|[^\w\s\u0080-\uFFFF]{1,4})/u;
  const match = cleaned.match(emojiRegex);
  let emoji = '';
  let rest = cleaned;
  if (match) {
    emoji = match[0].trim();
    rest = cleaned.slice(match[0].length).trim();
  }
  rest = rest.replace(/^[\s\|\┃\・\―\-\-\:\>\»\›\・]+/, '').trim();
  if (!emoji) {
    emoji = getFallbackEmoji(rest, channelType);
  }
  return { emoji, name: rest };
}

export function extractCategoryEmojiAndName(input: string): { emoji: string; name: string } {
  let cleaned = input.trim();
  cleaned = cleaned.replace(/^[\s\|\┃\・\―\-\-\:\>\»\›\・]+/, '').trim();
  const emojiRegex = /^(\p{Extended_Pictographic}(?:\u200D\p{Extended_Pictographic})*[\uFE0E\uFE0F]?|[^\w\s\u0080-\uFFFF]{1,4})/u;
  const match = cleaned.match(emojiRegex);
  let emoji = '';
  let rest = cleaned;
  if (match) {
    emoji = match[0].trim();
    rest = cleaned.slice(match[0].length).trim();
  }
  rest = rest.replace(/^[\s\|\┃\・\―\-\-\:\>\»\›\・]+/, '').trim();
  if (!emoji) {
    emoji = '📌';
  }
  return { emoji, name: rest };
}

export function formatChannelStyled(
  rawName: string,
  separator: SeparatorStyle,
  font: FontStyle,
  channelType: 'text' | 'voice' = 'text',
): string {
  const { emoji, name } = extractEmojiAndName(rawName, channelType);
  const sepChar = SEPARATOR_MAP[separator] ?? '┃';
  let slug = name.replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (!slug) slug = 'channel';
  const styledText = applyFont(slug, font);

  if (emoji) {
    if (sepChar) {
      return `${emoji}\u2005${sepChar}\u2005${styledText}`;
    }
    return `${emoji}\u2005${styledText}`;
  }
  return styledText;
}

export function formatCategoryStyled(
  rawName: string,
  separator: SeparatorStyle,
  font: FontStyle,
): string {
  const { emoji, name } = extractCategoryEmojiAndName(rawName);
  const sepChar = SEPARATOR_MAP[separator] ?? '┃';
  let cleanName = name.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleanName) cleanName = 'CATEGORY';

  let styledName: string;
  if (font === 'normal') {
    styledName = cleanName.toUpperCase();
  } else if (font === 'small_caps') {
    styledName = applyFont(cleanName.toLowerCase(), 'small_caps');
  } else {
    styledName = applyFont(cleanName.toLowerCase(), font);
  }

  if (emoji) {
    if (sepChar) {
      return `${emoji} ${sepChar} ${styledName}`;
    }
    return `${emoji} ${styledName}`;
  }
  return styledName;
}

type SetupMode = 'full' | 'area';
type GeneratedChannel = { name: string; type: 'text' | 'voice'; topic?: string; permissions?: 'readonly' | 'normal' | 'staff-only' };
type FullLayout = {
  serverName: string;
  serverDescription?: string;
  categories: Array<{ name: string; channels: GeneratedChannel[] }>;
  roles: Array<{ name: string; color?: string; reason?: string; permissions?: string[] }>;
};
type ChannelEdit = { id: string; name: string; topic?: string };
type CategoryEdit = { id: string; name: string; channels: ChannelEdit[] };
type SetupProposal =
  | { mode: 'full'; layout: FullLayout }
  | { mode: 'area'; categories: CategoryEdit[]; channels: ChannelEdit[] };
type SetupSession = {
  id: string;
  guildId: string;
  userId: string;
  createdAt: number;
  mode: SetupMode;
  changeRoles: boolean;
  separator: SeparatorStyle;
  font: FontStyle;
  selectedIds?: string[];
  proposal?: SetupProposal;
};

const SESSION_TTL_MS = 15 * 60 * 1000;
const sessions = new Map<string, SetupSession>();

function getSession(id: string) {
  const session = sessions.get(id);
  if (session && Date.now() - session.createdAt <= SESSION_TTL_MS) return session;
  sessions.delete(id);
  return undefined;
}

export const data = new SlashCommandBuilder()
  .setName('setup')
  .setDescription('🤖 Generate a full server layout or refresh a selected area with Layer AI.')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addStringOption((option) => option
    .setName('scope')
    .setDescription('Choose a full rebuild or update only selected channels/categories.')
    .setRequired(true)
    .addChoices(
      { name: 'Full server rebuild', value: 'full' },
      { name: 'Selected channels or categories', value: 'area' },
    ))
  .addStringOption((option) => option
    .setName('separator')
    .setDescription('Separator symbol between emoji and channel name (e.g. ┃, |, ・, ›, ―)')
    .setRequired(false)
    .addChoices(
      { name: '┃  Thick Pipe (Recommended)', value: 'thick_pipe' },
      { name: '|  Standard Pipe', value: 'thin_pipe' },
      { name: '・ Middle Dot', value: 'dot' },
      { name: '― Dash / Bar', value: 'dash' },
      { name: '› Arrow', value: 'arrow' },
      { name: '» Double Arrow', value: 'double_arrow' },
      { name: 'No Symbol (space only)', value: 'none' },
    ))
  .addStringOption((option) => option
    .setName('font')
    .setDescription('Font style for channel names (e.g. Small Caps, Monospace, Bold)')
    .setRequired(false)
    .addChoices(
      { name: 'Small Caps (ɢɪᴠᴇᴀᴡᴀʏꜱ)', value: 'small_caps' },
      { name: 'Standard (giveaways)', value: 'normal' },
      { name: 'Typewriter / Monospace (𝚐𝚒ᴠ𝚎𝚊𝚠𝚊𝚢𝚜)', value: 'monospace' },
      { name: 'Bold Sans (𝗴𝗶ᴠ𝗲𝗮𝘄𝗮𝘆𝘀)', value: 'bold' },
      { name: 'Italic Sans (𝘨𝘪ᴠ𝒆𝘢𝘸ᴀ𝘺𝘴)', value: 'italic' },
    ))
  .addBooleanOption((option) => option
    .setName('change_roles')
    .setDescription('For a full rebuild only. Defaults to false; selected-area updates never change roles.')
    .setRequired(false));

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!interaction.guild) {
    await interaction.reply({ content: 'Use `/setup` inside a server.', ephemeral: true });
    return;
  }
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: 'You need the Administrator permission to use `/setup`.', ephemeral: true });
    return;
  }

  const mode = interaction.options.getString('scope', true) as SetupMode;
  const separator = (interaction.options.getString('separator') ?? 'thick_pipe') as SeparatorStyle;
  const font = (interaction.options.getString('font') ?? 'small_caps') as FontStyle;
  const changeRoles = mode === 'full' && (interaction.options.getBoolean('change_roles') ?? false);
  const id = randomUUID().slice(0, 12);
  const session: SetupSession = {
    id,
    guildId: interaction.guild.id,
    userId: interaction.user.id,
    createdAt: Date.now(),
    mode,
    changeRoles,
    separator,
    font,
  };
  sessions.set(id, session);

  if (mode === 'area') {
    const picker = new ChannelSelectMenuBuilder()
      .setCustomId(`setup_select_${id}`)
      .setPlaceholder('Choose channels and/or categories to refresh')
      .setMinValues(1)
      .setMaxValues(10)
      .setChannelTypes(ChannelType.GuildCategory, ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice);
    const cancel = new ButtonBuilder().setCustomId(`setup_cancel_${id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary);
    const container = new ContainerBuilder().setAccentColor(0x7c3aed)
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(
        '## 🧩 Refresh selected server areas\nChoose up to 10 channels or categories. Layer will only update the selected areas in place; roles, messages, permissions, and everything else stay as they are. You will review the proposed changes before they are applied.',
      ))
      .addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(cancel));
    await interaction.reply({
      components: [container, new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(picker)] as any,
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    });
    return;
  }

  const proceed = new ButtonBuilder().setCustomId(`setup_proceed_${id}`).setLabel('Continue').setStyle(ButtonStyle.Danger);
  const cancel = new ButtonBuilder().setCustomId(`setup_cancel_${id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary);
  const roleText = changeRoles
    ? 'Roles **will also be deleted and regenerated**.'
    : 'Existing roles **will be kept**.';
  await interaction.reply({
    ...dangerCV2({
      title: '⚠️ Full server rebuild',
      description: `Layer will remove existing channels except the channel where you ran this command, then create a new layout. ${roleText} This cannot be automatically undone. The AI will prepare a preview first; nothing changes until you confirm that preview.`,
      buttons: [proceed, cancel],
    }),
    ephemeral: true,
  });
}

function createSetupModal(id: string, mode: SetupMode) {
  const modal = new ModalBuilder().setCustomId(`setup_modal_${id}`).setTitle(mode === 'area' ? 'Layer - Refresh selected areas' : 'Layer - Server setup');
  const topicInput = new TextInputBuilder()
    .setCustomId('topic')
    .setLabel(mode === 'area' ? 'What should change in this area?' : 'What is your server about?')
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder(mode === 'area' ? 'e.g. Make this section clearer and more welcoming' : 'e.g. Minecraft server, clan, or community')
    .setRequired(true)
    .setMaxLength(500);
  const languageInput = new TextInputBuilder()
    .setCustomId('language')
    .setLabel('Main language')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('English')
    .setRequired(true)
    .setMaxLength(30);
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(topicInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(languageInput),
  );
  return modal;
}

function canUseSession(interaction: ButtonInteraction | ChannelSelectMenuInteraction | ModalSubmitInteraction | StringSelectMenuInteraction, session: SetupSession) {
  return interaction.user.id === session.userId && interaction.guildId === session.guildId;
}

export async function handleSetupChannelSelect(interaction: ChannelSelectMenuInteraction) {
  const id = interaction.customId.replace('setup_select_', '');
  const session = getSession(id);
  if (!session || !canUseSession(interaction, session)) {
    await interaction.reply({ content: 'This setup session expired or belongs to another moderator. Run `/setup` again.', ephemeral: true });
    return;
  }
  session.selectedIds = [...interaction.values];
  await interaction.showModal(createSetupModal(id, 'area'));
}

export async function handleSetupButton(interaction: ButtonInteraction) {
  const [, action, id] = interaction.customId.split('_');
  const session = getSession(id ?? '');
  if (!session || !canUseSession(interaction, session)) {
    await interaction.reply({ content: 'This setup session expired or belongs to another moderator. Run `/setup` again.', ephemeral: true });
    return;
  }

  if (action === 'cancel') {
    sessions.delete(session.id);
    await interaction.update(infoCV2({ title: 'Setup cancelled', description: 'Nothing was changed.' }));
    return;
  }

  if (action === 'proceed') {
    await interaction.showModal(createSetupModal(session.id, 'full'));
    return;
  }

  if (action === 'confirm') {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      sessions.delete(session.id);
      await interaction.reply({ content: 'Your Administrator permission is required to apply this setup.', ephemeral: true });
      return;
    }
    if (!session.proposal || !interaction.guild) {
      await interaction.reply({ content: 'The setup preview expired. Run `/setup` again.', ephemeral: true });
      sessions.delete(session.id);
      return;
    }
    await interaction.deferUpdate();
    try {
      const result = session.proposal.mode === 'full'
        ? await applyFullSetup(interaction, session, session.proposal.layout)
        : await applyAreaSetup(interaction, session, session.proposal);
      sessions.delete(session.id);
      await interaction.editReply(successCV2({
        title: session.mode === 'full' ? '✅ Server setup complete' : '✅ Selected areas refreshed',
        description: result,
      }));
    } catch (error) {
      console.error('[Setup] Applying the confirmed setup failed:', error);
      sessions.delete(session.id);
      await interaction.editReply(dangerCV2({
        title: '⚠️ Setup finished with issues',
        description: 'Layer could not complete every requested change. Check the bot’s permissions and review the affected channels.',
      }));
    }
  }
}

export async function handleSetupModal(interaction: ModalSubmitInteraction) {
  const id = interaction.customId.replace('setup_modal_', '');
  const session = getSession(id);
  if (!session || !canUseSession(interaction, session)) {
    await interaction.reply({ content: 'This setup session expired or belongs to another moderator. Run `/setup` again.', ephemeral: true });
    return;
  }
  if (!interaction.guild) {
    await interaction.reply({ content: 'Use `/setup` inside a server.', ephemeral: true });
    return;
  }

  if (!consumeAIBudget(interaction.guild.id, interaction.user.id)) {
    await interaction.reply({ content: '⏳ Layer AI has reached its hourly limit for this server. Please try again later.', ephemeral: true });
    return;
  }

  const topic = interaction.fields.getTextInputValue('topic').trim();
  const language = interaction.fields.getTextInputValue('language').trim();
  await interaction.deferReply({ ephemeral: true });
  await interaction.editReply(warnCV2({
    title: '⏳ Preparing a preview',
    description: session.mode === 'full'
      ? `Layer is preparing a full layout for **${topic}**. No server changes will happen until you confirm the preview.`
      : `Layer is preparing changes for the selected channels only. No server changes will happen until you confirm the preview.`,
  }));

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('[Setup] AI provider credentials are not configured.');
    sessions.delete(session.id);
    await interaction.editReply(dangerCV2({
      title: '⚠️ Setup temporarily unavailable',
      description: 'Layer could not prepare a server layout right now. No channels, roles, or server settings were changed. Please try again in a few minutes.',
    }));
    return;
  }

  try {
    const proposal = session.mode === 'full'
      ? await generateFullProposal(apiKey, topic, language)
      : await generateAreaProposal(apiKey, interaction, session, topic, language);
    session.proposal = proposal;
    await interaction.editReply(renderPreviewMessage(session));
  } catch (error) {
    console.error('[Setup] Could not prepare or validate the setup preview:', error);
    sessions.delete(session.id);
    await interaction.editReply(dangerCV2({
      title: '⚠️ Setup temporarily unavailable',
      description: 'Layer could not prepare a valid layout. No channels, roles, or server settings were changed. Please try again in a few minutes.',
    }));
  }
}

// Keep setup responsive: a stalled provider must not make the interaction wait
// through a long chain of model retries.
const candidateModels = ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash'];
const generationTimeoutMs = 12_000;

async function generateJson(apiKey: string, prompt: string): Promise<any> {
  const genAI = new GoogleGenerativeAI(apiKey);
  let lastError: unknown;
  for (const [index, modelName] of candidateModels.entries()) {
    try {
      console.log(`[Setup] Trying layout generation attempt ${index + 1}/${candidateModels.length}.`);
      const model = genAI.getGenerativeModel({
        model: modelName,
        systemInstruction: 'You are Layer, a professional Discord server architect. Never mention model or provider names. Return only valid JSON matching the requested schema.',
        generationConfig: { responseMimeType: 'application/json', temperature: 0.7 },
      }, { timeout: generationTimeoutMs });
      const result = await model.generateContent(prompt);
      const text = result.response.text();
      const jsonText = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/)?.[1] ?? text;
      const match = jsonText.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('No JSON object found in AI response');
      return JSON.parse(match[0]);
    } catch (error) {
      lastError = error;
      const message = typeof (error as any)?.message === 'string' ? (error as any).message : '';
      const status = message.match(/\b(400|401|403|404|429|500|502|503|504)\b/)?.[1] ?? 'unknown';
      const timedOut = /timeout|timed out|abort/i.test(message);
      const retryable = timedOut || status === 'unknown' || ['429', '500', '502', '503', '504'].includes(status);
      if (!retryable || index === candidateModels.length - 1) {
        console.warn(`[Setup] Generation attempt ${index + 1}/${candidateModels.length} failed (status ${status}${timedOut ? ', timeout' : ''}); stopping retries.`);
        break;
      }
      console.warn(`[Setup] Generation attempt ${index + 1}/${candidateModels.length} failed (status ${status}${timedOut ? ', timeout' : ''}); trying fallback.`);
    }
  }
  throw lastError ?? new Error('All configured generation models failed');
}

function validateFullLayout(value: any): FullLayout {
  if (typeof value?.serverName !== 'string' || !value.serverName.trim()) throw new Error('Missing server name');
  if (!Array.isArray(value.categories) || value.categories.length < 1) throw new Error('Missing categories');
  if (!Array.isArray(value.roles)) throw new Error('Missing roles array');
  for (const category of value.categories) {
    if (typeof category?.name !== 'string' || !Array.isArray(category.channels)) throw new Error('Invalid category structure');
    for (const channel of category.channels) {
      if (typeof channel?.name !== 'string' || !['text', 'voice'].includes(channel.type)) throw new Error('Invalid channel structure');
    }
  }
  return value as FullLayout;
}

async function generateFullProposal(apiKey: string, topic: string, language: string): Promise<SetupProposal> {
  const prompt = `Create a Discord server layout about: "${topic}". Language: ${language}. Return JSON only with this shape: {"serverName":"...","serverDescription":"...","categories":[{"name":"emoji || CATEGORY NAME","channels":[{"name":"emoji-lowercase-name","type":"text|voice","topic":"short purpose","permissions":"readonly|normal|staff-only"}]}],"roles":[{"name":"...","color":"#HEX","reason":"...","permissions":[]}]} . Create 3-5 categories, 8-15 total channels, and 4-7 useful roles. Keep names concise and relevant. Use readonly for rules/announcements, staff-only for moderation areas, normal otherwise. Use least privilege; do not grant Administrator unless absolutely required.`;
  return { mode: 'full', layout: validateFullLayout(await generateJson(apiKey, prompt)) };
}

type AreaTarget = { categories: Array<{ id: string; name: string; channels: Array<{ id: string; name: string; type: string; topic?: string }> }>; channels: Array<{ id: string; name: string; type: string; topic?: string; categoryName?: string }> };

async function resolveAreaTargets(interaction: ModalSubmitInteraction, session: SetupSession): Promise<AreaTarget> {
  if (!interaction.guild || !session.selectedIds?.length) throw new Error('No selected channels');
  const guild = interaction.guild;
  const picked = await Promise.all(session.selectedIds.map((id) => guild.channels.fetch(id)));
  const categoriesPicked = picked.filter((channel): channel is import('discord.js').CategoryChannel => channel?.type === ChannelType.GuildCategory);
  const categoryIds = new Set(categoriesPicked.map((channel) => channel.id));
  const categories = categoriesPicked.map((category) => ({
    id: category.id,
    name: category.name,
    channels: [...guild.channels.cache.values()]
      .filter((channel) => channel.parentId === category.id && [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice].includes(channel.type))
      .map((channel) => ({ id: channel.id, name: channel.name, type: channel.type === ChannelType.GuildVoice ? 'voice' : 'text', topic: 'topic' in channel ? channel.topic ?? undefined : undefined })),
  }));
  const channels = picked
    .filter((channel): channel is GuildBasedChannel => !!channel && !categoryIds.has(channel.parentId ?? '') && !categoryIds.has(channel.id) && [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice].includes(channel.type))
    .map((channel) => ({
      id: channel.id,
      name: channel.name,
      type: channel.type === ChannelType.GuildVoice ? 'voice' : 'text',
      topic: 'topic' in channel ? channel.topic ?? undefined : undefined,
      categoryName: channel.parent?.name,
    }));
  if (!categories.length && !channels.length) throw new Error('The selected channels are unavailable');
  return { categories, channels };
}

async function generateAreaProposal(apiKey: string, interaction: ModalSubmitInteraction, session: SetupSession, request: string, language: string): Promise<SetupProposal> {
  const targets = await resolveAreaTargets(interaction, session);
  const prompt = `Refresh only the selected Discord channel areas. User request: "${request}". Language: ${language}.\n\nSelected category targets (keep exact IDs and same number/types of channels; update the category name and channel names/purposes in place): ${JSON.stringify(targets.categories)}\n\nSelected individual channels (keep exact IDs and channel types; update names and text-channel topics only): ${JSON.stringify(targets.channels)}\n\nReturn JSON only: {"categories":[{"id":"existing category id","name":"new category name","channels":[{"id":"existing child channel id","name":"new-channel-name","topic":"short purpose"}]}],"channels":[{"id":"selected channel id","name":"new-channel-name","topic":"short purpose for text channels"}]}. Include every supplied target ID exactly once and no other IDs. Categories are updated in place: do not add/remove channels or change channel types. Individual channels are updated in place. Keep names concise and Discord-safe. No role, permission, server-name, or unrelated-channel changes.`;
  const generated = await generateJson(apiKey, prompt);
  const categoryEdits = new Map<string, CategoryEdit>();
  for (const expected of targets.categories) {
    const category = (generated.categories ?? []).find((item: any) => item?.id === expected.id);
    if (!category || typeof category.name !== 'string' || !Array.isArray(category.channels)) throw new Error('Invalid category proposal');
    const channelEdits = expected.channels.map((channel) => {
      const edit = category.channels.find((item: any) => item?.id === channel.id);
      if (!edit || typeof edit.name !== 'string') throw new Error('Incomplete category proposal');
      return { id: channel.id, name: cleanChannelName(edit.name), ...(channel.type === 'text' && typeof edit.topic === 'string' ? { topic: edit.topic.slice(0, 1024) } : {}) };
    });
    categoryEdits.set(expected.id, { id: expected.id, name: cleanChannelName(category.name), channels: channelEdits });
  }
  const channelEdits = targets.channels.map((channel) => {
    const edit = (generated.channels ?? []).find((item: any) => item?.id === channel.id);
    if (!edit || typeof edit.name !== 'string') throw new Error('Incomplete selected-channel proposal');
    return { id: channel.id, name: cleanChannelName(edit.name), ...(channel.type === 'text' && typeof edit.topic === 'string' ? { topic: edit.topic.slice(0, 1024) } : {}) };
  });
  return { mode: 'area', categories: [...categoryEdits.values()], channels: channelEdits };
}

export function renderPreviewMessage(session: SetupSession) {
  const proposal = session.proposal;
  if (!proposal) throw new Error('No proposal in session');

  const sepChar = SEPARATOR_MAP[session.separator];
  const fontLabel = FONT_LABELS[session.font];

  let sampleChannels: string[] = [];
  if (proposal.mode === 'full') {
    const allChannels = proposal.layout.categories.flatMap((cat) =>
      cat.channels.map((ch) => ({ name: ch.name, type: ch.type }))
    );
    sampleChannels = allChannels.slice(0, 6).map((ch) =>
      `• ${formatChannelStyled(ch.name, session.separator, session.font, ch.type)}`
    );
  } else {
    const allChannels = [
      ...proposal.categories.flatMap((cat) => cat.channels.map((ch) => ({ name: ch.name, type: 'text' as const }))),
      ...proposal.channels.map((ch) => ({ name: ch.name, type: 'text' as const })),
    ];
    sampleChannels = allChannels.slice(0, 6).map((ch) =>
      `• ${formatChannelStyled(ch.name, session.separator, session.font, ch.type)}`
    );
  }

  const previewBox = sampleChannels.length > 0
    ? `\n\n**Channel Preview (Live Style):**\n${sampleChannels.join('\n')}`
    : '';

  const description = proposal.mode === 'full'
    ? `**${proposal.layout.serverName}**\n${proposal.layout.serverDescription ?? 'No description'}\n\n` +
      `${proposal.layout.categories.length} categories · ${proposal.layout.categories.reduce((total, category) => total + category.channels.length, 0)} channels · ${session.changeRoles ? `${proposal.layout.roles.length} roles will be regenerated` : 'existing roles preserved'}\n` +
      `Current style: Separator **${sepChar || 'None'}** · Font **${fontLabel}**${previewBox}\n\n` +
      `Select a different symbol or font below to update the preview live, or apply changes.`
    : `**Refresh Selected Areas**\n` +
      `Current style: Separator **${sepChar || 'None'}** · Font **${fontLabel}**${previewBox}\n\n` +
      summarizeAreaProposal(proposal, session) +
      `\n\nSelect a different symbol or font below to update the preview live, or apply changes.`;

  const container = new ContainerBuilder()
    .setAccentColor(proposal.mode === 'full' ? 0xf59e0b : 0x7c3aed)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## ${proposal.mode === 'full' ? 'Review the new server layout' : 'Review selected-area changes'}\n${description}`
      )
    );

  const sepSelect = new StringSelectMenuBuilder()
    .setCustomId(`setup_sep_${session.id}`)
    .setPlaceholder(`Separator: ${sepChar || 'None'}`)
    .addOptions([
      { label: '┃  Thick Pipe (Recommended)', value: 'thick_pipe', description: 'Clean & modern aesthetic (recommended)', default: session.separator === 'thick_pipe' },
      { label: '|  Standard Pipe', value: 'thin_pipe', description: 'Classic pipe separator', default: session.separator === 'thin_pipe' },
      { label: '・ Middle Dot', value: 'dot', description: 'Subtle middle dot', default: session.separator === 'dot' },
      { label: '― Dash / Bar', value: 'dash', description: 'Horizontal dash / bar', default: session.separator === 'dash' },
      { label: '› Arrow', value: 'arrow', description: 'Right-pointing arrow', default: session.separator === 'arrow' },
      { label: '» Double Arrow', value: 'double_arrow', description: 'Double arrow', default: session.separator === 'double_arrow' },
      { label: 'No Symbol', value: 'none', description: 'Space only between emoji and name', default: session.separator === 'none' },
    ]);

  const fontSelect = new StringSelectMenuBuilder()
    .setCustomId(`setup_font_${session.id}`)
    .setPlaceholder(`Font: ${fontLabel}`)
    .addOptions([
      { label: 'Small Caps (ɢɪᴠᴇᴀᴡᴀʏꜱ)', value: 'small_caps', description: 'Popular Discord small caps aesthetic', default: session.font === 'small_caps' },
      { label: 'Standard (giveaways)', value: 'normal', description: 'Default lowercase channel names', default: session.font === 'normal' },
      { label: 'Typewriter (𝚐𝚒ᴠ𝚎𝚊𝚠𝚊𝚢𝚜)', value: 'monospace', description: 'Monospace / typewriter font', default: session.font === 'monospace' },
      { label: 'Bold Sans (𝗴𝗶ᴠ𝒆𝗮𝘄𝗮𝘆𝘀)', value: 'bold', description: 'Bold modern sans-serif font', default: session.font === 'bold' },
      { label: 'Italic Sans (𝘨𝘪ᴠ𝒆ᴀ𝘸ᴀ𝘺𝘴)', value: 'italic', description: 'Italic sans-serif font', default: session.font === 'italic' },
    ]);

  const confirm = new ButtonBuilder()
    .setCustomId(`setup_confirm_${session.id}`)
    .setLabel('Apply these changes')
    .setStyle(ButtonStyle.Success);
  const cancel = new ButtonBuilder()
    .setCustomId(`setup_cancel_${session.id}`)
    .setLabel('Cancel')
    .setStyle(ButtonStyle.Secondary);

  return {
    components: [
      container,
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(sepSelect),
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(fontSelect),
      new ActionRowBuilder<ButtonBuilder>().addComponents(confirm, cancel),
    ] as any,
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
  };
}

export async function handleSetupStyleSelect(interaction: StringSelectMenuInteraction) {
  const customId = interaction.customId;
  const isSep = customId.startsWith('setup_sep_');
  const isFont = customId.startsWith('setup_font_');
  if (!isSep && !isFont) return;

  const id = customId.replace(isSep ? 'setup_sep_' : 'setup_font_', '');
  const session = getSession(id);
  if (!session || !canUseSession(interaction, session)) {
    await interaction.reply({ content: 'This setup session expired or belongs to another moderator. Run `/setup` again.', ephemeral: true });
    return;
  }

  const selectedValue = interaction.values[0];
  if (isSep) {
    session.separator = selectedValue as SeparatorStyle;
  } else if (isFont) {
    session.font = selectedValue as FontStyle;
  }

  const rendered = renderPreviewMessage(session);
  await interaction.update(rendered);
}

function cleanChannelName(name: string) {
  const cleaned = name.trim().replace(/[@#]/g, '').slice(0, 100);
  if (!cleaned) throw new Error('AI proposed an empty channel name');
  return cleaned;
}

function summarizeAreaProposal(proposal: Extract<SetupProposal, { mode: 'area' }>, session?: SetupSession) {
  const categoryLines = proposal.categories.map((category) => {
    const styledCat = session ? formatCategoryStyled(category.name, session.separator, session.font) : category.name;
    const styledChannels = category.channels.map((channel) => `#${session ? formatChannelStyled(channel.name, session.separator, session.font) : channel.name}`).join(', ');
    return `• **${styledCat}** - ${styledChannels || 'no channels'}`;
  });
  const channelLines = proposal.channels.map((channel) => {
    const styledName = session ? formatChannelStyled(channel.name, session.separator, session.font) : channel.name;
    return `• <#${channel.id}> -> **#${styledName}**`;
  });
  return `${[...categoryLines, ...channelLines].join('\n')}\n\nOnly these selected channel names, topics, and selected category names will change. Channel IDs, permissions, messages, roles, and all unselected areas stay untouched.`;
}

async function applyFullSetup(interaction: ButtonInteraction, session: SetupSession, parsed: FullLayout) {
  const guild = interaction.guild!;
  let deletedChannels = 0;
  let deletedRoles = 0;
  let createdChannels = 0;
  let createdRoles = 0;
  const channels = await guild.channels.fetch();
  for (const [id, channel] of channels) {
    if (channel && id !== interaction.channelId) {
      await channel.delete('Layer full server setup confirmed');
      deletedChannels++;
    }
  }
  if (session.changeRoles) {
    const roles = await guild.roles.fetch();
    for (const [id, role] of roles) {
      if (role?.editable && id !== guild.id) {
        await role.delete('Layer role rebuild confirmed');
        deletedRoles++;
      }
    }
  }

  const updateData: { name: string; description?: string; reason: string } = { name: parsed.serverName.slice(0, 100), reason: 'Layer AI setup confirmed' };
  if (guild.features.includes('COMMUNITY')) updateData.description = parsed.serverDescription?.slice(0, 120) ?? null as any;
  await guild.edit(updateData).catch((error) => console.warn('[Setup] Could not update server details:', error));

  if (session.changeRoles) {
    for (const role of parsed.roles) {
      const permissions = mapPermissions(role.permissions);
      const created = await guild.roles.create({
        name: role.name.slice(0, 100),
        color: /^#[0-9a-fA-F]{6}$/.test(role.color ?? '') ? role.color as `#${string}` : '#7c3aed',
        permissions,
        hoist: true,
        reason: `Layer setup - ${role.reason?.slice(0, 300) || 'Generated role'}`,
      });
      if (created) createdRoles++;
    }
  }

  for (const category of parsed.categories) {
    const styledCategoryName = cleanChannelName(formatCategoryStyled(category.name, session.separator, session.font));
    const parent = await guild.channels.create({ name: styledCategoryName, type: ChannelType.GuildCategory, reason: 'Layer setup confirmed' });
    for (const channel of category.channels) {
      const permissionOverwrites = channel.permissions === 'readonly'
        ? [{ id: guild.id, deny: [PermissionFlagsBits.SendMessages], allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AddReactions] }]
        : channel.permissions === 'staff-only'
          ? [{ id: guild.id, deny: [PermissionFlagsBits.ViewChannel] }, { id: guild.members.me!.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels] }]
          : undefined;
      const styledChannelName = cleanChannelName(formatChannelStyled(channel.name, session.separator, session.font, channel.type));
      await guild.channels.create({
        name: styledChannelName,
        type: channel.type === 'voice' ? ChannelType.GuildVoice : ChannelType.GuildText,
        parent: parent.id,
        topic: channel.type === 'text' ? channel.topic?.slice(0, 1024) : undefined,
        permissionOverwrites,
        reason: 'Layer setup confirmed',
      });
      createdChannels++;
    }
  }
  return `**${parsed.serverName}** has been generated.\n\nChannels removed: ${deletedChannels} · Channels created: ${createdChannels}${session.changeRoles ? `\nRoles removed: ${deletedRoles} · Roles created: ${createdRoles}` : '\nRoles: unchanged'}.`;
}

async function applyAreaSetup(interaction: ButtonInteraction, session: SetupSession, proposal: Extract<SetupProposal, { mode: 'area' }>) {
  const guild = interaction.guild!;
  let updated = 0;
  for (const categoryEdit of proposal.categories) {
    const category = await guild.channels.fetch(categoryEdit.id);
    if (!category || category.type !== ChannelType.GuildCategory) throw new Error('A selected category no longer exists');
    const styledCategoryName = cleanChannelName(formatCategoryStyled(categoryEdit.name, session.separator, session.font));
    await category.setName(styledCategoryName, 'Layer selected-area refresh confirmed');
    updated++;
    for (const edit of categoryEdit.channels) {
      const channel = await guild.channels.fetch(edit.id);
      if (!channel || channel.parentId !== category.id || !isEditableTextOrVoiceChannel(channel)) throw new Error('A selected channel changed before confirmation');
      const channelType = channel.type === ChannelType.GuildVoice ? 'voice' : 'text';
      const styledChannelName = cleanChannelName(formatChannelStyled(edit.name, session.separator, session.font, channelType));
      await applyChannelEdit(channel, { ...edit, name: styledChannelName });
      updated++;
    }
  }
  for (const edit of proposal.channels) {
    const channel = await guild.channels.fetch(edit.id);
    if (!channel || !isEditableTextOrVoiceChannel(channel)) throw new Error('A selected channel no longer exists');
    const channelType = channel.type === ChannelType.GuildVoice ? 'voice' : 'text';
    const styledChannelName = cleanChannelName(formatChannelStyled(edit.name, session.separator, session.font, channelType));
    await applyChannelEdit(channel, { ...edit, name: styledChannelName });
    updated++;
  }
  return `Layer refreshed **${updated} selected items** in place. Other server areas, roles, permissions, and messages were left unchanged.`;
}

function isEditableTextOrVoiceChannel(channel: GuildBasedChannel): channel is TextChannel | VoiceChannel {
  return channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement || channel.type === ChannelType.GuildVoice;
}

async function applyChannelEdit(channel: TextChannel | VoiceChannel, edit: ChannelEdit) {
  await channel.setName(edit.name, 'Layer selected-area refresh confirmed');
  if (channel.type !== ChannelType.GuildVoice && edit.topic !== undefined) {
    await (channel as TextChannel).setTopic(edit.topic, 'Layer selected-area refresh confirmed');
  }
}

function mapPermissions(permissionNames: string[] | undefined) {
  const mapping: Record<string, bigint> = {
    ADMINISTRATOR: PermissionFlagsBits.Administrator,
    MANAGE_CHANNELS: PermissionFlagsBits.ManageChannels,
    MANAGE_MESSAGES: PermissionFlagsBits.ManageMessages,
    KICK_MEMBERS: PermissionFlagsBits.KickMembers,
    BAN_MEMBERS: PermissionFlagsBits.BanMembers,
    MENTION_EVERYONE: PermissionFlagsBits.MentionEveryone,
    MANAGE_ROLES: PermissionFlagsBits.ManageRoles,
    MANAGE_GUILD: PermissionFlagsBits.ManageGuild,
    MANAGE_NICKNAMES: PermissionFlagsBits.ManageNicknames,
    ATTACH_FILES: PermissionFlagsBits.AttachFiles,
    EMBED_LINKS: PermissionFlagsBits.EmbedLinks,
    USE_EXTERNAL_EMOJIS: PermissionFlagsBits.UseExternalEmojis,
    MANAGE_EVENTS: PermissionFlagsBits.ManageEvents,
    CREATE_EVENTS: PermissionFlagsBits.CreateGuildExpressions,
  };
  return (permissionNames ?? []).flatMap((name) => mapping[name] ? [mapping[name]] : []);
}
