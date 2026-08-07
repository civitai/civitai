/**
 * CLI wrapper around sample-core.
 *
 *   pnpm exec tsx --env-file=.env apps/moderator/xguard-lab/sample.ts \
 *     --batch 2026-08-04-age --size 500
 *
 * The logic lives in sample-core.ts so `POST /api/xguard/samples` runs the same pass. Anything added
 * here that is not argument parsing or printing belongs there instead.
 */
import { sampleBatch } from './sample-core';

function parseArgs(argv: string[]) {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const batch = get('--batch');
  if (!batch) throw new Error('--batch is required (e.g. --batch 2026-08-04-age)');
  return {
    batch,
    size: Number(get('--size') ?? 500),
    label: get('--label') ?? 'Young',
    bands: Number(get('--bands') ?? 5),
    days: Number(get('--days') ?? 7),
    connectionString:
      get('--lab-db') ??
      process.env.MODERATOR_DATABASE_URL ??
      'postgres://xguard:xguard@localhost:5433/xguard_lab',
  };
}

async function main() {
  const summary = await sampleBatch(parseArgs(process.argv.slice(2)));
  for (const band of summary.bands) {
    console.log(`  band ${band.lo.toFixed(2)}-${band.hi.toFixed(2)}: ${band.rows} rows`);
  }
  console.log(
    `\nbatch "${summary.batch}": ${summary.inserted} inserted, ${summary.duplicates} already present`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
