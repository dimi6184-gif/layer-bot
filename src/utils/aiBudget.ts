// One Gemini key serves every guild, and scam image detection depends on it. These
// per-guild and per-user hourly caps stop one server or member from exhausting it.
const WINDOW_MS = 60 * 60 * 1000;
const GUILD_LIMIT = Number(process.env.AI_GUILD_HOURLY_LIMIT) || 120;
const USER_LIMIT = Number(process.env.AI_USER_HOURLY_LIMIT) || 20;

const calls = new Map<string, number[]>();

function recent(key: string, now: number): number[] {
  const list = (calls.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (list.length) calls.set(key, list);
  else calls.delete(key);
  return list;
}

/** Records one AI call and returns false when the guild or user is over its hourly budget. */
export function consumeAIBudget(guildId: string, userId: string): boolean {
  const now = Date.now();
  const guildCalls = recent(`g:${guildId}`, now);
  const userCalls = recent(`u:${guildId}:${userId}`, now);
  if (guildCalls.length >= GUILD_LIMIT || userCalls.length >= USER_LIMIT) return false;
  calls.set(`g:${guildId}`, [...guildCalls, now]);
  calls.set(`u:${guildId}:${userId}`, [...userCalls, now]);
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const key of calls.keys()) recent(key, now);
}, 10 * 60 * 1000).unref();
