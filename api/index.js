import { getRequestListener } from '@hono/node-server';
import { createApp } from '../src/app.js';
import { createConfig } from '../src/config.js';
import { createSupabaseStore } from '../src/store-supabase.js';
import { createJwksVerifier } from '../src/auth.js';

const config = createConfig(process.env);
const app = createApp({
  config,
  store: createSupabaseStore(config),
  verifyToken: createJwksVerifier(config),
});

// Vercel Node function signature: (req, res)
export default getRequestListener(app.fetch);
