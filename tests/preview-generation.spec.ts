import { expect, test, type Page } from '@playwright/test';
import {
  ecosystemById,
  getEcosystemGroup,
  getEcosystemSetting,
} from '~/shared/constants/basemodel.constants';
import { getEcosystemsForWorkflow } from '~/shared/generation/config/workflows';
import { rulesToStates, type GateRule } from '~/shared/generation/gates';
import { storageStatePath } from './preview-fixtures';
import { retryFlaky } from './preview-retry';
import { trpcQuery } from './preview-trpc';

/**
 * Generation cost-quote e2e for a deployed PR preview.
 *
 * De-mocks the orchestrator: instead of stubbing the price endpoint, this drives
 * the REAL `/generate` page as a gate-passing PAID member (gold) and asserts the
 * client actually fires the tRPC QUERY `orchestrator.whatIfFromGraph` and gets a
 * numeric Buzz cost back. whatIf is a pure price quote (no Buzz balance needed),
 * so it fires on-load once a model+workflow is selected — the default form
 * preselects a model, so we PREFER the on-load path (no interaction). A generation
 * gate rule can disable the preselected ecosystem, though; then the test picks an
 * ecosystem the live gate config leaves open (see `quoteableEcosystems`).
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

  /**
   * The tRPC error messages carried in a raw response body, for a failure message.
   * A batched response is HTTP 200 even when one procedure in it failed, so a whatIf
   * that the server refused still matches the 200 wait; without this the failure only
   * says "no cost", not why. Collects every `message` string that sits beside a
   * `code` (the tRPC error shape, at whatever depth the wire format puts it), and
   * nothing else, so the sibling procedures' data never reaches the log.
   */
  function errorMessages(raw: string): string[] {
    const messages: string[] = [];
    const walk = (value: unknown) => {
      if (value === null || typeof value !== 'object') return;
      const node = value as Record<string, unknown>;
      if (typeof node.message === 'string' && 'code' in node) messages.push(node.message);
      for (const child of Object.values(node)) walk(child);
    };
    for (const line of raw.split('\n')) {
      try {
        walk(JSON.parse(line));
      } catch {
        // Not a JSON line: nothing to report from it.
      }
    }
    return messages;
  }

  // The workflow the form opens on, and the one the quote is taken for.
  const QUOTE_WORKFLOW = 'txt2img';

  /** An ecosystem the test can switch the form to, and the name its picker entry shows. */
  type PickableEcosystem = { key: string; pickerName: string };

  /**
   * Which txt2img ecosystems the gold user can use RIGHT NOW, per the live gate config.
   *
   * Why the test asks at all: moderators can gate ecosystems off for everyone else
   * (generation gate rules), and such a rule can disable the ecosystem the form
   * preselects. The product deliberately does NOT switch a gated selection to another
   * ecosystem behind the user's back — it stays selected and the form says it is
   * unavailable — so a test that only takes the default cannot get a quote while the
   * default is gated. That is the test's problem, not the product's, so the test reads
   * the same config the form does and quotes on an ecosystem that is open.
   *
   * `getGenerationConfig` already narrows the rules to the ones that gate THIS user
   * (`applicableRulesFor`, server side); `rulesToStates` is what the form graph folds
   * them with, and drops `experimental` rules (they mark an item, they do not gate it).
   *
   * `open` is every ungated txt2img ecosystem: a quote for any of them counts.
   * `pickable` is the subset the test can switch to in the picker: it needs a default
   * model so the form has a checkpoint to price, and standalone entries come first
   * because a picker GROUP entry resolves to the group's last-used member, which on
   * this page can be the gated one being left.
   */
  async function openEcosystems(
    page: Page
  ): Promise<{ open: Set<string>; pickable: PickableEcosystem[] }> {
    const config = await trpcQuery<{
      gateRules?: GateRule[];
      selfHostedDisabledEcosystems?: string[];
    }>(page.request, 'generation.getGenerationConfig');
    const gateRules = config?.gateRules;
    if (!Array.isArray(gateRules)) {
      throw new Error('generation.getGenerationConfig returned no gateRules array');
    }
    const states = rulesToStates(gateRules);
    const workflowGate = states.workflows.get(QUOTE_WORKFLOW);
    if (workflowGate) {
      throw new Error(
        `The ${QUOTE_WORKFLOW} workflow is gated (${workflowGate.state}) for the gold user, ` +
          'so no ecosystem can quote a cost.'
      );
    }
    const gated = new Set([
      ...(config?.selfHostedDisabledEcosystems ?? []),
      ...states.ecosystems.keys(),
    ]);

    const open = new Set<string>();
    const standalone: PickableEcosystem[] = [];
    const grouped: PickableEcosystem[] = [];
    for (const id of getEcosystemsForWorkflow(QUOTE_WORKFLOW)) {
      const ecosystem = ecosystemById.get(id);
      if (!ecosystem || gated.has(ecosystem.key)) continue;
      open.add(ecosystem.key);
      const defaultVersionId = getEcosystemSetting(id, 'model')?.id;
      if (!defaultVersionId || states.modelVersionIds.has(defaultVersionId)) continue;
      const group = getEcosystemGroup(id);
      // Clicking a group entry lands on its default member, so only that one is reachable.
      if (group && group.defaultEcosystemId !== id) continue;
      if (group) grouped.push({ key: ecosystem.key, pickerName: group.displayName });
      else standalone.push({ key: ecosystem.key, pickerName: ecosystem.displayName });
    }

    if (!open.size) {
      throw new Error(
        `No ${QUOTE_WORKFLOW} ecosystem is available to the gold user: the live gate config ` +
          `disables all of them (${[...gated].sort().join(', ')}).`
      );
    }
    return { open, pickable: [...standalone, ...grouped] };
  }

  /** Whether a tRPC response is for `generation.getGenerationConfig` (batched or not). */
  function isGenerationConfigResponse(url: string): boolean {
    try {
      const { pathname } = new URL(url);
      return pathname.startsWith('/api/trpc/')
        ? pathname.slice('/api/trpc/'.length).split(',').includes('generation.getGenerationConfig')
        : false;
    } catch {
      return false;
    }
  }

  /** The visible ecosystem trigger of the generator form ("Ecosystem: X. Change ecosystem"). */
  const ecosystemTrigger = (page: Page, name?: string) =>
    page
      .getByRole(
        'button',
        name
          ? { name: `Ecosystem: ${name}. Change ecosystem`, exact: true }
          : { name: /^Ecosystem: .*\. Change ecosystem$/ }
      )
      .filter({ visible: true })
      .first();

  /** The ecosystem name the trigger currently shows. */
  async function shownEcosystem(page: Page): Promise<string | undefined> {
    const label = await ecosystemTrigger(page).getAttribute('aria-label', { timeout: 5_000 });
    return label?.match(/^Ecosystem: (.*)\. Change ecosystem$/)?.[1];
  }

  /**
   * Make `target` the form's ecosystem the way a user does: open the picker, search,
   * click the entry. The trigger's own label is then the proof the selection took.
   * Every step has its own timeout so a stuck step fails by name, not as the test's.
   */
  async function selectEcosystem(page: Page, target: PickableEcosystem) {
    await ecosystemTrigger(page).click({ timeout: 15_000 });
    await page
      .getByPlaceholder('Search ecosystems...')
      .filter({ visible: true })
      .first()
      .fill(target.pickerName, { timeout: 15_000 });
    await page
      .getByRole('button')
      .filter({ has: page.getByText(target.pickerName, { exact: true }) })
      .filter({ hasNotText: 'Change' })
      .filter({ visible: true })
      .first()
      .click({ timeout: 15_000 });
    await expect(
      ecosystemTrigger(page, target.pickerName),
      `ecosystem picker switched the form to ${target.key}`
    ).toBeVisible({ timeout: 15_000 });
  }

  /** One whatIf the route handler saw: what was asked, and the buffered answer. */
  type Quote = { request: string; status: number; body: string };

  /** The request's input as text, wherever the link put it (GET query or POST body). */
  function requestText(url: string, postData: string | null): string {
    let decoded = url;
    try {
      decoded = decodeURIComponent(url);
    } catch {
      // Malformed escape: match against the raw URL instead.
    }
    return `${decoded}\n${postData ?? ''}`;
  }

  /** The ecosystems a whatIf request asked about (a batch can carry several). */
  function askedEcosystems(quote: Quote): string[] {
    return [...quote.request.matchAll(/"ecosystem":"([^"]+)"/g)].map((m) => m[1]);
  }

  /**
   * Poll the captured whatIfs until one asked about an ecosystem in `wanted` and came
   * back with a cost. Returns it, or null once `ms` has passed.
   */
  async function waitForQuote(
    page: Page,
    quotes: Quote[],
    wanted: (ecosystem: string) => boolean,
    ms: number
  ): Promise<{ quote: Quote; ecosystem: string } | null> {
    const deadline = Date.now() + ms;
    for (;;) {
      // Read the body the route handler buffered, NOT `response.text()` (see above).
      // Raw text, not `.json()`: under batching the body is newline-delimited JSON
      // (`trpc-accept: application/jsonl`) and `.json()` throws on it.
      for (const quote of quotes) {
        const ecosystem = askedEcosystems(quote).find(wanted);
        if (ecosystem && quote.status === 200 && extractCostTotal(quote.body) !== null) {
          return { quote, ecosystem };
        }
      }
      if (Date.now() > deadline) return null;
      await page.waitForTimeout(250);
    }
  }

  /** What the captured whatIfs were, for a failure message. */
  const describeQuotes = (quotes: Quote[]) =>
    JSON.stringify(
      quotes.map((q) => ({
        ecosystems: askedEcosystems(q),
        status: q.status,
        errors: errorMessages(q.body),
      }))
    );

  // 1. Primary, network-based: whatIf fires on /generate load and quotes a cost.
  test('whatIfFromGraph fires on /generate and returns a numeric cost', async ({ page }) => {
    // /generate is the heaviest SSR page; on a cold/contended single-replica preview
    // pod the load+hydrate can exceed the whatIf wait, and Playwright's test-level
    // retries fire within seconds — too fast to outlast a load spike. Retry the whole
    // navigate+wait with backoff so a transient spike is ridden out (the assertion
    // must still pass; a sustained failure surfaces after the attempts). Extend the
    // per-test timeout to fit ~2 attempts of navigation + the 45s form wait + the
    // on-load window + an ecosystem switch + the 45s whatIf wait + backoff.
    test.setTimeout(300_000);

    // 🔴 Buffer the whatIf body OURSELVES instead of reading `response.text()` later.
    // Under `httpBatchStreamLink` the app reads the whole jsonl stream (cost included)
    // and then abandons the still-open reader. Chromium reports that to Playwright as
    // `net::ERR_ABORTED` and evicts the resource, so a later `response.text()` fails
    // with "Protocol error (Network.getResponseBody): No data found for resource with
    // given identifier" — measured on 4 of 8 /generate loads, i.e. a coin-flip flake
    // that has nothing to do with the product. Routing the request lets Playwright do
    // the fetch and hold the complete body, removing the race entirely.
    //
    // Every whatIf is kept, not just the first 200: a batched response is HTTP 200 even
    // when the whatIf inside it was refused, and the form quotes its initial selection
    // before the gate config has loaded — a gated default is refused with "Ecosystem is
    // currently unavailable". Which quote counts is decided by the ecosystem it asked about.
    const quotes: Quote[] = [];
    await page.route(
      (url) => isWhatIfResponse(url.toString()),
      async (route) => {
        const routed = await route.fetch();
        const text = await routed.text();
        const request = route.request();
        quotes.push({
          request: requestText(request.url(), request.postData()),
          status: routed.status(),
          body: text,
        });
        await route.fulfill({ response: routed, body: text });
      }
    );

    // Read the live gate config before loading the form; a gated workflow or no open
    // ecosystem fails here, by name, instead of as a whatIf timeout.
    const { open, pickable } = await openEcosystems(page);

    // 🔴 Unroute before the test ends. /generate fires whatIf more than once, so a later
    // whatIf can still be inside the handler's `route.fetch()` when the wait below
    // resolves, and teardown closing the page under it fails the test. `ignoreErrors`
    // stops waiting for in-flight handlers and swallows what they throw once unrouted.
    const { body, ecosystem } = await retryFlaky(
      'whatIf on /generate',
      async (attempt) => {
        quotes.length = 0;
        // Armed before navigating: the form applies the gates once this lands.
        const configLoaded = page.waitForResponse((r) => isGenerationConfigResponse(r.url()), {
          timeout: 45_000,
        });
        // Awaited below; this only keeps an early failure above from leaving it unhandled.
        configLoaded.catch(() => undefined);
        const resp = await page.goto('/generate', { waitUntil: 'domcontentloaded' });
        expect(resp?.status(), 'HTTP status for /generate').toBeLessThan(400);

        // Gate must not bounce a gold (paid) member.
        expect(page.url(), 'should not redirect to /login').not.toContain('/login');
        expect(page.url(), 'should not redirect to /preview-restricted').not.toContain(
          '/preview-restricted'
        );

        // 45s: page load + hydrate + form init is the slow part on a cold preview pod.
        await expect(
          ecosystemTrigger(page),
          'generator form shows its ecosystem picker'
        ).toBeVisible({ timeout: 45_000 });
        await configLoaded;

        // On-load path first (no interaction): when the form's own selection is open to
        // gold, it quotes it by itself. 20s is the on-load window once the form and its
        // gate config are up; when healthy the quote lands in a few seconds.
        const onLoad = await waitForQuote(page, quotes, (e) => open.has(e), 20_000);
        if (onLoad) {
          console.log(`[cost-quote] attempt ${attempt}: quoted on load -> ${onLoad.ecosystem}`);
          return { body: onLoad.quote.body, ecosystem: onLoad.ecosystem };
        }

        // No quote for an open ecosystem: the selection is gated (or still unquoted).
        // The form never switches a gated selection by itself — on purpose — so pick an
        // open one in the picker, as a user would.
        const shown = await shownEcosystem(page);
        const target = pickable.find((e) => e.pickerName === shown) ?? pickable[0];
        if (!target) {
          throw new Error(
            `No on-load quote for an open ecosystem (form shows "${shown}") and none of the ` +
              `open ones (${[...open].join(', ')}) can be picked; whatIfs: ` +
              describeQuotes(quotes)
          );
        }
        if (target.pickerName !== shown) await selectEcosystem(page, target);
        console.log(
          `[cost-quote] attempt ${attempt}: form showed "${shown}" with no open quote; ` +
            `quoting on ${target.key}`
        );

        // 45s: whatIf is the heaviest client-side flow — resource resolve + orchestrator
        // round-trip must complete before it fires. The orchestrator itself is fast
        // (~57ms), so when healthy this never approaches 45s — the budget is for a
        // cold-pod slow window.
        const picked = await waitForQuote(page, quotes, (e) => e === target.key, 45_000);
        if (!picked) {
          throw new Error(
            `No whatIfFromGraph quote with a cost for ${target.key} within 45s; ` +
              `whatIfs: ${describeQuotes(quotes)}`
          );
        }
        return { body: picked.quote.body, ecosystem: picked.ecosystem };
      },
      { attempts: 2 }
    )
      .catch((err) => {
        console.log(`[cost-quote] whatIfs of the last attempt: ${describeQuotes(quotes)}`);
        throw err;
      })
      .finally(() => page.unrouteAll({ behavior: 'ignoreErrors' }));

    const total = extractCostTotal(body);
    const errors = JSON.stringify(errorMessages(body));
    expect(
      total,
      `cost.total parsed from the ${ecosystem} whatIfFromGraph response (errors in it: ${errors})`
    ).not.toBeNull();
    expect(typeof total, 'cost.total is numeric').toBe('number');
    expect(total as number, 'cost.total is a non-negative quote').toBeGreaterThanOrEqual(0);
  });

  // The real pricing path is fully covered by the network assertion above. A DOM
  // cost-near-submit check was dropped: the submit button + cost live in a gen
  // panel that's collapsed by default on the preview viewport (button resolves
  // but is `hidden`), making it a fragile, redundant assertion.
});
