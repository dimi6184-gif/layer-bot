import { Client } from 'discord.js';
import { db } from '../db.js';
import { endGiveaway } from '../commands/fun/giveaway.js';

export function startGiveawayManager(client: Client) {
  console.log('[GiveawayManager] Starting giveaway manager...');

  // Check every 30 seconds
  setInterval(async () => {
    try {
      const now = new Date();

      // Find all giveaways that have ended but haven't been processed
      const expiredGiveaways = await db.giveaway.findMany({
        where: {
          ended: false,
          endsAt: {
            lte: now,
          },
        },
      });

      if (expiredGiveaways.length > 0) {
        console.log(`[GiveawayManager] Found ${expiredGiveaways.length} expired giveaway(s), ending...`);

        for (const giveaway of expiredGiveaways) {
          try {
            await endGiveaway(giveaway.id, client);
            console.log(`[GiveawayManager] ✅ Ended giveaway: ${giveaway.prize} in ${giveaway.guildId}`);
          } catch (error) {
            console.error(`[GiveawayManager] Failed to end giveaway ${giveaway.id}:`, error);
          }
        }
      }
    } catch (error) {
      console.error('[GiveawayManager] Error checking giveaways:', error);
    }
  }, 30 * 1000); // Check every 30 seconds

  console.log('Giveaway Manager: Started (checking every 30 seconds)');
}
