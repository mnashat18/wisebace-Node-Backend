import { jwtVerify } from 'jose';

const unauthorized = (res, message = 'Authentication is required.') =>
  res.status(401).json({ error: { code: 'UNAUTHORIZED', message } });

export function createAuthenticate({ db, env = process.env }) {
  return async function authenticate(req, res, next) {
    const match = /^Bearer\s+([^\s]+)$/i.exec(req.headers.authorization || '');
    if (!match) return unauthorized(res);
    const secret = env.AUTH_JWT_SECRET;
    if (!secret || Buffer.byteLength(secret) < 32) {
      return res.status(503).json({ error: { code: 'AUTH_NOT_CONFIGURED', message: 'Authentication is not configured.' } });
    }
    try {
      const options = { algorithms: ['HS256'] };
      if (env.AUTH_JWT_ISSUER) options.issuer = env.AUTH_JWT_ISSUER;
      if (env.AUTH_JWT_AUDIENCE) options.audience = env.AUTH_JWT_AUDIENCE;
      const { payload } = await jwtVerify(match[1], new TextEncoder().encode(secret), options);
      const userId = typeof payload.sub === 'string' ? payload.sub : '';
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId)) {
        return unauthorized(res, 'The access token subject is invalid.');
      }
      const user = await db('directus_users').select('id', 'email', 'status').where({ id: userId }).first();
      if (!user || user.status !== 'active') return unauthorized(res, 'The account is not active.');
      req.auth = { userId: String(user.id), email: user.email || null, claims: payload };
      return next();
    } catch {
      return unauthorized(res, 'The access token is invalid or expired.');
    }
  };
}
