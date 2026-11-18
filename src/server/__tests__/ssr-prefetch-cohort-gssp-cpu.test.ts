import { instrumentationRegistry } from '@civitai/telemetry/client';
import type client from 'prom-client';
import type { GetServerSidePropsContext } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';
import { usePagesManifestFixture } from '~/server/utils/__tests__/pages-manifest.fixture';

/**
 * `ssr_prefetch_cohort_gssp_cpu_seconds_total`, through the real `createServerSideProps`: a page
 * whose resolver puts the request in the `ssrSignedInSkipPrefetch` trial gets its resolver-through-
 * dehydrate CPU counted under its route and arm; a request outside the trial is not counted.
 */

const h = vi.hoisted(() => ({ features: {} as Record<string, boolean> }));

// The anonymous request resolves its session; as in `ssr-trpcstate-reparse.test.ts`, it finds none.
vi.mock('~/server/auth/bearer-token', () => ({
  getSessionFromBearerToken: vi.fn(async () => null),
}));
vi.mock('~/server/auth/session-client', () => ({
  getHubSession: vi.fn(async () => null),
  maybeRollHubCookie: vi.fn(async () => undefined),
  sessionClient: { getSessionUserById: vi.fn(async () => null) },
}));
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsService>()),
  getFeatureFlagsAsync: vi.fn(async () => h.features),
}));

const { createServerSideProps } = await import('~/server/utils/server-side-helpers');
const { resolveSsrPrefetchCohort } = await import('~/server/utils/ssr-skip-prefetch');
const { SSR_PREFETCH_COHORT_GSSP_CPU_METRIC, SSR_PREFETCH_COHORT_GSSP_METRIC } = await import(
  '~/server/prom/ssr-cpu.metrics'
);

const ROUTE = '/models/[id]/[[...slug]]';

/** Burns at least `ms` of CPU, timed by CPU rather than wall clock. */
function burn(ms: number) {
  const start = process.cpuUsage();
  const deadline = Date.now() + 5000;
  let x = 0;
  while (Date.now() < deadline) {
    for (let i = 0; i < 10_000; i++) x += Math.sqrt(x + 1);
    const { user, system } = process.cpuUsage(start);
    if (user + system >= ms * 1000) return x;
  }
  throw new Error('burn: CPU clock did not advance');
}

// The page: in the trial, the full arm does its "prefetches" (20ms of CPU), the skip arm does not.
const page = createServerSideProps({
  useSession: true,
  resolver: async ({ ctx, session, features }) => {
    const cohort = resolveSsrPrefetchCohort({ ctx, session, features, route: ROUTE });
    if (cohort !== 'skip') burn(20);
    return { props: { cohort: cohort ?? 'none' } };
  },
});

type Row = { value: number; labels: Record<string, string> };
async function rows(name: string): Promise<Row[]> {
  const metric = instrumentationRegistry.getSingleMetric(name) as client.Counter | undefined;
  return metric ? ((await metric.get()).values as Row[]) : [];
}

async function load(signedIn: boolean) {
  const result = (await page({
    req: {
      url: '/models/4201/lantern-glow-portrait-lora',
      headers: { host: 'civitai.com' },
      cookies: {},
      // `_app` seeds the session on the request; createServerSideProps reads it first.
      session: signedIn ? { user: { id: 5, username: 'lantern-viewer' } } : null,
    },
    res: { setHeader: vi.fn(), getHeader: vi.fn() },
    query: {},
    resolvedUrl: '/models/4201/lantern-glow-portrait-lora',
  } as unknown as GetServerSidePropsContext)) as { props?: { cohort?: string } };
  return result.props?.cohort;
}

beforeEach(() => {
  usePagesManifestFixture();
  for (const name of [SSR_PREFETCH_COHORT_GSSP_CPU_METRIC, SSR_PREFETCH_COHORT_GSSP_METRIC]) {
    (instrumentationRegistry.getSingleMetric(name) as client.Counter | undefined)?.reset();
  }
});

describe('createServerSideProps records the trial arm getServerSideProps CPU', () => {
  it.each([
    ['full', false],
    ['skip', true],
  ])('cohort=%s: one run, under the route and arm', async (cohort, flag) => {
    h.features = { ssrSignedInSkipPrefetch: flag };
    expect(await load(true)).toBe(cohort);

    await vi.waitFor(async () =>
      expect(await rows(SSR_PREFETCH_COHORT_GSSP_METRIC)).toHaveLength(1)
    );
    expect(await rows(SSR_PREFETCH_COHORT_GSSP_METRIC)).toEqual([
      { value: 1, labels: { route: ROUTE, cohort } },
    ]);
    const [cpu, ...rest] = await rows(SSR_PREFETCH_COHORT_GSSP_CPU_METRIC);
    expect(rest).toEqual([]);
    expect(cpu.labels).toEqual({ route: ROUTE, cohort });
    expect(cpu.value).toBeLessThan(1);
    // The full arm's resolver burnt 20ms inside the measured span.
    if (cohort === 'full') expect(cpu.value).toBeGreaterThanOrEqual(0.02);
  });

  it('outside the trial (anonymous): nothing recorded', async () => {
    h.features = { ssrSignedInSkipPrefetch: true };
    // Control: the page ran, and its resolver burnt CPU, so an empty counter is the mark speaking.
    expect(await load(false)).toBe('none');
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(await rows(SSR_PREFETCH_COHORT_GSSP_METRIC)).toEqual([]);
    expect(await rows(SSR_PREFETCH_COHORT_GSSP_CPU_METRIC)).toEqual([]);
  });
});
