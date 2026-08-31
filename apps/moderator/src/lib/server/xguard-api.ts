import { error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';

// Config the lab's CLI cores need, read the way SvelteKit reads env. The cores fall back to
// `process.env`, which is populated in dev but not guaranteed under the node adapter — passing it
// explicitly is the difference between a route that works in prod and one that 500s there only.

export function labConnectionString(): string {
  const url = env.MODERATOR_DATABASE_URL;
  if (!url) error(500, 'MODERATOR_DATABASE_URL is not configured');

  // Consumers of this string build a bare `pg.Client`, which verifies the certificate chain. The
  // cnpg pooler presents a self-signed one, so `sslmode=require` fails there with
  // SELF_SIGNED_CERT_IN_CHAIN — encrypted-but-unverified is what this host needs. Rewriting it here
  // rather than at each call site because eval-core and rate-core each open their own connection.
  // An explicit `sslmode=disable` (a plain local docker Postgres) is left alone.
  try {
    const parsed = new URL(url);
    const sslmode = parsed.searchParams.get('sslmode');
    if (sslmode && sslmode !== 'disable' && sslmode !== 'no-verify') {
      parsed.searchParams.set('sslmode', 'no-verify');
      return parsed.toString();
    }
  } catch {
    // Not a parseable URL — hand it back untouched and let pg report the real problem.
  }
  return url;
}

export function orchestratorEnv() {
  return {
    endpoint: env.ORCHESTRATOR_ENDPOINT,
    token: env.ORCHESTRATOR_ACCESS_TOKEN ?? env.ORCHESTRATOR_TOKEN,
  };
}

export function clickhouseEnv() {
  return {
    host: env.CLICKHOUSE_HOST,
    username: env.CLICKHOUSE_USERNAME,
    password: env.CLICKHOUSE_PASSWORD,
  };
}

export function openrouterKey(): string {
  const key = env.OPENROUTER_API_KEY;
  if (!key) error(500, 'OPENROUTER_API_KEY is not configured');
  return key;
}

/** `@civitai/db` sets a process-global INT8 parser, so lab bigints arrive as numbers however LabDB types them. */
export function idOf(value: string | number): string {
  return String(value);
}
