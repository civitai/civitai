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
 * storage states). Cost source of truth: the whatIf payload
 * `{ allowMatureContent, transactions, cost: { …, total }, ready }` returned by
 * `orchestration-new.service.ts:whatIfFromGraph` (see also useWhatIfFromGraph.ts).
 * 🔴 That payload reaches the browser in THREE different wire shapes depending on
 * whether the `trpcBatching` flag is on for the session — an unbatched envelope, a
 * batched JSON array, or newline-delimited `application/jsonl` stream chunks. Both
 * the URL matcher and the body parser below must handle all three; assuming the
 * unbatched shape is what made this test fail 100% of the time once batching
 * ramped (see the comments on `isWhatIfResponse` / `extractCostTotal`).
 */

// Use the PAID member — passes the preview gate AND is a real generation user.
test.describe('generation cost quote (gold)', () => {
  test.use({ storageState: storageStatePath('gold') });

  const WHATIF_PROCEDURE = 'orchestrator.whatIfFromGraph';

  /**
   * Does this response carry the whatIf query?
   *
   * 🔴 Do NOT go back to `url().includes('/api/trpc/orchestrator.whatIfFromGraph')`.
   * With the `trpcBatching` flag on (`httpBatchStreamLink`, src/utils/trpc.ts), the
   * client coalesces concurrent queries into ONE request whose path is the
   * COMMA-JOINED procedure list, and whatIf is not first:
   *   /api/trpc/content.get,challenge.getInfinite,generationPreset.getOwn,
   *             wildcardSet.getMyUserSet,user.userRewardDetails,
   *             orchestrator.whatIfFromGraph?batch=1&input=…
   * That URL does not contain the `/api/trpc/<proc>` prefix, so a prefix match never
   * fires and the wait times out on a request that DID happen and DID return 200.
   * Batch membership varies run to run, so match the procedure inside the path list.
   */
  function isWhatIfResponse(url: string): boolean {
    let pathname: string;
    try {
      pathname = new URL(url).pathname;
    } catch {
      return false;
    }
    const prefix = '/api/trpc/';
    if (!pathname.startsWith(prefix)) return false;
    return pathname.slice(prefix.length).split(',').includes(WHATIF_PROCEDURE);
  }

  /**
   * Pull the whatIf `cost.total` out of a raw tRPC response body.
   *
   * The body arrives in one of three wire shapes depending on link + batching, so
   * parse the RAW TEXT rather than `response.json()` (which throws on the streamed
   * one):
   *  1. unbatched  `{"result":{"data":{"json":{…,"cost":{…},"ready":true}}}}`
   *  2. batched    `[{…},…,{"result":{"data":{"json":{…}}}}]`
   *  3. batched + streamed — `httpBatchStreamLink` sends `trpc-accept: application/jsonl`,
   *     so the server answers with NEWLINE-DELIMITED JSON chunks that reference each
   *     other by index; `JSON.parse` of the whole body fails, and the payload sits at a
   *     different depth (`{"json":[17,0,[[{…,"cost":{…},"ready":true}]]]}`).
   *
   * The one thing stable across all three is the whatIf payload object itself, so find
   * it structurally: an object with BOTH a numeric `cost.total` and a boolean `ready`.
   * Requiring `ready` scopes the search to whatIf — the payload contract in
   * `orchestration-new.service.ts:whatIfFromGraph` always returns both — so a sibling
   * procedure sharing the batch can't satisfy the match and produce a false pass.
   */
  function extractCostTotal(raw: string): number | null {
    const docs: unknown[] = [];
    try {
      docs.push(JSON.parse(raw));
    } catch {
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          docs.push(JSON.parse(trimmed));
        } catch {
          // A partial/among-chunks line: skip it, another chunk carries the payload.
        }
      }
    }

    const seen = new Set<unknown>();
    const walk = (value: unknown): number | null => {
      if (value === null || typeof value !== 'object') return null;
      if (seen.has(value)) return null;
      seen.add(value);
      const node = value as any;
      if (typeof node?.cost?.total === 'number' && typeof node?.ready === 'boolean') {
        return node.cost.total;
      }
      for (const child of Object.values(node as Record<string, unknown>)) {
        const hit = walk(child);
        if (hit !== null) return hit;
      }
      return null;
    };

    for (const doc of docs) {
      const hit = walk(doc);
      if (hit !== null) return hit;
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

    // 🔴 Buffer the whatIf body OURSELVES instead of reading `response.text()` later.
    // Under `httpBatchStreamLink` the app reads the whole jsonl stream (cost included)
    // and then abandons the still-open reader. Chromium reports that to Playwright as
    // `net::ERR_ABORTED` and evicts the resource, so a later `response.text()` fails
    // with "Protocol error (Network.getResponseBody): No data found for resource with
    // given identifier" — measured on 4 of 8 /generate loads, i.e. a coin-flip flake
    // that has nothing to do with the product. Routing the request lets Playwright do
    // the fetch and hold the complete body, removing the race entirely.
    let capturedBody: string | null = null;
    await page.route(
      (url) => isWhatIfResponse(url.toString()),
      async (route) => {
        const routed = await route.fetch();
        const text = await routed.text();
        if (routed.status() === 200 && capturedBody === null) capturedBody = text;
        await route.fulfill({ response: routed, body: text });
      }
    );

    const { body } = await retryFlaky(
      'whatIf on /generate',
      async () => {
        capturedBody = null;
        // Arm the response listener BEFORE navigating so an on-load fire isn't missed.
        // 45s: whatIf is the heaviest client-side flow — page load + hydrate + form
        // init + resource resolve + orchestrator round-trip must complete before it
        // fires. The orchestrator itself is fast (~57ms), so when healthy this never
        // approaches 45s — the budget is for a cold-pod slow window.
        const whatIfResponse = page.waitForResponse(
          (r) => isWhatIfResponse(r.url()) && r.status() === 200,
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
        await whatIfResponse;
        // Read the body the route handler buffered, NOT `response.text()` (see above).
        // Raw text, not `.json()`: under batching the body is newline-delimited JSON
        // (`trpc-accept: application/jsonl`) and `.json()` throws on it.
        expect(capturedBody, 'whatIf response body was captured').not.toBeNull();
        return { body: capturedBody as string };
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
