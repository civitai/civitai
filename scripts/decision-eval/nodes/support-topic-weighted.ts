import type { ManifestItem, Prediction } from '../types';

/**
 * The September sample oversamples the money topics, so coverage, accuracy and
 * the comparison with the incumbent are re-weighted to the month's true mix with
 * each item's inverse inclusion probability (Horvitz–Thompson). Point estimates
 * only: no interval is claimed for a weighted figure.
 */
export type WeightedSummary = {
  items: number;
  coverage: number;
  accuracyOnCovered: number | null;
  incumbentAccuracyOnCovered: number | null;
};

export function parseStrataWeights(text: string): Map<string, number> {
  const [header, ...lines] = text.split(/\r?\n/).filter((l) => l.trim());
  const cols = header.split(',');
  const idCol = cols.indexOf('ticket_id');
  const weightCol = cols.indexOf('weight');
  if (idCol < 0 || weightCol < 0) throw new Error('strata file needs ticket_id and weight columns');
  return new Map(
    lines.map((l) => {
      const cells = l.split(',');
      const w = Number(cells[weightCol]);
      if (!(w >= 1)) throw new Error(`ticket ${cells[idCol]} has weight ${cells[weightCol]}`);
      return [cells[idCol], w];
    })
  );
}

export function weightedSummary(input: {
  items: readonly ManifestItem[];
  gold: ReadonlyMap<string, string>;
  predictions: readonly Prediction[];
  weights: ReadonlyMap<string, number>;
  thresholds: Readonly<Record<string, number>>;
}): WeightedSummary {
  const latest = new Map<string, Prediction>();
  for (const p of input.predictions) latest.set(p.itemId, p);

  let total = 0;
  let covered = 0;
  let correct = 0;
  let incumbentCorrect = 0;
  let n = 0;
  for (const item of input.items) {
    const gold = input.gold.get(item.itemId);
    const w = input.weights.get(item.itemId);
    if (gold === undefined || w === undefined) continue;
    n++;
    total += w;
    const p = latest.get(item.itemId);
    const threshold = p?.pred != null ? input.thresholds[p.pred] : undefined;
    const isCovered =
      p?.status === 'ok' &&
      !p.abstained &&
      threshold !== undefined &&
      (threshold <= 0 || (p.confidence ?? -Infinity) >= threshold);
    if (!isCovered) continue;
    covered += w;
    if (p.pred === gold) correct += w;
    if (item.baselines?.incumbent === gold) incumbentCorrect += w;
  }
  return {
    items: n,
    coverage: total ? covered / total : 0,
    accuracyOnCovered: covered ? correct / covered : null,
    incumbentAccuracyOnCovered: covered ? incumbentCorrect / covered : null,
  };
}

/** Only classes the harness actually fitted carry a threshold; the rest always route to a human. */
export function fittedThresholds(file: unknown): Record<string, number> {
  const fits = (file as { fits?: Record<string, { status?: string; threshold?: number }> })?.fits;
  if (!fits || typeof fits !== 'object') throw new Error('thresholds file has no fits');
  return Object.fromEntries(
    Object.entries(fits).flatMap(([cls, f]) =>
      f.status === 'fitted' && typeof f.threshold === 'number' ? [[cls, f.threshold]] : []
    )
  );
}

/**
 *   pnpm run tsscript scripts/decision-eval/nodes/support-topic-weighted.ts \
 *     --data-dir <dir> --run-key <key> --split test --period 2026-09
 *
 * Reads the run's own thresholds-<split>.json, so the weighted figures use
 * exactly the thresholds its report used.
 */
async function main() {
  const { parseArgs } = await import('util');
  const { existsSync, readFileSync, writeFileSync } = await import('fs');
  const { join } = await import('path');
  const { resolveGold } = await import('../builder');
  const { assertDataDirOutsideRepo } = await import('../safety');
  const { supportTopicNode, NODE_ID } = await import('./support-topic');
  const { values } = parseArgs({
    options: {
      'data-dir': { type: 'string' },
      'run-key': { type: 'string' },
      split: { type: 'string' },
      period: { type: 'string' },
    },
  });
  const dataDir = assertDataDirOutsideRepo(values['data-dir'] ?? '');
  const key = values['run-key'];
  const split = values.split;
  if (!key || (split !== 'dev' && split !== 'test'))
    throw new Error('need --run-key and --split dev|test');
  const root = join(dataDir, NODE_ID);
  const jsonl = <T>(p: string): T[] =>
    existsSync(p)
      ? readFileSync(p, 'utf8')
          .split('\n')
          .filter((l) => l.trim())
          .map((l) => JSON.parse(l) as T)
      : [];
  const cfg = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')) as {
    testStrataFiles: string[];
  };
  const weights = new Map<string, number>();
  for (const f of cfg.testStrataFiles) {
    for (const [id, w] of parseStrataWeights(readFileSync(join(root, f), 'utf8')))
      weights.set(id, w);
  }
  const items = jsonl<ManifestItem>(join(root, 'manifest.jsonl')).filter(
    (i) => i.split === split && (!values.period || i.slices?.period === values.period)
  );
  const gold = resolveGold(
    jsonl(join(root, 'gold.jsonl')),
    supportTopicNode.goldPolicy?.({ dataDir })
  ).gold;
  const thresholds = fittedThresholds(
    JSON.parse(readFileSync(join(root, 'runs', key, `thresholds-${split}.json`), 'utf8'))
  );
  const summary = weightedSummary({
    items,
    gold,
    predictions: jsonl<Prediction>(join(root, 'runs', key, 'predictions.jsonl')).filter(
      (p) => p.runKey === key
    ),
    weights,
    thresholds,
  });
  if (summary.items === 0) {
    throw new Error(
      `no ${split} item has both gold and a strata weight; only sampled test items are weighted`
    );
  }
  const out = { runKey: key, split, period: values.period ?? 'all', thresholds, ...summary };
  writeFileSync(
    join(root, 'runs', key, `weighted-${split}${values.period ? `-${values.period}` : ''}.json`),
    JSON.stringify(out, null, 2)
  );
  console.log(JSON.stringify(out, null, 2));
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('nodes/support-topic-weighted.ts')) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
