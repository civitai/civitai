import { describe, it, expect, beforeEach, vi } from 'vitest';
import client from 'prom-client';

// Use the REAL prom-client registry (via the telemetry package's register* helpers) instead of the global test
// stub (src/__tests__/setup.ts), so we can READ BACK the actually-recorded histogram + counter values off the
// shared `civitai_app_*` registry — the same registry /api/metrics exposes. This is the registry-introspection
// analog of session-metrics.test.ts (which spies the register* returns). A file-level vi.mock overrides the
// global stub for this module only.
vi.mock('~/server/prom/client', async () => {
  const pkg = await vi.importActual<typeof import('@civitai/telemetry/client')>(
    '@civitai/telemetry/client'
  );
  return pkg;
});

import { observeOrchestratorRead } from '../orchestrator-read-metrics';
// Importing session-metrics AGAINST THE SAME REAL REGISTRY proves the two modules register with NO
// duplicate-metric-name collision (prom-client would otherwise conflict on a same-name re-register).
import '~/server/auth/session-metrics';

const DURATION = 'civitai_app_orchestrator_read_duration_seconds';
const TIMEOUTS = 'civitai_app_orchestrator_read_timeouts_total';

// The registry is a process-wide singleton and counters are monotonic, so every assertion reads a DELTA
// (after − before) around the call rather than an absolute value.
async function histCount(op: string, outcome: string): Promise<number> {
  const metric = client.register.getSingleMetric(DURATION) as client.Histogram<string>;
  const data = await metric.get();
  const row = data.values.find(
    (v) =>
      v.metricName === `${DURATION}_count` && v.labels.op === op && v.labels.outcome === outcome
  );
  return (row?.value as number) ?? 0;
}

async function histSum(op: string, outcome: string): Promise<number> {
  const metric = client.register.getSingleMetric(DURATION) as client.Histogram<string>;
  const data = await metric.get();
  const row = data.values.find(
    (v) => v.metricName === `${DURATION}_sum` && v.labels.op === op && v.labels.outcome === outcome
  );
  return (row?.value as number) ?? 0;
}

async function timeoutCount(op: string): Promise<number> {
  const metric = client.register.getSingleMetric(TIMEOUTS) as client.Counter<string>;
  const data = await metric.get();
  const row = data.values.find((v) => v.labels.op === op);
  return (row?.value as number) ?? 0;
}

describe('observeOrchestratorRead — civitai_app_orchestrator_read_* wiring', () => {
  it('registers both metrics on the shared registry (no name collision with session-metrics)', () => {
    expect(client.register.getSingleMetric(DURATION)).toBeDefined();
    expect(client.register.getSingleMetric(TIMEOUTS)).toBeDefined();
    // The sibling module registered fine on the same registry.
    expect(
      client.register.getSingleMetric('civitai_app_session_resolution_duration_seconds')
    ).toBeDefined();
  });

  it('observes the duration histogram on an ok outcome and does NOT touch the timeout counter', async () => {
    const beforeCount = await histCount('getWorkflow', 'ok');
    const beforeSum = await histSum('getWorkflow', 'ok');
    const beforeTo = await timeoutCount('getWorkflow');

    observeOrchestratorRead('getWorkflow', 'ok', 0.02);

    expect(await histCount('getWorkflow', 'ok')).toBe(beforeCount + 1);
    expect(await histSum('getWorkflow', 'ok')).toBeCloseTo(beforeSum + 0.02, 6);
    // An ok read must not move the timeout counter.
    expect(await timeoutCount('getWorkflow')).toBe(beforeTo);
  });

  it('increments the timeout counter ONLY on a timeout outcome (and still observes the histogram)', async () => {
    const beforeCount = await histCount('getWorkflow', 'timeout');
    const beforeTo = await timeoutCount('getWorkflow');

    observeOrchestratorRead('getWorkflow', 'timeout', 20.1);

    expect(await histCount('getWorkflow', 'timeout')).toBe(beforeCount + 1);
    expect(await timeoutCount('getWorkflow')).toBe(beforeTo + 1);
  });

  it('does NOT increment the timeout counter on an error outcome', async () => {
    const beforeCount = await histCount('queryWorkflows', 'error');
    const beforeTo = await timeoutCount('queryWorkflows');

    observeOrchestratorRead('queryWorkflows', 'error', 0.5);

    expect(await histCount('queryWorkflows', 'error')).toBe(beforeCount + 1);
    expect(await timeoutCount('queryWorkflows')).toBe(beforeTo);
  });

  it('increments the timeout counter per op (getWorkflow vs queryWorkflows are separate series)', async () => {
    const beforeGet = await timeoutCount('getWorkflow');
    const beforeQuery = await timeoutCount('queryWorkflows');

    observeOrchestratorRead('queryWorkflows', 'timeout', 20.0);

    expect(await timeoutCount('queryWorkflows')).toBe(beforeQuery + 1);
    // The getWorkflow series is untouched by a queryWorkflows timeout.
    expect(await timeoutCount('getWorkflow')).toBe(beforeGet);
  });

  it('never throws even if given odd input (total on the hot path)', () => {
    expect(() =>
      observeOrchestratorRead('getWorkflow', 'ok', Number.NaN)
    ).not.toThrow();
  });
});
