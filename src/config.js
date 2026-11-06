export function createConfig(env = process.env, overrides = {}) {
  return {
    supabaseUrl: env.SUPABASE_URL || '',
    jwksUrl: env.SUPABASE_JWKS_URL || (env.SUPABASE_URL ? `${env.SUPABASE_URL}/auth/v1/.well-known/jwks.json` : ''),
    secretKey: env.SUPABASE_SECRET_KEY || '',
    deviceToken: env.DEVICE_TOKEN || '',
    pairingCode: env.PAIRING_CODE || '',
    deviceId: env.DEVICE_ID || 'toilet-01',
    allowedOrigins: (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
    anthropicKey: env.ANTHROPIC_API_KEY || '',
    anthropicModel: env.ANTHROPIC_MODEL || '',
    claimWindowMs: Number(env.CLAIM_WINDOW_MIN || 10) * 60_000,
    now: Date.now,
    fetchImpl: globalThis.fetch,
    ...overrides,
  };
}
