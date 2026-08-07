/**
 * CLI wrapper around rate-core.
 *
 *   pnpm exec tsx --env-file=.env apps/moderator/xguard-lab/rate.ts \
 *     --batch 2026-08-04-age --label AgeAsserted
 *
 * The logic lives in rate-core.ts so `POST /api/xguard/rate` runs the same pass. Anything added here
 * that is not argument parsing or printing belongs there instead.
 */
import { LABELS, type LabName } from './labels';
import { DEFAULT_FALLBACK_MODEL, DEFAULT_MODEL, rateBatch } from './rate-core';

function parseArgs(argv: string[]) {
  const get = (f: string) => {
    const i = argv.indexOf(f);
    return i === -1 ? undefined : argv[i + 1];
  };
  const batch = get('--batch');
  const label = get('--label') as LabName | undefined;
  if (!batch) throw new Error('--batch is required');
  if (!label || !LABELS[label]) {
    throw new Error(`--label must be one of: ${Object.keys(LABELS).join(', ')}`);
  }
  return {
    batch,
    label,
    model: get('--model') ?? DEFAULT_MODEL,
    fallbackModel: get('--fallback-model') ?? DEFAULT_FALLBACK_MODEL,
    concurrency: Number(get('--concurrency') ?? 6),
    limit: get('--limit') ? Number(get('--limit')) : undefined,
    connectionString:
      get('--lab-db') ??
      process.env.MODERATOR_DATABASE_URL ??
      'postgres://xguard:xguard@localhost:5433/xguard_lab',
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let announced = false;

  const summary = await rateBatch({
    ...args,
    onProgress: (done, total) => {
      if (!announced) {
        console.log(`rating ${total} unrated samples for ${args.label} with ${args.model}`);
        announced = true;
      }
      if (done % 25 === 0) console.log(`  ${done}/${total}`);
    },
  });

  console.log(
    `\n${summary.label}: true=${summary.verdicts.true}  false=${summary.verdicts.false}` +
      ` (batch totals; ${summary.rated} rated this pass)`
  );
  if (summary.refused) {
    console.log(
      `${summary.refused} refused by ${summary.model}, retried on ${summary.fallbackModel}`
    );
  }
  if (summary.failed) {
    console.log(`${summary.failed} still unrated`);
    summary.errors.forEach((e) => console.error(`  ${e}`));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
