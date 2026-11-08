import { SlashCommandBuilder, ChatInputCommandInteraction, ButtonBuilder, ButtonStyle } from 'discord.js';
import { buildCV2 } from '../../utils/cv2.js';

export const data = new SlashCommandBuilder()
  .setName('help')
  .setDescription('Shows a clean, comprehensive overview of Layer features and commands.');

export async function execute(interaction: ChatInputCommandInteraction) {
  const dashboardButton = new ButtonBuilder()
    .setLabel('Dashboard')
    .setURL('https://uselayer.de/dashboard')
    .setStyle(ButtonStyle.Link)
    .setEmoji('⚡');

  const privacyButton = new ButtonBuilder()
    .setLabel('Privacy Policy')
    .setURL('https://uselayer.de/privacy')
    .setStyle(ButtonStyle.Link)
    .setEmoji('🛡️');

  const websiteButton = new ButtonBuilder()
    .setLabel('Website')
    .setURL('https://uselayer.de')
    .setStyle(ButtonStyle.Link)
    .setEmoji('🌐');

  const inviteButton = new ButtonBuilder()
    .setLabel('Invite Layer')
    .setURL('https://uselayer.de/invite')
    .setStyle(ButtonStyle.Link)
    .setEmoji('➕');

  await interaction.reply(
    buildCV2({
      title: 'Layer: Security & Command Reference',
      description: 'The smart AI security, privacy-first verification, and community bot for Discord.\nManage modules, live telemetry, and server settings at [uselayer.de/dashboard](https://uselayer.de/dashboard).',
      accentColor: 0x7c3aed,
      thumbnail: interaction.client.user?.displayAvatarURL({ size: 128 }) ?? 'https://uselayer.de/logo.png',
      fields: [
        {
          label: '🛡️ Privacy-First Verification & GDPR Self-Service',
          value: '• `/verification` - Deploy the zero-knowledge browser fingerprint verification portal (0.2s alt-account detection, ban evasion blocker, zero raw IP storage).\n• `/privacy status` - Inspect your active verification signatures & stored tokens.\n• `/privacy delete` - Instantly erase all your verification hashes & session data (GDPR Art. 17).',
        },
        {
          label: '🚨 Anti-Raid & Emergency Shield',
          value: '• `/antiraid status` - View live raid status and join velocity metrics.\n• `/antiraid lockdown` - Temporarily pause server onboarding & new member verification.\n• `/antiraid panic` - Emergency purge and kick of suspected mass raid accounts.\n• `/antiraid clean` - Clean up raid remnants and prune unverified joiners.',
        },
        {
          label: '🎣 2026 Phishing & Threat Guard',
          value: '• Automated homoglyph, typosquatting & token-grabber link deletion (<5ms).\n• Fast-path Discord & Steam phishing blocker with Gemini AI context analysis.',
        },
        {
          label: '🔨 Moderation & Audit Controls',
          value: '• `/warn` & `/warnings` - Issue and review member infraction history.\n• `/mute` • `/kick` • `/ban` - Fast moderation actions with audit logging.\n• `/clear` - Purge up to 100 messages.\n• `/ghostclean` - Identify and prune inactive / ghost members.\n• `/avatarhistory` - Audit past avatars and username changes.',
        },
        {
          label: '🎫 Support Tickets',
          value: '• `/ticket` - Open modal-driven support tickets with automated staff alerts, live transcripts, and smart category routing.',
        },
        {
          label: '🤖 Gemini AI Assistance',
          value: '• `/ask` - Prompt Layer\'s integrated Gemini AI model for answers and assistance.\n• `/setup` - Interactive guild setup wizard to configure channels and roles.',
        },
        {
          label: '🎉 Community & Leveling',
          value: '• `/rank` & `/leaderboard` - XP tracking, level progression & server leaderboard.\n• `/achievements` - Server milestones and unlockable badges.\n• `/giveaway` - Create automated, provably fair community giveaways.\n• `/poll` - Interactive multi-choice or reaction polling.',
        },
        {
          label: 'ℹ️ Information & Telemetry',
          value: '• `/serverinfo` - Guild stats, creation date, boost tier & security state.\n• `/userinfo` - Member profile, account age, assigned roles & permissions.',
        },
      ],
      buttons: [dashboardButton, privacyButton, websiteButton, inviteButton],
    })
  );
}
