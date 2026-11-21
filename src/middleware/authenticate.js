import { jwtVerify } from 'jose';

const unauthorized = (res, message = 'Authentication is required.') =>
  res.status(401).json({ error: { code: 'UNAUTHORIZED', message } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_TOKEN_LIFETIME_SECONDS = 24 * 60 * 60;

async function resolveDirectusIdentity(token, { env, fetchImpl }) {
  const base = String(env.DIRECTUS_URL || '').trim().replace(/\/$/, '');
  if (!base) {
    const error = new Error('Directus authentication is not configured.');
    error.status = 503; error.code = 'DIRECTUS_AUTH_NOT_CONFIGURED'; throw error;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetchImpl(base + '/users/me?fields=id,email,status', {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
      signal: controller.signal
    });
    if (response.status === 401 || response.status === 403) return null;
    if (!response.ok) {
      const error = new Error('Directus identity service is unavailable.');
      error.status = 503; error.code = 'DIRECTUS_AUTH_UNAVAILABLE'; throw error;
    }
    const body = await response.json();
    const user = body?.data;
    if (!user || typeof user.id !== 'string' || !UUID.test(user.id)) return null;
    return { userId: user.id, email: typeof user.email === 'string' ? user.email : null };
  } catch (error) {
    if (error.status) throw error;
    const unavailable = new Error('Directus identity service is unavailable.');
    unavailable.status = 503; unavailable.code = 'DIRECTUS_AUTH_UNAVAILABLE'; throw unavailable;
  } finally {
    clearTimeout(timeout);
  }
}

export function createAuthenticate({ db, env = process.env, fetchImpl = fetch }) {
  return async function authenticate(req, res, next) {
    const match = /^Bearer\s+([^\s]+)$/i.exec(req.headers.authorization || '');
    if (!match) return unauthorized(res);

    let identity;
    if (String(env.AUTH_MODE || 'standalone').toLowerCase() === 'directus') {
      try {
        identity = await resolveDirectusIdentity(match[1], { env, fetchImpl });
        if (!identity) return unauthorized(res, 'The Directus access token is invalid or expired.');
      } catch (error) {
        return res.status(error.status || 503).json({ error: {
          code: error.code || 'AUTH_SERVICE_UNAVAILABLE',
          message: 'Authentication service is temporarily unavailable.'
        } });
      }
    } else {
      const secret = env.AUTH_JWT_SECRET;
      if (!secret || Buffer.byteLength(secret) < 32) {
        return res.status(503).json({ error: { code: 'AUTH_NOT_CONFIGURED', message: 'Authentication is not configured.' } });
      }
      let payload;
      try {
        const options = { algorithms: ['HS256'] };
        if (env.AUTH_JWT_ISSUER) options.issuer = env.AUTH_JWT_ISSUER;
        if (env.AUTH_JWT_AUDIENCE) options.audience = env.AUTH_JWT_AUDIENCE;
        ({ payload } = await jwtVerify(match[1], new TextEncoder().encode(secret), options));
        const now = Math.floor(Date.now() / 1000);
        if (!Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp)
          || payload.exp <= now || payload.exp <= payload.iat
          || payload.exp - payload.iat > MAX_TOKEN_LIFETIME_SECONDS) {
          return unauthorized(res, 'The access token lifetime is invalid.');
        }
        if (typeof payload.sub !== 'string' || !UUID.test(payload.sub)) {
          return unauthorized(res, 'The access token subject is invalid.');
        }
        identity = { userId: payload.sub, email: null, claims: payload };
      } catch {
        return unauthorized(res, 'The access token is invalid or expired.');
      }
    }

    try {
      const user = await db('directus_users')
        .select('id', 'email', 'status')
        .where({ id: identity.userId })
        .first();
      if (!user || user.status !== 'active') return unauthorized(res, 'The account is not active.');
      req.auth = {
        userId: String(user.id),
        email: user.email || identity.email || null,
        ...(identity.claims ? { claims: identity.claims } : {}),
        provider: String(env.AUTH_MODE || 'standalone').toLowerCase()
      };
      return next();
    } catch (error) {
      return next(error);
    }
  };
}
