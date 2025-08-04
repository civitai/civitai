// @ts-check
/**
 * This file is included in `/next.config.mjs` which ensures the app isn't built with invalid env vars.
 * It has to be a `.mjs`-file to be imported there.
 */
import * as dotenv from 'dotenv';
import { env as clientEnv, formatErrors } from './client';
import { serverSchema } from './server-schema';

if (process.env.NODE_ENV === 'development') {
  dotenv.config({
    path: ['.env.development.local', '.env.local', '.env.development', '.env'],
    override: false,
  });
}

const _serverEnv = serverSchema.safeParse(process.env);

if (!_serverEnv.success) {
  console.error('❌ Invalid environment variables:\n', ...formatErrors(_serverEnv.error.format()));
  throw new Error('Invalid environment variables');
}

for (const key of Object.keys(_serverEnv.data)) {
  if (key.startsWith('NEXT_PUBLIC_')) {
    console.warn('❌ You are exposing a server-side env-variable:', key);

    throw new Error('You are exposing a server-side env-variable');
  }
}

if (process.env.NODE_ENV === 'development') {
  try {
    const dbUser = _serverEnv.data.DATABASE_URL.match(/postgresql:\/\/(\w+):.*/);
    if (!dbUser) {
      console.log('Unknown database connection');
    } else {
      console.log(
        `Using ${
          dbUser[1] === 'postgres'
            ? 'LOCAL'
            : dbUser[1] === 'doadmin'
            ? 'DEV'
            : dbUser[1] === 'civitai'
            ? 'PROD'
            : 'UNKNOWN'
        } database.`
      );
    }
  } catch {}
}

export const env = { ..._serverEnv.data, ...clientEnv };
