import { createRemoteJWKSet, jwtVerify } from 'jose';
import { createHash, timingSafeEqual } from 'node:crypto';

// Verifies a Supabase Auth access token against the project's JWKS and returns
// { id, email }. Throws on any problem; callers answer 401.
export function createJwksVerifier(config) {
  if (!config.jwksUrl || !config.supabaseUrl) throw new Error('SUPABASE_URL / SUPABASE_JWKS_URL are required');
  const jwks = createRemoteJWKSet(new URL(config.jwksUrl));
  return async token => {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: `${config.supabaseUrl}/auth/v1`,
      audience: 'authenticated',
    });
    if (typeof payload.sub !== 'string') throw new Error('no subject');
    return { id: payload.sub, email: payload.email ?? null };
  };
}

const digest = v => createHash('sha256').update(String(v)).digest();
export const safeEqual = (a, b) => typeof a === 'string' && typeof b === 'string' && timingSafeEqual(digest(a), digest(b));
