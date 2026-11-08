import { db } from '../db.js';

const DEFAULT_EMBED_COLOR = 0x5865f2;

export async function getGuildEmbedColor(guildId: string): Promise<number> {
  try {
    const settings = await db.guild.findUnique({
      where: { discordId: guildId },
      select: { embedColor: true },
    });
    const color = settings?.embedColor;
    return color && /^#[0-9A-Fa-f]{6}$/.test(color)
      ? Number.parseInt(color.slice(1), 16)
      : DEFAULT_EMBED_COLOR;
  } catch (error) {
    console.error('[EmbedColor] Error loading server embed color:', error);
    return DEFAULT_EMBED_COLOR;
  }
}
