// Package-owned env schema for @civitai/email. Lazy + memoized — importing this module never
// touches process.env (base-package rule). Mirrors the EMAIL_* slice of the app's
// server-schema.ts. All fields optional: when any is missing the transport simply no-ops, so
// a bare import / build / test without mail secrets never throws or connects.
import * as z from 'zod';

// The truthy spellings the main app's env schema accepts for EMAIL_SECURE (`z.stringbool()`'s
// defaults, any case, or the number 1), so a value the app validates at boot means the same TLS mode
// here. Anything else, unset included, is false.
const SECURE_TRUE = new Set(['true', '1', 'yes', 'on', 'y', 'enabled']);
function parseSecure(x: unknown): boolean {
  if (typeof x === 'boolean') return x;
  if (typeof x === 'number') return x === 1;
  return typeof x === 'string' && SECURE_TRUE.has(x.toLowerCase());
}

const schema = z.object({
  EMAIL_HOST: z.string().optional(),
  EMAIL_PORT: z.preprocess((x) => (x ? parseInt(String(x)) : undefined), z.number().optional()),
  EMAIL_SECURE: z.preprocess(parseSecure, z.boolean()),
  EMAIL_USER: z.string().optional(),
  EMAIL_PASS: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  // `off` / `0` / `false` (any case) sends without the connect/greeting/socket timeouts client.ts sets (nodemailer's own defaults).
  EMAIL_TIMEOUTS: z.string().optional(),
});

function buildEnv() {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(
      '[@civitai/email] Invalid environment variables:\n' + z.prettifyError(parsed.error)
    );
  }
  return parsed.data;
}

export type EmailEnv = ReturnType<typeof buildEnv>;

let _env: EmailEnv | undefined;
export function loadEmailEnv(): EmailEnv {
  return (_env ??= buildEnv());
}
