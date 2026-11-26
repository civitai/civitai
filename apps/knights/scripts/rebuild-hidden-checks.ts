import { createKyselyClients } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { assertLocalDatabase } from '../src/lib/dev/local-database';
import {
  checkedRetireSql,
  inlineSql,
  offlineDb,
  parseRebuildArgs,
  planHiddenRebuild,
  retirableIdsQuery,
  retireUnagreedHiddenChecks,
} from '../src/lib/server/trials/hidden-rebuild.service';

/**
 * Retires harvested hidden checks (or, with `--pool trials`, harvested trials references) that players do not agree
 * with. Changes status only, never deletes.
 * - `pnpm run rebuild:hidden-checks [--exclude <imageId,...>]`: dry run against the local database.
 * - `... --apply`: retire in one transaction, local database only.
 * - `... --print-sql [--exclude ...]`: print the SELECT of the ids to retire; with `--ids <id,...>` (that SELECT's
 *   result), print a transaction that retires exactly those ids and commits only if it did. Pass the same `--exclude` to both. Values are written in, and
 *   nothing connects to a database.
 */
async function main() {
  const args = parseRebuildArgs(process.argv.slice(2));
  const input = { now: new Date(), excludeImageIds: args.excludeImageIds, pool: args.pool };

  if (args.printSql) {
    const db = offlineDb();
    console.log(
      args.ids
        ? checkedRetireSql(db, { ...input, ids: args.ids })
        : `${inlineSql(retirableIdsQuery(db, input).compile())};`
    );
    console.log(`-- pool: ${args.pool}`);
    console.log(`-- excluded image ids: ${args.excludeImageIds.join(',') || 'none'}`);
    if (args.ids) console.log(`-- expect exactly ${args.ids.length} rows updated`);
    return;
  }

  const connectionString = process.env.DATABASE_URL;
  assertLocalDatabase(connectionString);
  const { db } = createKyselyClients<DB>({
    connectionString,
    sslNoVerify: true,
    singleClient: true,
    max: 1,
  });
  try {
    if (!args.apply) {
      const { ids, ...counts } = await planHiddenRebuild(db, input);
      console.log(JSON.stringify({ pool: args.pool, ...counts }));
      console.log(`Would retire: ${ids.join(',')}`);
      console.log('Dry run: nothing written.');
      return;
    }
    console.log(
      JSON.stringify({ pool: args.pool, ...(await retireUnagreedHiddenChecks(db, input)) })
    );
  } finally {
    await db.destroy();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
