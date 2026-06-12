import { expect, test } from '@playwright/test';
import { storageStatePath } from './preview-fixtures';

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
    // Arm the response listener BEFORE navigating so an on-load fire isn't missed.
    // 45s (was 25s): whatIf is the heaviest client-side flow — page load + hydrate +
    // form init + resource resolve + orchestrator round-trip must all complete before
    // it fires. On a CPU-throttled preview pod a slow window pushed this past 25s and
    // it hard-failed (both attempts). 45s lets a slow window flake-and-recover; the
    // orchestrator itself is fast (~57ms), so this never approaches 45s when healthy.
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
    // preselected this will time out — see the UI-fallback test below for the signal.
    const response = await whatIfResponse;
    const body = await response.json();
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
