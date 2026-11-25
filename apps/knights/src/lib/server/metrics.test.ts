import { describe, expect, it, vi } from 'vitest';

vi.mock('./axiom', () => ({ logToAxiom: vi.fn() }));
vi.mock('./metrics/gauges', () => ({ registerGauges: vi.fn(), loadGaugeSnapshot: vi.fn() }));

const { metrics, register } = await import('./metrics');

async function revocationSeries() {
  const metric = register.getSingleMetric('knights_revocation_checks_total');
  const { values } = await metric!.get();
  return Object.fromEntries(values.map((v) => [String(v.labels.outcome), v.value]));
}

describe('knights_revocation_checks_total', () => {
  it('exports every outcome at 0 before any check, and counts each outcome under its label', async () => {
    expect(await revocationSeries()).toEqual({
      hit: 0,
      timeout: 0,
      'breaker-open': 0,
      error: 0,
    });

    metrics.revocationCheck('hit');
    metrics.revocationCheck('hit');
    metrics.revocationCheck('timeout');
    metrics.revocationCheck('nonsense' as never);

    expect(await revocationSeries()).toEqual({
      hit: 2,
      timeout: 1,
      'breaker-open': 0,
      error: 0,
      other: 1,
    });
  });
});
