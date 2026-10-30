import { describe, expect, it } from 'vitest';
import {
  chartPoints,
  clippedRange,
  epochEnds,
  epochMeans,
  formatLoss,
  LEARNING_RATE,
  metricKeys,
  metricSeries,
  recordReadings,
  smoothingAlpha,
  zeroPhaseEma,
  type Reading,
} from './loss';

function readingsOf(
  ...rows: [step: number, epoch: number, losses: Record<string, number>, lr?: number][]
) {
  const readings = new Map<number, Reading>();
  for (const [step, epoch, losses, lr = null] of rows) {
    recordReadings(readings, epoch, [{ step, losses, lr }]);
  }
  return [...readings].sort((a, b) => a[0] - b[0]);
}

describe('recordReadings', () => {
  it('merges repeat reports of a step, keeping the epoch that first reported it', () => {
    const readings = new Map<number, Reading>();
    recordReadings(readings, 2, [{ step: 10, losses: { loss: 0.3 }, lr: 1e-4 }]);
    recordReadings(readings, 3, [{ step: 10, losses: { loss: 0.2, fft_loss: 0.1 }, lr: null }]);
    expect(readings.get(10)).toEqual({ epoch: 2, losses: { loss: 0.2, fft_loss: 0.1 }, lr: 1e-4 });
  });
});

describe('metricKeys', () => {
  it('puts `loss` first, other losses by name, and the learning rate last', () => {
    const sorted = readingsOf([1, 1, { fft_loss: 0.1, loss: 0.2, aux: 0.3 }, 1e-4]);
    expect(metricKeys(sorted)).toEqual(['loss', 'aux', 'fft_loss', LEARNING_RATE]);
  });

  it('offers no learning rate when none was reported', () => {
    expect(metricKeys(readingsOf([1, 1, { loss: 0.2 }]))).toEqual(['loss']);
  });
});

describe('metricSeries', () => {
  it('extracts one metric in step order and drops non-positive values for a log axis', () => {
    const sorted = readingsOf([3, 1, { loss: 0.3 }], [1, 1, { loss: 0 }], [2, 1, { other: 1 }]);
    expect(metricSeries(sorted, 'loss', false)).toEqual({
      xs: [1, 3],
      ys: [0, 0.3],
      epochs: [1, 1],
    });
    expect(metricSeries(sorted, 'loss', true)).toEqual({ xs: [3], ys: [0.3], epochs: [1] });
  });
});

describe('epochEnds / epochMeans', () => {
  const sorted = readingsOf(
    [1, 1, { loss: 0.4 }],
    [2, 1, { loss: 0.2 }],
    [3, 2, { loss: 0.1 }],
    [4, 4, { loss: 0.05 }]
  );

  it('marks the last step of each finished checkpoint only', () => {
    expect(epochEnds(metricSeries(sorted, 'loss', false), [1, 2, 3])).toEqual([
      { epoch: 1, step: 2 },
      { epoch: 2, step: 3 },
    ]);
  });

  it('averages each finished checkpoint and keeps one with no readings as null', () => {
    expect(epochMeans(sorted, 'loss', [3, 1, 2])).toEqual([
      { epoch: 1, mean: expect.closeTo(0.3) },
      { epoch: 2, mean: 0.1 },
      { epoch: 3, mean: null },
    ]);
  });
});

describe('chartPoints', () => {
  it('breaks the line where a checkpoint is missing', () => {
    const series = { xs: [1, 2, 10], ys: [0.3, 0.2, 0.1], epochs: [1, 2, 4] };
    expect(chartPoints(series, series.ys)).toEqual([
      { x: 1, y: 0.3 },
      { x: 2, y: 0.2 },
      { x: 6, y: NaN },
      { x: 10, y: 0.1 },
    ]);
  });
});

describe('smoothingAlpha', () => {
  it('maps the slider onto ai-toolkit’s alpha range', () => {
    expect(smoothingAlpha(0)).toBe(1);
    expect(smoothingAlpha(100)).toBeCloseTo(0.02);
    expect(smoothingAlpha(-5)).toBe(1);
  });
});

describe('zeroPhaseEma', () => {
  it('passes the series through unsmoothed at alpha 1', () => {
    expect(zeroPhaseEma([3, 1, 2], 1)).toEqual([3, 1, 2]);
  });

  it('holds a constant series', () => {
    for (const v of zeroPhaseEma([0.2, 0.2, 0.2, 0.2], 0.1)) expect(v).toBeCloseTo(0.2);
  });

  it('flattens alternating noise to its mean', () => {
    const noisy = Array.from({ length: 200 }, (_, i) => (i % 2 ? 1 : 0));
    const smooth = zeroPhaseEma(noisy, 0.05);
    for (const v of smooth.slice(50, 150)) expect(v).toBeCloseTo(0.5, 1);
  });

  it('does not lag a ramp in the middle of the run', () => {
    const ramp = Array.from({ length: 101 }, (_, i) => i);
    // A one-way EMA at this alpha sits ~9 steps behind the ramp.
    expect(zeroPhaseEma(ramp, 0.1)[50]).toBeCloseTo(50, 0);
  });

  it('returns nothing for nothing', () => {
    expect(zeroPhaseEma([], 0.5)).toEqual([]);
  });
});

describe('clippedRange', () => {
  it('drops a spike so it cannot flatten the rest of the curve', () => {
    const values = [...Array.from({ length: 99 }, (_, i) => 0.1 + i / 1000), 50];
    const range = clippedRange(values);
    expect(range).not.toBeNull();
    expect(range!.max).toBeLessThan(1);
    expect(range!.min).toBeGreaterThanOrEqual(0.1);
  });

  it('declines to clip too little data', () => {
    expect(clippedRange([1, 2, 3])).toBeNull();
  });
});

describe('formatLoss', () => {
  it('reads small losses without long zero runs', () => {
    expect(formatLoss(0.08421)).toBe('0.08421');
    expect(formatLoss(0.00001)).toBe('1.00e-5');
    expect(formatLoss(12.34567)).toBe('12.346');
    expect(formatLoss(0)).toBe('0');
  });
});
