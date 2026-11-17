import { createKyselyClients } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { assertLocalDatabase } from '../src/lib/dev/local-database';
import {
  planHiddenRebuild,
  retireUnagreedHiddenChecks,
  retireUnagreedQuery,
} from '../src/lib/server/trials/hidden-rebuild.service';

/**
 * Retires harvested hidden checks that players do not agree with:
 * `pnpm run rebuild:hidden-checks [--apply] [--exclude <imageId,...>] [--print-sql]`.
 * A dry run by default; `--print-sql` prints the exact update for a reviewed run elsewhere. Counts only, never deletes.
 */
async function main() {
  const connectionString = process.env.DATABASE_URL;
  assertLocalDatabase(connectionString);

  const args = process.argv.slice(2);
  const flag = (name: string) => args.indexOf(name);
  const excludeAt = flag('--exclude');
  const excludeImageIds =
    excludeAt >= 0 ? (args[excludeAt + 1] ?? '').split(',').filter(Boolean).map(Number) : [];
  if (excludeImageIds.some((id) => !Number.isInteger(id) || id <= 0)) {
    throw new Error('--exclude takes a comma-separated list of image ids.');
  }
  const input = { now: new Date(), excludeImageIds };

  const { db } = createKyselyClients<DB>({
    connectionString,
    sslNoVerify: true,
    singleClient: true,
    max: 1,
  });
  try {
    if (flag('--print-sql') >= 0) {
      const { sql, parameters } = retireUnagreedQuery(db, input).compile();
      console.log(sql);
      console.log(JSON.stringify(parameters));
    }
    if (flag('--apply') < 0) {
      console.log(JSON.stringify(await planHiddenRebuild(db, input)));
      console.log('Dry run: nothing written.');
      return;
    }
    console.log(JSON.stringify(await retireUnagreedHiddenChecks(db, input)));
  } finally {
    await db.destroy();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
