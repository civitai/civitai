import * as kyselyModule from '@civitai/db/kysely';

// Shared by the text-scan lab CLIs (import.ts, purge.ts).

// @civitai/db has no `"type": "module"`, so tsx loads it as CommonJS and its exports arrive on `default`.
export const { createKyselyClients } = (
  'default' in kyselyModule ? kyselyModule.default : kyselyModule
) as typeof kyselyModule;

/** A failure the CLI reports by its message alone. */
export class CliError extends Error {}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new CliError(`${name} not set`);
  return v;
}
