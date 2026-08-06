import client from 'prom-client';
import { describe, expect, it, vi } from 'vitest';

/**
 * 🔴 THE SEAM: does loading the module that SERVES the scrape actually register
 * and seed `civitai_generation_model_substitutions_total`? (#3665)
 *
 * Seeding all 12 `(reason, surface)` series is inert on its own.
 * `ensureRegisterGenerationModelSubstitutionMetrics` has no caller outside its
 * own module, and the only production path in is
 * `recordGenerationModelSubstitution` — which by definition runs only AFTER a
 * substitution has happened. So without a module-scope call from
 * `src/pages/api/metrics.ts`, `…{surface="api"}` reads `no data` on a pod until
 * its first API substitution: indistinguishable from an unwired instrument, on a
 * metric whose entire job is to be read as a gate. Two components, each fine
 * alone, broken together.
 *
 * 🔴 THIS IS BEHAVIOURAL ON PURPOSE, AND AN EARLIER REVISION WAS NOT. That
 * revision asserted the seam by PARSING `metrics.ts` for a module-scope call,
 * with a comment claiming the behavioural route was unavailable because
 * importing the page throws `env.TRPC_ORIGINS is not iterable`. That claim was
 * wrong: the repo already has the pattern for exactly this
 * (`src/server/utils/__tests__/public-endpoint-maxage.test.ts` stubs the
 * heavy module-load imports), and an audit used it to load the real page. The
 * source check also false-failed at least six CORRECT refactors — `void f()`,
 * a module-scope helper, a locally-aliased import, a relative specifier — while
 * passing an `import type` + call, which only `tsc` would catch. It is replaced
 * by this, which asks the question that actually matters: after the module
 * loads, are the series there?
 */

// `endpoint-helpers` spreads `env.TRPC_ORIGINS` at module load; stub the wrapper
// itself so none of that graph is needed.
vi.mock('~/server/utils/endpoint-helpers', () => ({
  WebhookEndpoint: (handler: unknown) => handler,
}));
vi.mock('~/server/db/client', () => ({ dbRead: {}, dbWrite: {} }));

const METRIC = 'civitai_generation_model_substitutions_total';

describe('/api/metrics registers + seeds the substitution counter at module load', () => {
  it('NEGATIVE CONTROL: the counter is absent before the page module is loaded', () => {
    expect(client.register.getSingleMetric(METRIC)).toBeUndefined();
  });

  it('🔴 after loading the page module, all 12 series exist at 0', async () => {
    await import('~/pages/api/metrics');

    const metric = client.register.getSingleMetric(METRIC) as unknown as
      | { get(): Promise<{ values: Array<{ labels: Record<string, string>; value: number }> }> }
      | undefined;
    expect(metric).toBeDefined();

    const { values } = await metric!.get();
    // Derived from the unions, not hardcoded: a 5th surface must be seeded too.
    const { GENERATION_SURFACES, MODEL_SUBSTITUTION_REASONS } = await import(
      '~/shared/data-graph/generation/model-substitution'
    );
    expect(values).toHaveLength(GENERATION_SURFACES.length * MODEL_SUBSTITUTION_REASONS.length);
    expect(values.every((v) => v.value === 0)).toBe(true);

    // Named explicitly — `api` is the surface #3665 adds and the one a phase-3
    // read queries first, so its presence-at-zero is the whole point.
    for (const reason of MODEL_SUBSTITUTION_REASONS) {
      expect(values.some((v) => v.labels.surface === 'api' && v.labels.reason === reason)).toBe(
        true
      );
    }
  });
});
