// Package-owned env schema for @civitai/clickhouse. Mirrors the clickhouse slice of
// the app's server-schema.ts (host/user/pass are required in prod, optional in dev).
import * as z from 'zod';

const isProd = process.env.NODE_ENV === 'production';

const schema = z.object({
  CLICKHOUSE_HOST: isProd ? z.string() : z.string().optional(),
  CLICKHOUSE_USERNAME: isProd ? z.string() : z.string().optional(),
  CLICKHOUSE_PASSWORD: isProd ? z.string() : z.string().optional(),
});

// Normalized, env-derived defaults. The factory accepts a Partial<ClickhouseConfig>.
function buildEnv() {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(
      '[@civitai/clickhouse] Invalid environment variables:\n' + z.prettifyError(parsed.error)
    );
  }
  return {
    host: parsed.data.CLICKHOUSE_HOST,
    username: parsed.data.CLICKHOUSE_USERNAME,
    password: parsed.data.CLICKHOUSE_PASSWORD,
    isProd,
  };
}

export type ClickhouseConfig = ReturnType<typeof buildEnv>;

// Lazy + memoized: importing this module never touches process.env (beyond NODE_ENV for
// the schema shape). Validation runs only when the factory calls loadClickhouseEnv(), so a
// bare import (build, script, test) never throws. Parsed once, then cached.
let _env: ClickhouseConfig | undefined;
export function loadClickhouseEnv(): ClickhouseConfig {
  return (_env ??= buildEnv());
}
