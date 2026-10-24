import { parseArgs } from 'util';

import { loadExclusions, resolveGold } from '../builder';
import { clearsThreshold, type ThresholdFit } from '../metrics';
import { nodePaths } from '../paths';
import { assertDataDirOutsideRepo } from '../safety';
import { fittedThresholds, isAnswered } from '../scorer';
import { readJson, readJsonl, writeFileAtomic } from '../store';
import type { ManifestItem, Prediction } from '../types';
import { NODE_ID, readConfig, readStrata, supportTopicNode } from './support-topic';

/**
 * The September sample oversamples the money topics, so coverage, accuracy and
 * the comparison with the incumbent are re-weighted to the month's true mix with
 * each item's inverse inclusion probability (Horvitz–Thompson). Point estimates
 * only: no interval is claimed for a weighted figure.
 */
export type WeightedSummary = {
  /** Sampled items with gold. */
  items: number;
  /** Of those, answered or abstained: the harness's coverage denominator. */
  decidable: number;
  coverage: number | null;
  accuracyOnCovered: number | null;
  incumbentAccuracyOnCovered: number | null;
};

export function weightedSummary(input: {
  items: readonly ManifestItem[];
  gold: ReadonlyMap<string, string>;
  predictions: readonly Prediction[];
  weights: ReadonlyMap<string, number>;
  thresholds: Readonly<Record<string, number>>;
}): WeightedSummary {
  const latest = new Map<string, Prediction>();
  for (const p of input.predictions) latest.set(p.itemId, p);

  let n = 0;
  let decidable = 0;
  let total = 0;
  let covered = 0;
  let correct = 0;
  let incumbentCorrect = 0;
  for (const item of input.items) {
    const gold = input.gold.get(item.itemId);
    const w = input.weights.get(item.itemId);
    if (gold === undefined || w === undefined) continue;
    n++;
    const p = latest.get(item.itemId);
    if (p?.status !== 'ok') continue;
    decidable++;
    total += w;
    if (!isAnswered(p)) continue;
    const threshold = input.thresholds[p.pred];
    if (threshold === undefined || !clearsThreshold(p.confidence ?? null, threshold)) continue;
    covered += w;
    if (p.pred === gold) correct += w;
    if (item.baselines?.incumbent === gold) incumbentCorrect += w;
  }
  return {
    items: n,
    decidable,
    coverage: total ? covered / total : null,
    accuracyOnCovered: covered ? correct / covered : null,
    incumbentAccuracyOnCovered: covered ? incumbentCorrect / covered : null,
  };
}

/**
 * Reads the run's own thresholds-<split>.json, so the weighted figures use
 * exactly the thresholds its report used, and writes weighted-<split>[-<period>].json
 * beside it.
 */
export async function weightedReport(opts: {
  dataDir: string;
  runKey: string;
  split: 'dev' | 'test';
  period?: string;
}) {
  const { runKey: key, split, period } = opts;
  const dataDir = assertDataDirOutsideRepo(opts.dataDir);
  const p = nodePaths(dataDir, NODE_ID);
  const ctx = { dataDir };
  const weights = new Map(
    [...readStrata(ctx, readConfig(ctx))].map(([id, row]) => [id, row.weight])
  );
  const excluded = new Set(loadExclusions(p.exclusions, NODE_ID));
  const items = (await readJsonl<ManifestItem>(p.manifest)).filter(
    (i) => !excluded.has(i.itemId) && i.split === split && (!period || i.slices?.period === period)
  );
  const gold = resolveGold(await readJsonl(p.gold), supportTopicNode.goldPolicy?.(ctx)).gold;
  const fits = readJson<{ fits?: Record<string, ThresholdFit> }>(p.thresholds(key, split))?.fits;
  if (!fits) throw new Error(`${p.thresholds(key, split)} is missing or has no fits`);
  const thresholds = fittedThresholds(fits);
  const summary = weightedSummary({
    items,
    gold,
    predictions: (await readJsonl<Prediction>(p.predictions(key))).filter((x) => x.runKey === key),
    weights,
    thresholds,
  });
  if (summary.items === 0) {
    throw new Error(
      `no ${split} item has both gold and a strata weight; only sampled test items are weighted`
    );
  }
  const out = { runKey: key, split, period: period ?? 'all', thresholds, ...summary };
  writeFileAtomic(p.weighted(key, split, period), JSON.stringify(out, null, 2));
  return out;
}

/**
 *   pnpm run tsscript scripts/decision-eval/nodes/support-topic-weighted.ts \
 *     --data-dir <dir> --run-key <key> --split test --period 2026-09
 */
async function main() {
  const { values } = parseArgs({
    options: {
      'data-dir': { type: 'string' },
      'run-key': { type: 'string' },
      split: { type: 'string' },
      period: { type: 'string' },
    },
  });
  const runKey = values['run-key'];
  const split = values.split;
  if (!runKey || (split !== 'dev' && split !== 'test'))
    throw new Error('need --run-key and --split dev|test');
  const out = await weightedReport({
    dataDir: values['data-dir'] ?? '',
    runKey,
    split,
    period: values.period,
  });
  console.log(JSON.stringify(out, null, 2));
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('nodes/support-topic-weighted.ts')) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
