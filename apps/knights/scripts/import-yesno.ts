import { readFileSync } from 'node:fs';
import * as dbKysely from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { assertLocalDatabase } from '../src/lib/dev/local-database';
import { parseCsv } from '../src/lib/server/yesno/csv';
import { importYesNo, toYesNoRows } from '../src/lib/server/yesno/import';

/**
 * Imports yes/no questions from a CSV by hand: `pnpm run import:yesno <file.csv> [--dry-run]`.
 * Idempotent (keyed by `question_id`), prints counts only, and writes no data into the repository.
 */
async function main() {
  const connectionString = process.env.DATABASE_URL;
  assertLocalDatabase(connectionString);

  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const file = args.find((arg) => !arg.startsWith('--'));
  if (!file) throw new Error('Pass the path of the CSV file.');

  const records = parseCsv(readFileSync(file, 'utf8'));
  const { rows, skipped, retire } = toYesNoRows(records);
  const players = rows.filter((r) => r.audience === 'players').length;
  console.log(
    `${records.length} rows read: ${rows.length} to import (${players} for players, ${
      rows.length - players
    } for moderators), skipped ${JSON.stringify(skipped)}.`
  );
  if (dryRun) {
    console.log('Dry run: nothing written.');
    return;
  }

  const { createKyselyClients } = (dbKysely as { default?: typeof dbKysely }).default ?? dbKysely;
  const { db } = createKyselyClients<DB>({
    connectionString,
    sslNoVerify: true,
    singleClient: true,
    max: 1,
  });
  try {
    const result = await importYesNo(db, rows, { retire });
    console.log(
      `${result.axes} axes; ${result.inserted} inserted, ${result.updated} updated, ${result.unchanged} unchanged, ${result.refused} refused (changed but already answered), ${result.retired} retired.`
    );
  } finally {
    await db.destroy();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
