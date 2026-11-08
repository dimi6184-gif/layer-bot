import axios from 'axios';
import { EmbedBuilder, Message, TextChannel } from 'discord.js';
import { db } from '../db.js';

// Hugging Face API für AI Image Detection
const HF_API_KEY = process.env.HUGGINGFACE_API_KEY;
const AI_DETECTION_MODEL = 'umm-maybe/AI-image-detector';
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGES_PER_MESSAGE = 5;

function isAllowedImageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const isDiscordCdn = hostname === 'discordapp.com'
      || hostname.endsWith('.discordapp.com')
      || hostname === 'discordapp.net'
      || hostname.endsWith('.discordapp.net');

    return url.protocol === 'https:'
      && !url.username
      && !url.password
      && isDiscordCdn;
  } catch {
    return false;
  }
}

interface DetectionResult {
  isAI: boolean;
  confidence: number;
  label: string;
}

export class AIImageDetector {
  /**
   * Analysiert ein Bild und gibt zurück ob es KI-generiert ist
   */
  static async detectAIImage(imageUrl: string): Promise<DetectionResult> {
    try {
      if (!isAllowedImageUrl(imageUrl)) {
        return { isAI: false, confidence: 0, label: 'unsupported image host' };
      }

      // Download image
      const imageResponse = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
        timeout: 10000,
        maxRedirects: 0,
        maxContentLength: MAX_IMAGE_BYTES,
        maxBodyLength: MAX_IMAGE_BYTES,
      });

      const contentType = String(imageResponse.headers['content-type'] || '').toLowerCase();
      if (!contentType.startsWith('image/')) {
        return { isAI: false, confidence: 0, label: 'not an image' };
      }

      // Call Hugging Face API
      const response = await axios.post(
        `https://api-inference.huggingface.co/models/${AI_DETECTION_MODEL}`,
        imageResponse.data,
        {
          headers: {
            'Authorization': `Bearer ${HF_API_KEY}`,
            'Content-Type': 'application/octet-stream',
          },
          timeout: 15000,
        }
      );

      // Parse response
      const results = response.data;
      
      // Find AI label (can be "artificial" or "ai-generated" depending on model)
      const aiResult = results.find((r: any) => 
        r.label.toLowerCase().includes('artificial') || 
        r.label.toLowerCase().includes('ai') ||
        r.label.toLowerCase().includes('generated')
      );

      if (aiResult) {
        return {
          isAI: aiResult.score > 0.5,
          confidence: Math.round(aiResult.score * 100),
          label: aiResult.label,
        };
      }

