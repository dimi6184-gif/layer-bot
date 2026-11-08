import { Request, Response } from 'express';
import { bearerMatches } from '../utils/apiAuth.js';
import { Client, ChannelType, PermissionFlagsBits } from 'discord.js';

export async function autoLockServerHandler(req: Request, res: Response, client: Client) {
  try {
    // Auth check
    const authHeader = req.headers.authorization;
    const secret = process.env.BOT_API_SECRET;
    if (!secret) {
      console.error('[API] BOT_API_SECRET is not configured!');
      return res.status(500).send('Server misconfiguration');
    }
    if (!bearerMatches(authHeader, secret)) {
      return res.status(401).send('Unauthorized');
    }

    const { guildId, verifiedRoleId, verificationChannelId } = req.body;

    if (!guildId || !verifiedRoleId || !verificationChannelId) {
      return res.status(400).send('Missing required fields');
    }

    // Get guild
    const guild = await client.guilds.fetch(guildId);
    if (!guild) {
      return res.status(404).send('Guild not found');
    }

    // Get roles
    const everyoneRole = guild.roles.everyone;
    const verifiedRole = await guild.roles.fetch(verifiedRoleId);
    
    if (!verifiedRole) {
      return res.status(404).send('Verified role not found');
    }

    console.log(`[Auto-Lock] Starting server lock for ${guild.name}`);
    console.log(`[Auto-Lock] @everyone: ${everyoneRole.name}`);
    console.log(`[Auto-Lock] Verified Role: ${verifiedRole.name}`);
    console.log(`[Auto-Lock] Verification Channel: ${verificationChannelId}`);

    let channelsLocked = 0;
    const channels = await guild.channels.fetch();

    for (const [channelId, channel] of channels) {
      if (!channel) continue;

      // Skip categories, voice channels we don't want to lock
      if (channel.type === ChannelType.GuildCategory) continue;

      try {
        if (channelId === verificationChannelId) {
          // === VERIFICATION CHANNEL ===
          // @everyone CAN see and read
          // Verified role CANNOT see (hidden after verify)
          await channel.permissionOverwrites.edit(everyoneRole, {
            ViewChannel: true,
            SendMessages: false, // Can't send messages
            ReadMessageHistory: true,
          });

          await channel.permissionOverwrites.edit(verifiedRole, {
            ViewChannel: false, // Hide after verified
          });

          console.log(`[Auto-Lock] ✅ Verification channel configured: #${channel.name}`);
        } else {
          // === ALL OTHER CHANNELS ===
          // @everyone CANNOT see
          // Verified role CAN see
          await channel.permissionOverwrites.edit(everyoneRole, {
            ViewChannel: false,
          });

          await channel.permissionOverwrites.edit(verifiedRole, {
            ViewChannel: true,
          });

          channelsLocked++;
          console.log(`[Auto-Lock] 🔒 Locked: #${channel.name}`);
        }
      } catch (error: any) {
        console.error(`[Auto-Lock] Failed to lock #${channel.name}:`, error.message);
      }
    }

    console.log(`[Auto-Lock] ✅ Complete! Locked ${channelsLocked} channels`);

    res.status(200).json({ 
      success: true, 
      channelsLocked,
      message: `Successfully locked ${channelsLocked} channels. Only verified users can see them now!`
    });
  } catch (error: any) {
    console.error('[API] Error auto-locking server:', error);
    res.status(500).send(error.message || 'Internal server error');
  }
}
