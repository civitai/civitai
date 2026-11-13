/**
 * Wipes the text of test cases whose source entity or author was deleted, and drops draft-run results
 * past their expiry. Run it by hand; the app has no scheduler. Dry run by default; prints counts only.
 *
 *   pnpm exec tsx --env-file=.env apps/moderator/text-scan-test-sets/purge.ts [--write]
 *
 * Env: MODERATOR_DATABASE_URL (written) and DATABASE_REPLICA_URL (main database, read only).
 */
import type { DB as MainDB } from '@civitai/db-schema/kysely';
import type { DB as ModeratorDB } from '../src/lib/server/moderator-db/types';
import { expireDraftResults, purgeDeletedSources } from '../src/lib/server/text-scan-tests/sources';
import { createKyselyClients, describeDb, describeError, requireEnv } from './cli';

async function main() {
  const write = process.argv.slice(2).includes('--write');
  const moderatorUrl = requireEnv('MODERATOR_DATABASE_URL');
  const mainUrl = requireEnv('DATABASE_REPLICA_URL');
  console.log(
    JSON.stringify({ moderatorDb: describeDb(moderatorUrl), mainDb: describeDb(mainUrl), write })
  );
  const { db } = createKyselyClients<ModeratorDB>({
    connectionString: moderatorUrl,
    singleClient: true,
  });
  try {
    const { db: main } = createKyselyClients<MainDB>({
      connectionString: mainUrl,
      singleClient: true,
      sslNoVerify: true,
    });
    try {
      const sources = await purgeDeletedSources(db, main, { write });
      const drafts = await expireDraftResults(db, { write });
      console.log(JSON.stringify({ sources, drafts }));
      if (!write) console.log('dry run: nothing written.');
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
