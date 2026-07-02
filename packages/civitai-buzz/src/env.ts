// Package-owned env schema for @civitai/buzz. BUZZ_ENDPOINT is the base URL of the
// buzz service; required in prod, optional in dev (mirrors the app's server-schema slice).
import * as z from 'zod';

const isProd = process.env.NODE_ENV === 'production';

const schema = z.object({
  BUZZ_ENDPOINT: isProd ? z.url() : z.url().optional(),
});

function buildEnv() {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(
      '[@civitai/buzz] Invalid environment variables:\n' + z.prettifyError(parsed.error)
    );
  }
  return { endpoint: parsed.data.BUZZ_ENDPOINT, isProd };
}

export type BuzzConfig = ReturnType<typeof buildEnv>;

// Lazy + memoized: a bare import never touches process.env, so build/test/scripts don't
// throw. Validation runs only when a client first resolves the endpoint.
let _env: BuzzConfig | undefined;
export function loadBuzzEnv(): BuzzConfig {
  return (_env ??= buildEnv());
}
