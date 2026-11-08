import { Client, Message } from 'discord.js';
import { AIImageDetector } from '../utils/aiImageDetector';

export function setupAIImageDetection(client: Client): void {
  client.on('messageCreate', async (message: Message) => {
    // Ignore DMs
    if (!message.guild) return;

    // Ignore bots
    if (message.author.bot) return;

    // Check if message has images
    const hasImages = message.attachments.some(att => att.contentType?.startsWith('image/')) ||
                      message.embeds.some(embed => embed.image || embed.thumbnail);

    if (!hasImages) return;

    // Process message with AI detector
    try {
      await AIImageDetector.processMessage(message);
    } catch (error) {
      console.error('AI Image Detection Error:', error);
    }
  });

  console.log('✅ AI Image Detection Handler loaded');
}
