/**
 * Builds one batch of the removal-label relabel set by hand. The daily batch is built by the main
 * app's `relabel-build-batch` job through the spoke; this CLI runs the same code, for local dry runs
 * and for `--model-only` builds, which the job never makes.
 *
 *   pnpm exec tsx --env-file=.env apps/moderator/removal-label-eval/build-set.ts \
 *     --batch 2026-10-06 --removed 100 --not-removed 40 --bands <edges>
 *
 * Dry run unless `--write` is given. Without `--bands` the batch holds removed items only. Logic and
 * the sampling rules: `src/lib/server/relabel-batch-build.ts`.
 */
import { createKyselyClients } from '@civitai/db/kysely';
import type { DB as MainDB } from '@civitai/db-schema/kysely';
import { clickhouse, type ClickHouseConfig } from '../xguard-lab/sample-core';
import type { DB as ModeratorDB } from '../src/lib/server/moderator-db/types';
import { buildRelabelBatch, parseBands } from '../src/lib/server/relabel-batch-build';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} not set`);
  return v;
}

async function main() {
  const argv = process.argv.slice(2);
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const batch = get('--batch');
  if (!batch) throw new Error('--batch is required');
  const ch: ClickHouseConfig = {
    host: requireEnv('CLICKHOUSE_HOST'),
    username: process.env.CLICKHOUSE_USERNAME,
    password: process.env.CLICKHOUSE_PASSWORD,
  };

  // The shared factory, not a bare pool: it registers the parsers that read `timestamp` columns
  // (Appeal.resolvedAt) as UTC rather than the machine's local time.
  const { db: replica } = createKyselyClients<MainDB>({
    connectionString: requireEnv('DATABASE_REPLICA_URL'),
    singleClient: true,
    sslNoVerify: true,
  });
  // The cluster needs `?sslmode=no-verify` on this URL; a local docker Postgres needs none.
  const { db: moderator } = createKyselyClients<ModeratorDB>({
    connectionString: requireEnv('MODERATOR_DATABASE_URL'),
    singleClient: true,
  });
  try {
    const summary = await buildRelabelBatch(
      {
        batch,
        removed: Number(get('--removed') ?? 100),
        notRemoved: Number(get('--not-removed') ?? 40),
        days: Number(get('--days') ?? 5),
        bands: parseBands(get('--bands')),
        seed: get('--seed'),
        dryRun: !argv.includes('--write'),
        modelOnly: argv.includes('--model-only'),
      },
      { clickhouse: (sql) => clickhouse(sql, ch), replica, moderator }
    );
    console.log(JSON.stringify(summary, null, 2));
    if (summary.dryRun) console.log('dry run: nothing written. Pass --write to insert.');
  } finally {
    await Promise.all([replica.destroy(), moderator.destroy()]);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
