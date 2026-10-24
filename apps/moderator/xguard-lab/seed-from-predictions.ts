/**
 * Seed the rows a policy FIRED on into the lab, as a review batch.
 *
 *   pnpm exec tsx --env-file=apps/moderator/.env apps/moderator/xguard-lab/seed-from-predictions.ts \
 *     --predictions local/xguard-tuning-harness/data/explicit-text.train.precision-probe.predictions.jsonl \
 *     --dataset     local/xguard-tuning-harness/data/explicit-text.train.jsonl \
 *     --batch precision-2026-08-25-explicit --threshold 0.4
 *
 * WHY ONLY THE FIRED ROWS
 *
 * Precision is TP / (TP + FP) — every term is a row the policy fired on. Rows it did not fire on
 * cannot change it. So when positives are a small minority, reviewing a random sample spends most
 * of the effort on rows that are already settled, while reviewing the fired rows measures the
 * same number exactly.
 *
 * This is NOT a way to measure recall, and must not be used for one: the rows it drops are
 * precisely the false negatives. Measuring recall needs a corpus whose positives were identified
 * independently of the policy under test, which this is not.
 */
import { readFileSync } from 'fs';
import pg from 'pg';

type PredictionRow = { contentHash: string; expectedTrigger?: boolean; score: number | null };
type DatasetRow = { contentHash: string; modelId?: number; positivePrompt: string };

export type SeedOptions = {
  connectionString: string;
  predictionsFile: string;
  datasetFile: string;
  batch: string;
  threshold: number;
  label: string;
};

const readJsonl = <T>(path: string): T[] =>
  readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as T);

export async function seedFromPredictions(opts: SeedOptions) {
  const preds = readJsonl<PredictionRow>(opts.predictionsFile);
  const data = new Map(readJsonl<DatasetRow>(opts.datasetFile).map((r) => [r.contentHash, r]));

  const fired = preds.filter((p) => p.score !== null && p.score >= opts.threshold);

  const c = new pg.Client({ connectionString: opts.connectionString });
  await c.connect();
  try {
    let inserted = 0;
    let missingText = 0;
    for (const p of fired) {
      const row = data.get(p.contentHash);
      if (!row?.positivePrompt) {
        missingText++;
        continue;
      }
      const res = await c.query(
        `INSERT INTO sample (prompt_hash, source, batch, positive_prompt, live_scores)
         VALUES ($1, 'model', $2, $3, $4)
         ON CONFLICT (batch, prompt_hash) DO NOTHING`,
        [
          row.modelId ?? null,
          opts.batch,
          row.positivePrompt,
          JSON.stringify({ [opts.label]: p.score }),
        ]
      );
      inserted += res.rowCount ?? 0;
    }
    return {
      batch: opts.batch,
      scored: preds.length,
      fired: fired.length,
      firingRate: Number((fired.length / preds.length).toFixed(4)),
      inserted,
      missingText,
      duplicates: fired.length - inserted - missingText,
    };
  } finally {
    await c.end();
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const get = (f: string) => {
    const i = argv.indexOf(f);
    return i === -1 ? undefined : argv[i + 1];
  };
  const predictionsFile = get('--predictions');
  const datasetFile = get('--dataset');
  const batch = get('--batch');
  if (!predictionsFile) throw new Error('--predictions is required');
  if (!datasetFile) throw new Error('--dataset is required');
  if (!batch) throw new Error('--batch is required');

  const summary = await seedFromPredictions({
    connectionString: get('--lab-db') ?? process.env.MODERATOR_DATABASE_URL ?? '',
    predictionsFile,
    datasetFile,
    batch,
    threshold: Number(get('--threshold') ?? 0.4),
    label: get('--label') ?? 'Explicit',
  });
  console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1]?.endsWith('seed-from-predictions.ts')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
