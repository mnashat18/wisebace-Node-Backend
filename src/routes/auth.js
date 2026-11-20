import express from 'express';
import { normalizeEmail } from '../lib/email.js';

const attemptsByIp = new Map();
const WINDOW_MS = 60_000;
const MAX_REQUESTS = 10;
const MIN_RESPONSE_MS = 250;
const MAX_TRACKED_IPS = 2_000;
function clientIp(req) {
  return (typeof req.ip === 'string' && req.ip.trim()) ||
    (typeof req.socket?.remoteAddress === 'string' && req.socket.remoteAddress.trim()) || 'unknown';
}

function consumeRateLimit(ip, now = Date.now()) {
  const recent = (attemptsByIp.get(ip) || []).filter(timestamp => timestamp > now - WINDOW_MS);
  if (recent.length >= MAX_REQUESTS) {
    const retryAfter = Math.max(1, Math.ceil((recent[0] + WINDOW_MS - now) / 1000));
    attemptsByIp.set(ip, recent);
    return { allowed: false, retryAfter };
  }
  recent.push(now);
  attemptsByIp.set(ip, recent);
  if (attemptsByIp.size > MAX_TRACKED_IPS) {
    for (const [key, timestamps] of attemptsByIp) {
      if (!timestamps.some(timestamp => timestamp > now - WINDOW_MS)) attemptsByIp.delete(key);
      if (attemptsByIp.size <= MAX_TRACKED_IPS) break;
    }
  }
  return { allowed: true, retryAfter: 0 };
}

export function createEmailAvailabilityRouter({ db }) {
  const router = express.Router();
  router.post('/email-availability', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const ip = clientIp(req);
    const limit = consumeRateLimit(ip);
    if (!limit.allowed) {
      res.set('Retry-After', String(limit.retryAfter));
      return res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests. Please try again later.' } });
    }
    const startedAt = Date.now();
    const body = req.body;
    const contentType = String(req.headers['content-type'] || '').toLowerCase();
    if (!contentType.startsWith('application/json') || !body || typeof body !== 'object' ||
        Array.isArray(body) || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'email')) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'A JSON body containing only email is required.' } });
    }
    const email = normalizeEmail(body.email);
    if (!email) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'A valid email address is required.' } });
    try {
      const existing = await db('directus_users').select('id')
        .whereRaw('LOWER(TRIM(email)) = ?', [email]).first();
      const remaining = MIN_RESPONSE_MS - (Date.now() - startedAt);
      if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
      return res.status(200).json({ data: { available: !existing } });
    } catch {
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' } });
    }
  });
  return router;
}
