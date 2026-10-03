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
      (p.confidence ?? -Infinity) >= threshold;
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
