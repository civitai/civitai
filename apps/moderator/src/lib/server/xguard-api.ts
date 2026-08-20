import { error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';

// Config the lab's CLI cores need, read the way SvelteKit reads env. The cores fall back to
// `process.env`, which is populated in dev but not guaranteed under the node adapter — passing it
// explicitly is the difference between a route that works in prod and one that 500s there only.

export function labConnectionString(): string {
  const url = env.MODERATOR_DATABASE_URL;
  if (!url) error(500, 'MODERATOR_DATABASE_URL is not configured');
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
