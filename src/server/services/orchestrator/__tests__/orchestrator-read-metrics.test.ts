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

describe('observeOrchestratorRead — civitai_app_orchestrator_read_* wiring', () => {
  it('registers both metrics on the shared registry (no name collision with session-metrics)', () => {
    expect(client.register.getSingleMetric(DURATION)).toBeDefined();
    expect(client.register.getSingleMetric(TIMEOUTS)).toBeDefined();
    // The sibling module registered fine on the same registry.
    expect(
      client.register.getSingleMetric('civitai_app_session_resolution_duration_seconds')
    ).toBeDefined();
  });

  it('never throws even if given odd input (total on the hot path)', () => {
    expect(() => observeOrchestratorRead('getWorkflow', 'ok', Number.NaN)).not.toThrow();
  });
});
