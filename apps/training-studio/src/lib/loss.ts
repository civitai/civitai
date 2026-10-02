import type { LossPoint } from './trace';

/** One logged step, merged across every trace line that reported it. */
export interface Reading {
  epoch: number;
  losses: Record<string, number>;
  lr: number | null;
}

/** The learning-rate metric's key. The trace parsers file `lr` apart from the losses, so no loss can
 *  take this name. */
export const LEARNING_RATE = 'lr';

export interface MetricSeries {
  xs: number[];
  ys: number[];
  epochs: number[];
}

export const TREND_ALPHA = 0.005;

export function recordReadings(readings: Map<number, Reading>, epoch: number, points: LossPoint[]) {
  for (const p of points) {
    const prev = readings.get(p.step);
    readings.set(p.step, {
      epoch: prev?.epoch ?? epoch,
      losses: { ...prev?.losses, ...p.losses },
      lr: p.lr ?? prev?.lr ?? null,
    });
  }
}

/** Every metric the readings carry: `loss` first, other losses by name, the learning rate last. */
export function metricKeys(sorted: [number, Reading][]): string[] {
  const keys = new Set<string>();
  let hasLr = false;
  for (const [, r] of sorted) {
    for (const key in r.losses) keys.add(key);
    if (r.lr !== null) hasLr = true;
  }
  const losses = [...keys].sort((a, b) =>
    a === 'loss' ? -1 : b === 'loss' ? 1 : a.localeCompare(b)
  );
  return hasLr ? [...losses, LEARNING_RATE] : losses;
}

const valueOf = (r: Reading, metric: string) =>
  metric === LEARNING_RATE ? r.lr : r.losses[metric] ?? null;

/** One metric's readings in step order. `positiveOnly` drops what a log axis can't plot. */
export function metricSeries(
  sorted: [number, Reading][],
  metric: string,
  positiveOnly: boolean
): MetricSeries {
  const series: MetricSeries = { xs: [], ys: [], epochs: [] };
  for (const [step, r] of sorted) {
    const v = valueOf(r, metric);
    if (v === null || (positiveOnly && v <= 0)) continue;
    series.xs.push(step);
    series.ys.push(v);
    series.epochs.push(r.epoch);
  }
  return series;
}

/** Each finished checkpoint's last logged step — where its marker goes on the step axis. */
export function epochEnds(series: MetricSeries, done: number[]): { epoch: number; step: number }[] {
  const finished = new Set(done);
  const ends = new Map<number, number>();
  series.epochs.forEach((epoch, i) =>
    ends.set(epoch, Math.max(ends.get(epoch) ?? -Infinity, series.xs[i]))
  );
  return [...ends]
    .filter(([epoch]) => finished.has(epoch))
    .map(([epoch, step]) => ({ epoch, step }))
    .sort((a, b) => a.step - b.step);
}

/** Mean of each finished checkpoint's readings; null for a checkpoint with none, so a missing trace
 *  reads as missing rather than disappearing from the list. */
export function epochMeans(
  sorted: [number, Reading][],
  metric: string,
  done: number[]
): { epoch: number; mean: number | null }[] {
  const sums = new Map<number, { sum: number; n: number }>();
  for (const [, r] of sorted) {
    const v = valueOf(r, metric);
    if (v === null) continue;
    const s = sums.get(r.epoch) ?? { sum: 0, n: 0 };
    s.sum += v;
    s.n += 1;
    sums.set(r.epoch, s);
  }
  return [...done]
    .sort((a, b) => a - b)
    .map((epoch) => {
      const s = sums.get(epoch);
      return { epoch, mean: s ? s.sum / s.n : null };
    });
}

/** Chart points with a NaN break (Chart.js skips it) wherever the series skips a checkpoint, so a
 *  missing epoch shows as a gap instead of a straight line drawn across it. */
export function chartPoints(series: MetricSeries, ys: number[]): { x: number; y: number }[] {
  const { xs, epochs } = series;
  const points: { x: number; y: number }[] = [];
  for (let i = 0; i < xs.length; i++) {
    if (i > 0 && epochs[i] > epochs[i - 1] + 1) points.push({ x: (xs[i - 1] + xs[i]) / 2, y: NaN });
    points.push({ x: xs[i], y: ys[i] });
  }
  return points;
}

/** Smoothing slider (0 = raw, 100 = heaviest) to an EMA alpha. Same mapping as ai-toolkit's loss graph,
 *  so a setting reads the same curve in both. */
export function smoothingAlpha(smoothing: number): number {
  const t = Math.min(1, Math.max(0, smoothing / 100));
  return 1 - t * 0.98;
}

function emaPass(ys: number[], alpha: number, reverse: boolean) {
  const values = new Array<number>(ys.length);
  const weights = new Array<number>(ys.length);
  let acc = 0;
  let seen = 0;
  for (let k = 0; k < ys.length; k++) {
    const i = reverse ? ys.length - 1 - k : k;
    acc = alpha * ys[i] + (1 - alpha) * acc;
    seen += 1;
    const w = 1 - Math.pow(1 - alpha, seen);
    values[i] = acc / w;
    weights[i] = w;
  }
  return { values, weights };
}

/** Bias-corrected EMA run forward AND backward, blended by how warmed-up each pass is at every index.
 *  A one-way EMA lags and pins its first point to the raw value; blending cancels the lag mid-run
 *  while the newest points stay causal (the backward pass has barely started there). */
export function zeroPhaseEma(ys: number[], alpha: number): number[] {
  if (alpha >= 1) return [...ys];
  const fwd = emaPass(ys, alpha, false);
  const bwd = emaPass(ys, alpha, true);
  return ys.map((_, i) => {
    const wf = fwd.weights[i];
    const wb = bwd.weights[i];
    return (wf * fwd.values[i] + wb * bwd.values[i]) / (wf + wb);
  });
}

/** The 2nd–98th percentile span of `values`, so a few spikes don't flatten the rest of the curve.
 *  Null when there's too little data to call anything an outlier. */
export function clippedRange(values: number[]): { min: number; max: number } | null {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (finite.length < 10) return null;
  const min = finite[Math.floor(finite.length * 0.02)];
  const max = finite[Math.ceil(finite.length * 0.98) - 1];
  return min < max ? { min, max } : null;
}

export function formatLoss(v: number): string {
  if (!Number.isFinite(v)) return '';
  if (v === 0) return '0';
  const abs = Math.abs(v);
  if (abs < 1e-3 || abs >= 1e6) return v.toExponential(2);
  if (abs >= 1000) return v.toFixed(0);
  if (abs >= 10) return v.toFixed(3);
  if (abs >= 1) return v.toFixed(4);
  return v.toPrecision(4);
}
