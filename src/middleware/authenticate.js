import { jwtVerify } from 'jose';

const unauthorized = (res, message = 'Authentication is required.') =>
  res.status(401).json({ error: { code: 'UNAUTHORIZED', message } });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_TOKEN_LIFETIME_SECONDS = 24 * 60 * 60;

export function createAuthenticate({ db, env = process.env }) {
  return async function authenticate(req, res, next) {
    const match = /^Bearer\s+([^\s]+)$/i.exec(req.headers.authorization || '');
    if (!match) return unauthorized(res);

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
    } catch {
      return unauthorized(res, 'The access token is invalid or expired.');
    }

    // Database failures are server failures, not authentication failures.
    // Let the centralized Express error handler report them as 500s.
    try {
      const user = await db('directus_users')
        .select('id', 'email', 'status')
        .where({ id: payload.sub })
        .first();
      if (!user || user.status !== 'active') return unauthorized(res, 'The account is not active.');
      req.auth = { userId: String(user.id), email: user.email || null, claims: payload };
      return next();
    } catch (error) {
      return next(error);
    }
  };
}
