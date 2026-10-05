/**
 * Snapshots a stratified pool of Clavata "Automated" report hits into `text_relabel_item`, before
 * `clear-automated-reports` deletes their text at 14 days. Prints counts only, never the text.
 *
 *   pnpm exec tsx --env-file=.env apps/moderator/automated-text-eval/snapshot.ts \
 *     --batch 2026-10-04 --seed <seed>            # dry run
 *   ... --write                                    # insert
 *   ... --purge                                    # null the text of items past purge_after
 *
 * Sampling rules: `src/lib/server/text-relabel-snapshot.ts`.
 */
import * as kyselyModule from '@civitai/db/kysely';
import type { DB as MainDB } from '@civitai/db-schema/kysely';
import type { DB as ModeratorDB } from '../src/lib/server/moderator-db/types';
import {
  DEFAULT_PURGE_DAYS,
  describeSnapshotError,
  purgeExpiredText,
  snapshotAutomatedText,
  SnapshotUsageError,
} from '../src/lib/server/text-relabel-snapshot';

// @civitai/db has no `"type": "module"`, so tsx loads it as CommonJS and an ESM named import of it
// fails; its exports arrive on `default` instead.
const { createKyselyClients } = (
  'default' in kyselyModule ? kyselyModule.default : kyselyModule
) as typeof kyselyModule;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new SnapshotUsageError(`${name} not set`);
  return v;
}

async function main() {
  const argv = process.argv.slice(2);
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };

  const { db: moderator } = createKyselyClients<ModeratorDB>({
    connectionString: requireEnv('MODERATOR_DATABASE_URL'),
    singleClient: true,
  });
  try {
    if (argv.includes('--purge')) {
      console.log(JSON.stringify({ purged: await purgeExpiredText(moderator) }));
      return;
    }

    const batch = get('--batch');
    if (!batch) throw new SnapshotUsageError('--batch is required');
    const purgeDays = Number(get('--purge-days') ?? DEFAULT_PURGE_DAYS);
    if (!Number.isInteger(purgeDays) || purgeDays < 1)
      throw new SnapshotUsageError('--purge-days must be a whole number of days');

    const { db: replica } = createKyselyClients<MainDB>({
      connectionString: requireEnv('DATABASE_REPLICA_URL'),
      singleClient: true,
      sslNoVerify: true,
    });
    try {
      const summary = await snapshotAutomatedText(
        {
          batch,
          seed: get('--seed') ?? batch,
          dryRun: !argv.includes('--write'),
          purgeDays,
        },
        { replica, moderator }
      );
      console.log(JSON.stringify(summary, null, 2));
      if (summary.dryRun) console.log('dry run: nothing written. Pass --write to insert.');
    } finally {
      await replica.destroy();
    }
  } finally {
    await moderator.destroy();
  }
}

main().catch((err) => {
  console.error(describeSnapshotError(err));
  process.exit(1);
});
