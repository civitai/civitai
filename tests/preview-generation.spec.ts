import { expect, test } from '@playwright/test';
import { storageStatePath } from './preview-fixtures';
import { retryFlaky } from './preview-retry';

/**
 * Generation cost-quote e2e for a deployed PR preview.
 *
 * De-mocks the orchestrator: instead of stubbing the price endpoint, this drives
 * the REAL `/generate` page as a gate-passing PAID member (gold) and asserts the
 * client actually fires the tRPC QUERY `orchestrator.whatIfFromGraph` and gets a
 * numeric Buzz cost back. whatIf is a pure price quote (no Buzz balance needed),
 * so it fires on-load once a model+workflow is selected — the default form
 * preselects a model, so we PREFER the on-load path (no interaction).
 *
 * Runs only under playwright.preview.config.ts (needs PREVIEW_URL + minted
 * storage states). Cost source of truth: superjson-wrapped, batched tRPC
 * response `[{ result: { data: { json: { cost: { total } } } } }]`
 * (see orchestration-new.service.ts ~L1452 and useWhatIfFromGraph.ts).
 */

// Use the PAID member — passes the preview gate AND is a real generation user.
test.describe('generation cost quote (gold)', () => {
  test.use({ storageState: storageStatePath('gold') });

  const WHATIF_URL = '/api/trpc/orchestrator.whatIfFromGraph';

  /**
   * Pull the first numeric `cost.total` out of a tRPC response body, tolerating:
   *  - batched array vs single object
   *  - superjson `{ json: ... }` unwrapping at the data layer
   *  - the `{ result: { data: ... } }` envelope
   * Returns a number, or null if not found. Walks defensively because the exact
   * nesting depends on tRPC batch-link + superjson transformer versions.
   */
  function extractCostTotal(body: unknown): number | null {
    const entries = Array.isArray(body) ? body : [body];
    for (const entry of entries) {
      // result.data, then optional superjson `.json`, then `.cost.total`.
      const data = (entry as any)?.result?.data;
      const payload = data?.json ?? data;
      const total = payload?.cost?.total;
      if (typeof total === 'number') return total;
    }
    return null;
  }

  // 1. Primary, network-based: whatIf fires on /generate load and quotes a cost.
  test('whatIfFromGraph fires on /generate and returns a numeric cost', async ({ page }) => {
    // /generate is the heaviest SSR page; on a cold/contended single-replica preview
    // pod the load+hydrate can exceed the whatIf wait, and Playwright's test-level
    // retries fire within seconds — too fast to outlast a load spike. Retry the whole
    // navigate+wait with backoff so a transient spike is ridden out (the assertion
    // must still pass; a sustained failure surfaces after the attempts). Extend the
    // per-test timeout to fit ~2 attempts of the 45s wait + navigation + backoff.
    test.setTimeout(200_000);
    const { body } = await retryFlaky(
      'whatIf on /generate',
      async () => {
        // Arm the response listener BEFORE navigating so an on-load fire isn't missed.
        // 45s: whatIf is the heaviest client-side flow — page load + hydrate + form
        // init + resource resolve + orchestrator round-trip must complete before it
        // fires. The orchestrator itself is fast (~57ms), so when healthy this never
        // approaches 45s — the budget is for a cold-pod slow window.
        const whatIfResponse = page.waitForResponse(
          (r) => r.url().includes(WHATIF_URL) && r.status() === 200,
          { timeout: 45_000 }
        );

        const resp = await page.goto('/generate', { waitUntil: 'domcontentloaded' });
        expect(resp?.status(), 'HTTP status for /generate').toBeLessThan(400);

        // Gate must not bounce a gold (paid) member.
        expect(page.url(), 'should not redirect to /login').not.toContain('/login');
        expect(page.url(), 'should not redirect to /preview-restricted').not.toContain(
          '/preview-restricted'
        );

        // NOTE: relies on the default /generate form preselecting a valid model+workflow
        // so whatIf fires without interaction. If a future default ships with no model
        // preselected this will time out — see the UI-fallback note below.
        const response = await whatIfResponse;
        return { body: await response.json() };
      },
      { attempts: 2 }
    );

    const total = extractCostTotal(body);
    expect(total, 'cost.total parsed from whatIfFromGraph response').not.toBeNull();
    expect(typeof total, 'cost.total is numeric').toBe('number');
    expect(total as number, 'cost.total is a non-negative quote').toBeGreaterThanOrEqual(0);
  });

  // The real pricing path is fully covered by the network assertion above. A DOM
  // cost-near-submit check was dropped: the submit button + cost live in a gen
  // panel that's collapsed by default on the preview viewport (button resolves
  // but is `hidden`), making it a fragile, redundant assertion.
});
