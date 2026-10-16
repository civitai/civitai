import * as kyselyModule from '@civitai/db/kysely';

// @civitai/db has no `"type": "module"`, so tsx loads it as CommonJS and its exports arrive on `default`.
export const { createKyselyClients } = (
  'default' in kyselyModule ? kyselyModule.default : kyselyModule
) as typeof kyselyModule;

export class CliError extends Error {}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new CliError(`${name} not set`);
  return value;
}

export function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const value = argv[i + 1];
  if (value === undefined || value.startsWith('--')) throw new CliError(`${name} needs a value`);
  return value;
}

/** Host, port and database only — never the credentials. */
export function describeDb(connectionString: string): string {
  const u = new URL(connectionString);
  return `${u.hostname}:${u.port || 5432}${u.pathname}`;
}

export function describeError(e: unknown): string {
  if (e instanceof CliError) return e.message;
  const { code, constraint, status, message } = (e ?? {}) as Record<string, unknown>;
  if (typeof status === 'number' && typeof message === 'string') return message;
  // Postgres errors fall through to code + constraint only: the message quotes the failing row,
  // which can hold case text.
  return JSON.stringify({ code: code ?? 'unknown', constraint: constraint ?? null });
}
