import client from 'prom-client';
import { describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/db.mock';

/**
 * 🔴 THE SEAM: does loading the metrics endpoint actually publish the refusal series?
 *
 * `seedGenerationValidationMetrics` is inert on its own and has exactly ONE caller — the
 * `/api/metrics` module. Delete that call and the counter goes back to ABSENT until the first
 * refusal on that pod, while `generation-validation.metrics.test.ts` stays green, because it
 * tests the counter and not the endpoint. Two components, each fine alone, broken together.
 *
 * This is not hypothetical: `civitai_generation_model_substitutions_total` shipped with the
 * seeder and without the call, and its own comment now records that "both halves are required;
 * neither works alone". This file is the half that catches it.
 *
 * It matters more for this counter than for that one. Its alarm is "any sustained non-zero",
 * and every caller that can increment it is non-browser — the on-site footer returns before
 * the network call — so absent is the EXPECTED reading for long stretches. Absent that cannot
 * be told from unloaded is an alarm nobody can confirm is armed.
 *
 * Seeding is at module scope here, not inside the handler, so importing the page module is
 * enough; control 2 pins that the series are genuinely seeded rather than left to a real emit.
 */

// `endpoint-helpers` spreads `env.TRPC_ORIGINS` at module load; stub the wrapper so none of
// that graph is needed to import the page.
vi.mock('~/server/utils/endpoint-helpers', () => ({
  WebhookEndpoint: (handler: unknown) => handler,
}));

const METRIC = 'civitai_app_generation_validation_refused_total';

describe('/api/metrics publishes the generation refusal series', () => {
  it('POSITIVE CONTROL — the metric is absent before the endpoint module loads', () => {
    // If this fails, something else in the suite already imported the module and the real
    // assertion below would pass without the endpoint doing anything.
    expect(client.register.getSingleMetric(METRIC)).toBeUndefined();
  });

  it('seeds one zero-valued series per surface on import', async () => {
    await import('~/pages/api/metrics');

    const metric = client.register.getSingleMetric(METRIC);
    expect(
      metric,
      `${METRIC} is absent — the seeder is not called from /api/metrics`
    ).toBeDefined();

    const values = (
      await (
        metric as unknown as {
          get(): Promise<{ values: Array<{ labels: Record<string, string>; value: number }> }>;
        }
      ).get()
    ).values;

    const surfaces = values.map((v) => v.labels.surface).sort();
    expect(surfaces).toEqual(['api', 'block', 'onsite', 'preset']);

    expect(
      values.every((v) => v.value === 0),
      'seeded series must start at zero — a non-zero seed would read as a real refusal'
    ).toBe(true);
    expect(
      values.every((v) => v.labels.workflow === 'none' && v.labels.field === 'none'),
      'the sentinel labels keep the seed from colliding with a real emit, which always ' +
        'carries a clamped workflow and a real field key'
    ).toBe(true);
  });
});
