/**
 * CLI for an evaluation run. Same code path the UI uses, so an agent iterating on policy prose and
 * a human clicking a button produce comparable numbers.
 *
 *   # baseline: whatever the live registry has today
 *   pnpm exec tsx --env-file=.env apps/moderator/xguard-lab/run-eval.ts --label AgeAsserted
 *
 *   # a candidate policy version, at a chosen threshold
 *   pnpm exec tsx --env-file=.env apps/moderator/xguard-lab/run-eval.ts \
 *     --label AgeAsserted --policy-version 2 --threshold 0.25
 */
import { runEvaluation } from './eval-core';

function parseArgs(argv: string[]) {
  const get = (f: string) => {
    const i = argv.indexOf(f);
    return i === -1 ? undefined : argv[i + 1];
  };
  const label = get('--label');
  if (!label) throw new Error('--label is required');
  return {
    label,
    policyVersion: get('--policy-version') ? Number(get('--policy-version')) : undefined,
    batch: get('--batch'),
    thresholdOverride: get('--threshold') ? Number(get('--threshold')) : undefined,
    concurrency: Number(get('--concurrency') ?? 6),
    limit: get('--limit') ? Number(get('--limit')) : undefined,
    note: get('--note'),
    connectionString:
      get('--lab-db') ??
      process.env.MODERATOR_DATABASE_URL ??
      'postgres://xguard:xguard@localhost:5433/xguard_lab',
  };
}

const args = parseArgs(process.argv.slice(2));

const summary = await runEvaluation({
  ...args,
  onProgress: (done, total) => {
    if (done % 25 === 0 || done === total) console.log(`  ${done}/${total}`);
  },
});

// n/a rather than 0.000 when the ground truth has no positives to measure against.
const pct = (n: number | null) => (n === null ? 'n/a' : n.toFixed(3));
console.log(`
run ${summary.runId}  ${summary.label} @ ${summary.policyLabel}  threshold ${summary.threshold}
  TP ${summary.tp}   FP ${summary.fp}   TN ${summary.tn}   FN ${summary.fn}${
  summary.errors ? `   errors ${summary.errors}` : ''
}
  precision ${pct(summary.precision)}   recall ${pct(summary.recall)}   f1 ${pct(summary.f1)}
`);

if (summary.tp + summary.fn === 0) {
  console.log(
    'No positives in the ground truth yet, so recall is unmeasurable. Review some prompts the rater flagged true.\n'
  );
}
