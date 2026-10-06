/**
 * Wipes the text of text-scan test cases whose source entity or author account was deleted. Prints
 * counts only, never text. Idempotent; run it weekly — the spoke has no scheduler.
 *
 *   pnpm --filter @civitai/moderator-app exec tsx --env-file=.env text-scan-lab/purge.ts [--set <id>]
 *
 * Rules: `src/lib/server/text-scan-lab/purge.service.ts`. Opening a set's page and starting a run
 * purge that one set as well.
 *
 * Env: MODERATOR_DATABASE_URL (written) and DATABASE_REPLICA_URL (main database, read only).
 */
import * as kyselyModule from '@civitai/db/kysely';
import type { DB as MainDB } from '@civitai/db-schema/kysely';
import type { DB as ModeratorDB } from '../src/lib/server/moderator-db/types';
import { purgeDeletedSources } from '../src/lib/server/text-scan-lab/purge.service';

// @civitai/db has no `"type": "module"`, so tsx loads it as CommonJS and its exports arrive on `default`.
const { createKyselyClients } = (
  'default' in kyselyModule ? kyselyModule.default : kyselyModule
) as typeof kyselyModule;

class UsageError extends Error {}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new UsageError(`${name} not set`);
  return v;
}

function parseSetId(argv: string[]): number | undefined {
  const i = argv.indexOf('--set');
  if (i === -1) return undefined;
  const id = Number(argv[i + 1]);
  if (!Number.isInteger(id) || id < 1) throw new UsageError('--set needs a test set id');
  return id;
}

async function main() {
  const setId = parseSetId(process.argv.slice(2));
  const { db: moderator } = createKyselyClients<ModeratorDB>({
    connectionString: requireEnv('MODERATOR_DATABASE_URL'),
    singleClient: true,
  });
  try {
    const { db: main } = createKyselyClients<MainDB>({
      connectionString: requireEnv('DATABASE_REPLICA_URL'),
      singleClient: true,
      sslNoVerify: true,
    });
    try {
      const counts = await purgeDeletedSources({ moderator, main }, setId);
      console.log(JSON.stringify({ setId: setId ?? 'all', ...counts }));
    } finally {
      await main.destroy();
    }
  } finally {
    await moderator.destroy();
  }
}

main().catch((err) => {
  console.error(err instanceof UsageError ? err.message : (err as Error)?.message ?? err);
  process.exit(1);
});