      // Fallback
      return {
        isAI: false,
        confidence: 0,
        label: 'unknown',
      };
    } catch (error) {
      console.error('AI Detection Error:', error);
      // Return safe default on error
      return {
        isAI: false,
        confidence: 0,
        label: 'error',
      };
    }
  }

  /**
   * Prüft ob eine Nachricht KI-Kennzeichnungen enthält
   */
  static hasAILabel(content: string): boolean {
    const aiMarkers = [
      '[ai]',
      '[ki]',
      '🤖',
      'ai generated',
      'ki generiert',
      'made with ai',
      'created with ai',
    ];

    const lowerContent = content.toLowerCase();
    return aiMarkers.some(marker => lowerContent.includes(marker));
  }

  /**
   * Verarbeitet eine Nachricht und prüft alle Bilder
   */
  static async processMessage(message: Message): Promise<void> {
    // Ignore bots
    if (message.author.bot) return;

    // Get guild settings
    const guild = await db.guild.findUnique({
      where: { discordId: message.guild!.id },
      select: {
        aiImageDetectionEnabled: true,
        aiDetectionThreshold: true,
        aiDetectionAction: true,
        aiDetectionLogChannelId: true,
        aiDetectionDeleteChannelIds: true,
        aiDetectionWhitelistRoleIds: true,
        aiDetectionRequireLabel: true,
      },
    });

    if (!guild || !guild.aiImageDetectionEnabled) return;

    // Check if user has whitelist role
    const member = message.member;
    if (member && guild.aiDetectionWhitelistRoleIds?.length) {
      const hasWhitelistRole = member.roles.cache.some(role =>
        guild.aiDetectionWhitelistRoleIds!.includes(role.id)
      );
      if (hasWhitelistRole) return;
    }

    // Check if channel should be monitored for deletion
    const shouldDelete = guild.aiDetectionAction === 'delete' &&
      guild.aiDetectionDeleteChannelIds?.includes(message.channel.id);

    // Extract image URLs from message
    const imageUrls: string[] = [];
    const addImageUrl = (url: string | undefined) => {
      if (url && isAllowedImageUrl(url) && !imageUrls.includes(url) && imageUrls.length < MAX_IMAGES_PER_MESSAGE) {
        imageUrls.push(url);
      }
    };

    // Check attachments
    message.attachments.forEach(attachment => {
      if (attachment.contentType?.startsWith('image/')) {
        addImageUrl(attachment.url);
      }
    });

    // Check embeds
    message.embeds.forEach(embed => {
      addImageUrl(embed.image?.proxyURL || embed.image?.url);
      addImageUrl(embed.thumbnail?.proxyURL || embed.thumbnail?.url);
    });

    if (imageUrls.length === 0) return;

    // Check if message has AI label (if required)
    const hasLabel = this.hasAILabel(message.content);
    
    // Scan each image
    for (const imageUrl of imageUrls) {
      try {
        const result = await this.detectAIImage(imageUrl);

        // Check if confidence is above threshold
        if (result.confidence < (guild.aiDetectionThreshold || 70)) continue;

        // A required AI label exempts images the user explicitly marked as AI.
        const isExemptByLabel = guild.aiDetectionRequireLabel && hasLabel;
        let actionTaken = 'log';

        if (!isExemptByLabel && guild.aiDetectionAction === 'delete' && shouldDelete) {
          await message.delete();
          await this.sendWarningDM(message, result.confidence, 'deleted');
          actionTaken = 'deleted';
        } else if (!isExemptByLabel && guild.aiDetectionAction === 'warn') {
          await message.react('⚠️');
          await this.sendWarningDM(message, result.confidence, 'warned');
          actionTaken = 'warned';
        }

        // Log using the actual AIImageDetection schema fields.
        await db.aIImageDetection.create({
          data: {
            guildId: message.guild!.id,
            channelId: message.channel.id,
            messageId: message.id,
            userId: message.author.id,
            username: message.author.username,
            imageUrl,
            confidence: result.confidence,
            aiLabels: [result.label, hasLabel ? 'labeled' : 'unlabeled'].filter(Boolean),
            actionTaken,
          },
        });

        // Send to log channel if configured
        if (guild.aiDetectionLogChannelId) {
          await this.sendLogEmbed(
            message,
            imageUrl,
            result.confidence,
            hasLabel,
            guild.aiDetectionLogChannelId
          );
        }
      } catch (error) {
        console.error('Error processing image:', error);
      }
    }
  }

  /**
   * Sendet ein Log-Embed in den konfigurierten Kanal
   */
  private static async sendLogEmbed(
    message: Message,
    imageUrl: string,
    confidence: number,
    hasLabel: boolean,
    logChannelId: string
  ): Promise<void> {
    try {
      const logChannel = message.guild!.channels.cache.get(logChannelId) as TextChannel;
      if (!logChannel) return;

      const embed = new EmbedBuilder()
        .setTitle('🤖 AI-Bild erkannt')
        .setColor(confidence >= 90 ? 0xff0000 : confidence >= 80 ? 0xff6600 : 0xffcc00)
        .setDescription(`Ein Bild wurde als KI-generiert erkannt`)
        .addFields([
          {
            name: '📊 Konfidenz',
            value: `**${confidence}%**`,
            inline: true,
          },
          {
            name: '👤 User',
            value: `${message.author} (${message.author.tag})`,
            inline: true,
          },
          {
            name: '📍 Kanal',
            value: `${message.channel}`,
            inline: true,
          },
          {
            name: '🏷️ KI-Kennzeichnung',
            value: hasLabel ? '✅ Ja' : '❌ Nein',
            inline: true,
          },
          {
            name: '🔗 Nachricht',
            value: `[Zur Nachricht](${message.url})`,
            inline: true,
          },
        ])
        .setImage(imageUrl)
        .setTimestamp()
        .setFooter({ text: 'Layer AI Detection' });

      await logChannel.send({ embeds: [embed] });
    } catch (error) {
      console.error('Error sending log embed:', error);
    }
  }

  /**
   * Sendet eine Warnung per DM an den User
   */
  private static async sendWarningDM(
    message: Message,
    confidence: number,
    action: 'warned' | 'deleted'
  ): Promise<void> {
    try {
      const embed = new EmbedBuilder()
        .setTitle('⚠️ AI-Bilderkennung')
        .setColor(0xff6600)
        .setDescription(
          action === 'deleted'
            ? `Deine Nachricht wurde gelöscht, weil ein KI-generiertes Bild erkannt wurde (${confidence}% Konfidenz).`
            : `Deine Nachricht enthält möglicherweise ein KI-generiertes Bild (${confidence}% Konfidenz).`
        )
        .addFields([
          {
            name: '📝 Tipp',
            value: 'Kennzeichne KI-Bilder mit **[AI]** oder 🤖 in deiner Nachricht, um Missverständnisse zu vermeiden.',
          },
        ])
        .setFooter({ text: `Server: ${message.guild!.name}` })
        .setTimestamp();

      await message.author.send({ embeds: [embed] });
    } catch (error) {
      // User has DMs disabled or blocked bot
      console.log('Could not send DM to user:', message.author.tag);
    }
  }
}
