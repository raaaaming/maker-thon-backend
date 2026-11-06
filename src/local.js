import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { createConfig } from './config.js';
import { createSupabaseStore } from './store-supabase.js';
import { createJwksVerifier } from './auth.js';

const config = createConfig(process.env);
const app = createApp({ config, store: createSupabaseStore(config), verifyToken: createJwksVerifier(config) });
const port = Number(process.env.PORT || 3000);
serve({ fetch: app.fetch, port }, () => console.log(`backend: http://localhost:${port}`));
