import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/** Constant-time check of an "Authorization: Bearer <secret>" header. */
export function bearerMatches(header: string | undefined, secret: string | undefined): boolean {
  if (!header || !secret) return false;
  // Hash both sides so the comparison has a fixed length and leaks nothing about the secret.
  const actual = createHash('sha256').update(header).digest();
  const expected = createHash('sha256').update(`Bearer ${secret}`).digest();
  return timingSafeEqual(actual, expected);
}

const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 20;
const failures = new Map<string, number[]>();

function clientKey(req: Request): string {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

/**
 * Every /api route requires its bearer secret. Rejects bad tokens before the route runs and
 * blocks a client address after repeated failures, so the secrets cannot be guessed.
 */
export function requireApiSecret(req: Request, res: Response, next: NextFunction) {
  if (!req.path.startsWith('/api/')) return next();

  const key = clientKey(req);
  const now = Date.now();
  const recent = (failures.get(key) ?? []).filter((t) => now - t < FAILURE_WINDOW_MS);
  if (recent.length >= MAX_FAILURES) {
    res.status(429).json({ error: 'Too many failed attempts.' });
    return;
  }

  const secret = req.path.startsWith('/api/guild-members/') ? process.env.MONITOR_API_SECRET : process.env.BOT_API_SECRET;
  if (!bearerMatches(req.headers.authorization, secret)) {
    recent.push(now);
    failures.set(key, recent);
    res.status(401).json({ error: 'Unauthorized.' });
    return;
  }
  failures.delete(key);
  next();
}

setInterval(() => {
  const now = Date.now();
  for (const [key, list] of failures) {
    if (!list.some((t) => now - t < FAILURE_WINDOW_MS)) failures.delete(key);
  }
}, FAILURE_WINDOW_MS).unref();
