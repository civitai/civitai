/**
 * Wipes the text of test cases whose source entity or author was deleted, and drops draft-run results
 * past their 90 days. Run it by hand (weekly); the app has no scheduler. Prints counts only.
 *
 *   pnpm exec tsx --env-file=.env apps/moderator/text-scan-test-sets/purge.ts
 *
 * Env: MODERATOR_DATABASE_URL (written) and DATABASE_REPLICA_URL (main database, read only).
 */
import type { DB as MainDB } from '@civitai/db-schema/kysely';
import type { DB as ModeratorDB } from '../src/lib/server/moderator-db/types';
import { expireDraftResults, purgeDeletedSources } from '../src/lib/server/text-scan-tests/sources';
import { createKyselyClients, describeError, requireEnv } from './cli';

async function main() {
  const { db } = createKyselyClients<ModeratorDB>({
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
      const sources = await purgeDeletedSources(db, main);
      const drafts = await expireDraftResults(db);
      console.log(JSON.stringify({ sources, drafts }));
    } finally {
      await main.destroy();
    }
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  console.error(describeError(err));
  process.exit(1);
});
