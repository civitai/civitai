// Package-owned env schema for @civitai/email. Lazy + memoized — importing this module never
// touches process.env (base-package rule). Mirrors the EMAIL_* slice of the app's
// server-schema.ts. All fields optional: when any is missing the transport simply no-ops, so
// a bare import / build / test without mail secrets never throws or connects.
import * as z from 'zod';

const schema = z.object({
  EMAIL_HOST: z.string().optional(),
  EMAIL_PORT: z.preprocess((x) => (x ? parseInt(String(x)) : undefined), z.number().optional()),
  EMAIL_SECURE: z.preprocess((x) => x === 'true' || x === true, z.boolean().default(false)),
  EMAIL_USER: z.string().optional(),
  EMAIL_PASS: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
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
