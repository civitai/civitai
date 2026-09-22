import { server } from '@vitest/browser/context';
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';
import { renderToString } from 'react-dom/server';
import type { Root } from 'react-dom/client';
import { hydrateRoot } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { RegionInfo } from '~/server/utils/region-blocking';
import type { UserContentSettings } from '~/server/schema/user.schema';
import type { ServerDomains } from '~/shared/constants/domain.constants';
// Type-only namespace import (NOT `typeof import('...')`, which
// @typescript-eslint/consistent-type-imports rejects) so the spread below keeps the real
// module's type.
import type * as TrpcMod from '~/utils/trpc';
import type { ConsentDecision } from '~/components/Consent/consent.utils';

/**
 * 🔴 MOVING THE CONSENT GATE'S REGION FROM A PROP TO CONTEXT MUST NOT MOVE ANY BYTE OF THE
 * SERVER RENDER — MEASURED, NOT REASONED.
 *
 * `ThirdPartyConsentProvider` carries a standing warning that a previous change to HOW it
 * loads (`next/dynamic` instead of a static import) produced a whole-tree hydration mismatch
 * that re-mounted the app and orphaned the server-rendered DOM — the "double layout" bug. The
 * region-source fix is a different kind of change, but it lands on the same component, so the
 * claim it rests on gets exercised here rather than asserted:
 *
 *   On the SSR render and on the FIRST client (hydration) render, `_app` still has the real
 *   SSR `region` — the prop is only absent on SUBSEQUENT client-side navigations. `AppProvider`
 *   seeds its frozen context from that same value at mount, on both sides. So the gate reaches
 *   the same verdict either way and the two renders are identical; only a later navigation
 *   diverges, and that divergence is the whole point of the fix.
 *
 * DETECTOR = `hydrateRoot`'s `onRecoverableError`, which is what React calls on a hydration
 * mismatch. A `console.error` text match is a SECOND, independent signal, so a change to
 * React's warning text cannot silently disarm both. The INSTRUMENT CHECK below is the control
 * for the detector itself: without it, "no mismatch" is indistinguishable from a spy attached
 * to nothing. Pattern borrowed from
 * `src/components/Apps/AppsRailNav.ssrHydration.browser.test.tsx`.
 *
 * The client-navigation BEHAVIOUR — the actual fix — is pinned by
 * `src/components/Consent/ThirdPartyConsentProvider.browser.test.tsx`. This file pins only
 * that the fix costs nothing at hydration.
 */

// 🔴 SIBLING FILE, SAME STUB. `ThirdPartyConsentProvider.browser.test.tsx` stubs
// the SAME four ambient queries. `AppProvider` has accreted them one at a time, so a fifth must
// be added to BOTH. This is a comment rather than a shared module because the failure is LOUD:
// an unstubbed query is a `TypeError` naming the missing property during render, not a silent
// zero, and the duplicate is eight lines of fixture with no logic in it.
// Only the ambient queries `AppProvider` fires. Spread of the real module, not a wholesale
// replacement (`local-rules/no-wholesale-module-mock`).
vi.mock('~/utils/trpc', async (importOriginal) => {
  const seeded = () => ({ data: undefined, isInitialLoading: false });
  return {
    ...(await importOriginal<typeof TrpcMod>()),
    trpc: {
      user: { getSettings: { useQuery: seeded }, getFollowingUsers: { useQuery: seeded } },
      system: { getLiveNow: { useQuery: seeded } },
      chat: { getUserSettings: { useQuery: seeded } },
    },
  };
});

const { AppProvider } = await import('~/providers/AppProvider');
const { ThirdPartyConsentProvider } = await import(
  '~/components/Consent/ThirdPartyConsentProvider'
);
const { useThirdPartyConsent } = await import('~/components/Consent/consent.context');

/**
 * 🔴 THIS FILE IS AN INVARIANT GUARD, NOT A REGRESSION TEST — it is GREEN at the pre-fix
 * commit as well as after, and deliberately so. Its claim is "the fix costs nothing at
 * hydration", and a test that only goes green after the fix could not make that claim about
 * the fix at all. Threading `region` to the consent provider as well as to `AppProvider` (the
 * pre-fix `_app` wiring) is what keeps it runnable on both sides; post-fix the prop is simply
 * ignored, because React ignores props a component does not read. `React.ComponentProps` keeps
 * the rest of the signature honest, so a real prop change still fails here.
 *
 * Its sibling `ThirdPartyConsentProvider.browser.test.tsx` is the regression test (red at the
 * pre-fix commit, green after). Do not read this file's green as evidence the fix works.
 */
const ConsentProviderWithLegacyRegionProp =
  ThirdPartyConsentProvider as unknown as React.ComponentType<
    React.ComponentProps<typeof ThirdPartyConsentProvider> & { region?: RegionInfo }
  >;

const CALIFORNIA: RegionInfo = { countryCode: 'US', regionCode: 'CA', fullLocationCode: 'US:CA' };
const TEXAS: RegionInfo = { countryCode: 'US', regionCode: 'TX', fullLocationCode: 'US:TX' };

const SERVER_DOMAINS: ServerDomains = {
  green: { primary: 'civitai.green', aliases: [] },
  blue: { primary: 'civitai.com', aliases: [] },
  red: { primary: 'civitai.red', aliases: [] },
};

function Probe() {
  const { consent, required, allowed } = useThirdPartyConsent();
  return (
    <div
      data-testid="consent-probe"
      data-required={String(required)}
      data-allowed={String(allowed)}
      data-consent={consent ?? 'none'}
    />
  );
}

/**
 * 🔴 THE POSITIVE CONTROL FOR HYDRATION ITSELF — without it every assertion in this file is a
 * zero of unknown provenance.
 *
 * `hydrateInto` plants the server HTML into the container BEFORE hydrating, so every
 * post-hydration DOM assertion here is already satisfied by that planted markup, and
 * `recoverable`/`hydrationConsoleErrors()` being EMPTY is exactly what you also get when
 * hydration never ran. Before this beacon existed, `hydrateInto` waited a FIXED 20 macrotasks
 * and then returned: shortening that to zero left all three content tests green while reporting
 * a clean hydration of a tree that never hydrated. The INSTRUMENT CHECK caught it, but only
 * because its tree is a single element — the cheapest possible point on the one dimension (tree
 * size) that decides how many turns hydration needs. Found by the `civitai-test-review` lane.
 *
 * This beacon is an ARRIVAL state that only the client can produce: `false` in the server HTML,
 * `true` once React has hydrated and run passive effects. Server and first client render both
 * emit `false`, so it cannot itself create the mismatch it is here to let us rule out.
 *
 * 🔴 IT IS NOW ENFORCED IN `hydrateInto`, NOT AT THE CALL SITES. The three content tests take
 * the `awaitBeacon` branch, which BLOCKS on this flag and throws if it never flips — so the
 * yield loop is unreachable for them and the mutant described above is no longer expressible
 * there. The per-test `expect(hydratedFlag(container)).toBe('true')` is therefore a legible
 * restatement, not the thing doing the work: the guarantee lives in the helper. If that wait is
 * ever moved back out, these call-site assertions become the guarantee again — do not delete
 * both.
 */
function HydrationBeacon() {
  const [hydrated, setHydrated] = React.useState(false);
  React.useEffect(() => setHydrated(true), []);
  return <i data-testid="hydrated" data-hydrated={String(hydrated)} />;
}

/**
 * The `_app` wiring, reduced to the two providers that matter, under the providers the
 * consent banner needs. `region` here is the SSR value — present on BOTH the server render and
 * the hydration render, which is exactly the premise under test.
 */
function Tree({
  region,
  initialConsent,
}: {
  region: RegionInfo | undefined;
  initialConsent: ConsentDecision | null;
}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return (
    <QueryClientProvider client={queryClient}>
      <MantineProvider>
        <AppProvider
          seed={1}
          canIndex={false}
          settings={{} as UserContentSettings}
          liveNow={false}
          region={region}
          domain="blue"
          host="civitai.com"
          serverDomains={SERVER_DOMAINS}
          availableOAuthProviders={[]}
          verifiedBot={null}
          isAuthed={false}
        >
          <ConsentProviderWithLegacyRegionProp
            region={region}
            initialConsent={initialConsent}
            loggedIn={false}
          >
            <Probe />
            <HydrationBeacon />
          </ConsentProviderWithLegacyRegionProp>
        </AppProvider>
      </MantineProvider>
    </QueryClientProvider>
  );
}

/**
 * React's hydration-mismatch vocabulary (React 18). Deliberately NARROW — a broad `/hydrat/`
 * matches MantineProvider's benign "useLayoutEffect does nothing on the server … non-hydrated
 * UI" SSR notice, which fires on every server render of any Mantine tree.
 */
const HYDRATION_RE =
  /(Hydration failed|An error occurred during hydration|The server HTML was replaced|Expected server HTML|did not match|Text content does not match)/i;

let consoleErrors: string[] = [];
let recoverable: string[] = [];
/**
 * The beacon wait's own budget. It must clear the project's per-test deadline by
 * `MIN_MARGIN_MS` once `PRE_WAIT_BUDGET_MS` is accounted for; `hydrateInto` has the invariant
 * and what goes wrong at, say, `14_000`.
 *
 * 🔴 WHO PINS WHAT — three operands, two mechanisms, and this one is the FREE VARIABLE.
 *   - `PROJECT_TIMEOUT_MS` — pinned by the guard test, against the live resolved config.
 *   - `PRE_WAIT_BUDGET_MS` — pinned by `afterAll`, against what this run actually measured.
 *   - `BEACON_TIMEOUT_MS` (this one) — pinned by NOTHING directly. It is the quantity the other
 *     two exist to constrain, and the margin assertion is the only thing bounding it.
 * Stated here once, because three earlier versions of this comment each claimed a coverage the
 * mechanisms did not have. Found by the `civitai-test-review` lane, three rounds running.
 */
const BEACON_TIMEOUT_MS = 10_000;

/**
 * The `component` project's effective per-test timeout.
 *
 * 🔴 A RESTATEMENT, PINNED — NOT A MEASUREMENT FROZEN INTO A LITERAL. It is not declared
 * anywhere in this repo: `vitest.config.mts` sets `testTimeout` only inside `unitTestConfig`,
 * which the `component` project does not spread, so the effective value is vitest's
 * browser-mode default. The root `CLAUDE.md` states the same fact in prose ("browser-mode
 * `testTimeout` defaults to 15 s, and the `component` project does not override it"), and
 * `src/components/AppBlocks/PageBlockHost.browser.test.tsx` reached it independently and sizes
 * its own poll budget against it, as does
 * `src/components/Account/PlacementSpaceSection.freeSlots.browser.test.tsx` (its argument for
 * reading an attribute instead of locating by string is sized against this budget, so a downward
 * move breaks its reasoning too). There are more — the value is also in the RCA those were
 * distilled from — so treat this list as a starting point, not a census: the point is that a
 * population exists and that THIS is the only copy a machine checks. ⚠️ When sweeping for it,
 * `src/components/AppBlocks/pageBlockHostLogic.ts`'s `TOKEN_WAIT_TIMEOUT_MS` is a PRODUCT
 * timeout that merely shares the value; a `15_000` regex mixes the two.
 *
 * It is checkable because the guard test asserts this constant EQUALS
 * `server.config.testTimeout`, which is the component project's own resolved value. That closes
 * three rot vectors a comment cannot: `browserTestShell()` is shared with the geometry tier, so
 * tuning that tier moves this one; the 15 s is a vitest default, so a vitest major can move it
 * with nothing in this repo changing; and `scripts/test-component-run.mjs` forwards a
 * `--test-timeout` from the command line. All three move it DOWNWARD-capable, which is the
 * dangerous direction — below `BEACON_TIMEOUT_MS` the beacon wait loses the race again and the
 * failure goes back to a bare `Test timed out`. Found by the `civitai-test-review` and
 * `civitai-reuse-review` lanes, which arrived at it from opposite sides.
 */
const PROJECT_TIMEOUT_MS = 15_000;

/**
 * Budget for everything that runs on the TEST's clock before the beacon wait starts —
 * `renderToString` of the full Mantine tree, the `toContain`s, an `innerHTML` parse and the
 * `hydrateRoot` call. `beforeEach`/`afterEach` do not count against the DEADLINE — vitest charges
 * those to a separate `hookTimeout` — but the ledger's clock starts inside `beforeEach`, so its
 * tail is deliberately included by a hair. Over-counting is the safe direction for a budget.
 *
 * 🔴 A BUDGET, AND MEASURED AGAINST — not an assertion about the world. The ledger below reads
 * **~5 ms** on a quiet box; the budget is 3 s, i.e. ~600x headroom, which is deliberate because
 * the quantity is load-scaled. (An earlier comment here said ~75 ms, inferred from the
 * neutered-beacon mutant failing at 10.07-10.09 s against a 10.00 s wait. That bounded pre-wait
 * from above but also swept in the wait's own overshoot; the direct measurement replaced it.)
 * The arithmetic guard alone could never contradict this — add two providers to `Tree` and
 * pre-wait can triple with every test still green — so `afterAll` compares the budget against
 * the largest pre-wait this run actually observed.
 */
const PRE_WAIT_BUDGET_MS = 3_000;

/**
 * "Several seconds", as a NUMBER. The margin assertion was an adjective in prose for two rounds
 * and a `<=` in code, which admitted the exact tie `hydrateInto` calls fatal. Any edit that eats
 * this margin has to change this line deliberately.
 */
const MIN_MARGIN_MS = 2_000;

/** Largest pre-wait observed this run, recorded in `hydrateInto` and checked in `afterAll`. */
let maxPreWaitMs = 0;
/** Start of the current test's own clock, as near as a hook can get to it. */
let preWaitStart = 0;

let restoreConsole: (() => void) | null = null;
const containers: HTMLElement[] = [];
/**
 * Every root this file hydrates, so `afterEach` can unmount it. Detaching the container alone
 * leaves the root MOUNTED against detached nodes, still able to write into a later test's
 * freshly-armed `recoverable`/`consoleErrors` arrays. That direction fails red rather than
 * green, so it is a flake vector rather than a false-confidence one — but it is free to close.
 * The pre-existing `AppsRailNav.ssrHydration.browser.test.tsx` this pattern came from does not
 * do it; that copy has NOT been re-measured here, so nothing is claimed about it either way.
 */
const roots: Root[] = [];

beforeEach(() => {
  // As near the start of the test's own clock as a hook can get. The hook→body gap over-counts
  // by well under a millisecond, which is the safe direction for a budget.
  preWaitStart = performance.now();
  consoleErrors = [];
  recoverable = [];
  const original = console.error;
  console.error = ((...args: unknown[]) => {
    consoleErrors.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
    original.apply(console, args as []);
  }) as typeof console.error;
  restoreConsole = () => {
    console.error = original;
  };
});

/**
 * 🔴 THE FALSIFIABLE HALF OF `PRE_WAIT_BUDGET_MS`. The arithmetic guard compares the BUDGET
 * against the ceiling; this compares what actually happened against the budget, so the constant
 * stops being an unfalsifiable claim. `afterAll` rather than a test, because the guard test does
 * not run last and a max taken in test order would only see part of the run.
 *
 * ⚠️ IT SURFACES AS A FAILED SUITE, NOT A FAILED TEST. Verified by starving the budget to 1 ms:
 * exit code 1 and `Test Files 1 failed`, while the summary still reads `Tests 5 passed (5)`.
 * Read the file line, not the test line.
 *
 * ⚠️ AND IT IS VACUOUS UNDER A `-t` FILTER that excludes every hydrating test: `maxPreWaitMs`
 * stays 0 and `0 <= 3000` passes, indistinguishable from a run that measured something. Not
 * closed with an `expect(maxPreWaitMs).toBeGreaterThan(0)`, which would break legitimate
 * filtered runs; CI runs the file whole, so the exposure is local-only. Stated rather than
 * guarded, on purpose.
 */
afterAll(() => {
  expect(
    maxPreWaitMs,
    'the work charged to the TEST clock before the beacon wait outgrew PRE_WAIT_BUDGET_MS — ' +
      'so BEACON_TIMEOUT_MS + real pre-wait may now exceed the project timeout, and a stalled ' +
      'hydration would fail as a bare "Test timed out" again. Either trim the pre-wait work ' +
      '(the `Tree` render is most of it) or lower BEACON_TIMEOUT_MS and raise this budget'
  ).toBeLessThanOrEqual(PRE_WAIT_BUDGET_MS);
});

afterEach(() => {
  restoreConsole?.();
  restoreConsole = null;
  // Unmount BEFORE detaching — a root unmounted after its container is gone still runs, and a
  // surviving root can report into the next test's arrays.
  for (const r of roots.splice(0)) r.unmount();
  for (const c of containers.splice(0)) c.remove();
});

/**
 * `'true'` ONLY after React hydrated the planted markup and ran passive effects — the control
 * that stops `recoverable: []` being an unproven zero. `'false'` means the markup is still the
 * server's and nothing hydrated.
 */
const hydratedFlag = (container: HTMLElement) =>
  container.querySelector('[data-testid="hydrated"]')?.getAttribute('data-hydrated') ?? '(absent)';

/** console.error lines that name a hydration problem (the SECOND signal). */
function hydrationConsoleErrors() {
  return consoleErrors.filter(
    (e) => HYDRATION_RE.test(e) && !/useLayoutEffect does nothing on the server/.test(e)
  );
}

/**
 * Plant `html` in a fresh container and hydrate it with `tree`, capturing every recoverable
 * error React reports. No `act()` — React 18.3's lives in `react-dom/test-utils`, which this
 * repo's `@types/react-dom` cannot resolve through its `exports` map.
 *
 * 🔴 `awaitBeacon` IS THE BARRIER, NOT THE TICK COUNT. React 18 time-slices hydration across
 * macrotasks, so how many turns a tree needs scales with its SIZE and with how loaded the box
 * is — a fixed budget is green on a quiet machine and red on a busy one, with no change to
 * blame. `HydrationBeacon` is an absorbing arrival state, which is exactly the shape `CLAUDE.md`
 * says to await, so the three content tests poll for it instead of guessing. The INSTRUMENT
 * CHECK carries no beacon (its tree is a single element and it is deliberately mismatching), so
 * it keeps the fixed budget — and that is safe there because its assertion is that `recoverable`
 * is NON-empty, so an under-run fails red. Raised by the `civitai-test-review` lane.
 *
 * ⚠️ `vi.waitFor` is still a wall-clock budget, not an unbounded wait — it is simply a far
 * better one: it fails RED rather than green, and it names the beacon when it does. The 1 s
 * default is deliberately raised; `CLAUDE.md`'s never-widen-a-budget rule is scoped to states
 * that DELETE themselves, and does not reach an absorbing arrival state like this one.
 *
 * 🔴 AND IT IS SET BELOW THE ENCLOSING TEST TIMEOUT ON PURPOSE. That deadline is
 * `PROJECT_TIMEOUT_MS` — read its docblock rather than re-deriving it here; it is asserted
 * against the live resolved config by the guard test, so it is no longer a figure anyone has to
 * measure by hand. At `{ timeout: 15_000 }` the two clocks tie and the TEST's deadline wins
 * (each content test does a full `renderToString` of a Mantine tree first), so a beacon that
 * never flips printed a bare `Test timed out in 15000ms` — the one failure shape that carries
 * no diagnosis.
 * At 10 s this `waitFor` fails first and prints what it was waiting for. Measured both ways by
 * the `civitai-test-review` lane.
 *
 * 🔴 "UNDER THE PROJECT TIMEOUT" IS NECESSARY, NOT SUFFICIENT. Everything before the wait —
 * `renderToString` of the full Mantine tree above all — is charged to the TEST's clock and not to
 * this one, so the invariant is
 *
 *     BEACON_TIMEOUT_MS + PRE_WAIT_BUDGET_MS + MIN_MARGIN_MS  <=  PROJECT_TIMEOUT_MS
 *
 * See `PRE_WAIT_BUDGET_MS` for how that term is sized and measured — deliberately not restated
 * here, because the figure it used to carry was retracted and this was the copy that survived
 * the correction. `14_000` is the trap: it is strictly under 15 s, it satisfies any formula that
 * ignores pre-wait, and it leaves under a second of margin — so the first load spike in that
 * `renderToString` restores exactly the bare `Test timed out` this budget exists to remove.
 *
 * 🔴 `MIN_MARGIN_MS` IS WHY THIS IS NOT WRITTEN `<=` ALONE. At equality the worst case lands
 * exactly ON the deadline and the deadline wins, which is the failure this whole apparatus
 * removes — so the guard once admitted it. Measured: with `<=` and no margin term, raising
 * `PRE_WAIT_BUDGET_MS` to `5_000` left the file fully green (5 passed) while making the tie
 * reachable. Both guards green, hazard restored. Found by the `civitai-test-review` lane.
 *
 * Ordering assumption that makes the early return safe: React reports recoverable errors during
 * the commit that hydrates, and the beacon flips in a PASSIVE effect after it — so by the time
 * the flag reads `true`, every `onRecoverableError` for that commit has already been pushed.
 *
 * ⚠️ `src/components/Apps/AppsRailNav.ssrHydration.browser.test.tsx`, which this harness was
 * copied from, is STILL on the fixed budget at every call site and has no beacon. Recorded
 * rather than fixed (changing a passing, unrelated suite is outside this PR), and recorded
 * with its DIRECTION because that is the part that matters: its post-hydrate assertions are
 * absence-shaped (`expect(recoverable).toEqual([])`), so a starved budget there reads GREEN,
 * while its own instrument check — the same single-element `Diverges` this file uses —
 * completes inside any budget and cannot report the shortfall.
 */
async function hydrateInto(
  html: string,
  tree: React.ReactElement,
  { awaitBeacon = true }: { awaitBeacon?: boolean } = {}
) {
  const container = document.createElement('div');
  container.innerHTML = html;
  document.body.appendChild(container);
  containers.push(container);
  roots.push(
    hydrateRoot(container, tree, {
      onRecoverableError: (err) => {
        recoverable.push(err instanceof Error ? err.message : String(err));
      },
    })
  );
  // Everything above ran on the TEST's clock; the wait below runs on its own. This is the
  // boundary `PRE_WAIT_BUDGET_MS` budgets for.
  //
  // ⚠️ ONE `hydrateInto` PER TEST. A second call would fold the FIRST beacon wait into this
  // measurement and blow the budget with a message telling you to trim the pre-wait work — a
  // misdiagnosis. Two waits in one test is a real invariant violation anyway; no test does it.
  maxPreWaitMs = Math.max(maxPreWaitMs, performance.now() - preWaitStart);

  if (awaitBeacon) {
    // `hydratedFlag` rather than an inline query so a failure prints `'(absent)'` rather than
    // `undefined` when the beacon element is not there at all.
    await vi.waitFor(
      () =>
        expect(
          hydratedFlag(container),
          '`HydrationBeacon` never reached `true`: React did not hydrate the planted server ' +
            `markup within ${BEACON_TIMEOUT_MS}ms, so every assertion after this point would be ` +
            'reading the planted HTML rather than a hydrated tree'
        ).toBe('true'),
      { timeout: BEACON_TIMEOUT_MS }
    );
    return container;
  }
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return container;
}

const probeAttrs = (container: HTMLElement) => {
  const el = container.querySelector('[data-testid="consent-probe"]');
  return {
    required: el?.getAttribute('data-required') ?? null,
    allowed: el?.getAttribute('data-allowed') ?? null,
    consent: el?.getAttribute('data-consent') ?? null,
  };
};

describe('ThirdPartyConsentProvider — real SSR → hydrate', () => {
  test('🔴 INSTRUMENT CHECK: a genuine server/client divergence IS reported by BOTH signals', async () => {
    let onServer = true;
    function Diverges() {
      return onServer ? <p>server</p> : <span>client</span>;
    }
    const html = renderToString(<Diverges />);
    onServer = false;
    await hydrateInto(html, <Diverges />, { awaitBeacon: false });

    expect(recoverable.length).toBeGreaterThan(0);
    expect(recoverable.join('\n')).toMatch(HYDRATION_RE);
    expect(hydrationConsoleErrors().length).toBeGreaterThan(0);
  });

  test('CA + rejected: the gate is applied in the SERVER HTML and hydration is clean', async () => {
    const html = renderToString(<Tree region={CALIFORNIA} initialConsent="rejected" />);

    // The decision is already correct on the first server render — the context read has not
    // deferred it to an effect. This is the half a "no hydration warning" assertion cannot
    // see: a tree that renders nothing on both sides also hydrates cleanly.
    expect(html).toContain('data-allowed="false"');
    expect(html).toContain('data-required="true"');
    // The banner must NOT be in the server HTML for an already-decided visitor.
    expect(html).not.toContain('Your privacy choices');
    expect(html).toContain('data-hydrated="false"');

    const container = await hydrateInto(
      html,
      <Tree region={CALIFORNIA} initialConsent="rejected" />
    );

    // Restatement of the barrier `hydrateInto` already enforced — kept because everything below
    // is a zero or a read of planted markup, and this is the line that says why any of it means
    // anything. See `HydrationBeacon`.
    expect(hydratedFlag(container)).toBe('true');
    expect(recoverable).toEqual([]);
    expect(hydrationConsoleErrors()).toEqual([]);
    expect(probeAttrs(container)).toEqual({
      required: 'true',
      allowed: 'false',
      consent: 'rejected',
    });
  });

  test('CA + undecided: the banner is SERVER-rendered and hydration is clean', async () => {
    const html = renderToString(<Tree region={CALIFORNIA} initialConsent={null} />);

    expect(html).toContain('Your privacy choices');
    expect(html).toContain('data-allowed="false"');
    expect(html).toContain('data-hydrated="false"');

    const container = await hydrateInto(html, <Tree region={CALIFORNIA} initialConsent={null} />);

    expect(hydratedFlag(container)).toBe('true');
    expect(recoverable).toEqual([]);
    expect(hydrationConsoleErrors()).toEqual([]);
    expect(container.textContent).toContain('Your privacy choices');
  });

  /**
   * 🔴 THE MARGIN, AS A TEST RATHER THAN AS A COMMENT. `hydrateInto`'s docblock argues that
   * `BEACON_TIMEOUT_MS` must leave room for the pre-wait work on the test's own clock; nothing
   * mechanical enforced that, and the value it warns against (`14_000`) is one edit away.
   *
   * TWO assertions here, and a THIRD in `afterAll` — see `BEACON_TIMEOUT_MS` for the full
   * three-operand ledger. The first pins the CEILING to the live config, without which the
   * inequality is computed against a literal that three separate mechanisms can move without
   * touching this file, all of them capable of moving it DOWN — the direction that silently
   * restores the bare `Test timed out`. `server.config` is the component project's own resolved
   * config; verified to read `15000` here rather than `undefined` before this was relied on, and
   * it THROWS outside browser mode rather than collecting zero tests.
   *
   * ⚠️ The ceiling assertion's remedy assumes the value moved permanently (a vitest bump, a
   * `browserTestShell()` edit). For a deliberate one-off `--test-timeout` on the command line the
   * right answer is to leave the constant alone; such a run is already flagged as narrowed by
   * `scripts/test-component-run.mjs`. It also cannot see a PER-TEST `{ timeout }` override —
   * none exists in this file, and one would make the guard green against the wrong deadline.
   */
  test('the beacon budget leaves real margin under the project timeout', () => {
    expect(
      server.config.testTimeout,
      "`PROJECT_TIMEOUT_MS` restates vitest browser mode's default, which nothing in this repo " +
        'declares. It has moved — the margin below is being computed against a number that is ' +
        'no longer the deadline. Update the constant, and check `BEACON_TIMEOUT_MS` still fits'
    ).toBe(PROJECT_TIMEOUT_MS);

    // 🔴 A MARGIN, NOT A `<=`. At equality the worst case lands exactly ON the deadline and the
    // deadline wins — the failure this apparatus removes. Measured: `<=` alone let
    // `PRE_WAIT_BUDGET_MS = 5_000` through with the file fully green.
    expect(
      PROJECT_TIMEOUT_MS - (BEACON_TIMEOUT_MS + PRE_WAIT_BUDGET_MS),
      'BEACON_TIMEOUT_MS must leave room for everything charged to the TEST clock before the ' +
        'wait starts, AND still clear the deadline by MIN_MARGIN_MS — otherwise the enclosing ' +
        'test deadline wins and the failure is a bare "Test timed out", with no mention of the ' +
        'beacon. See `hydrateInto`'
    ).toBeGreaterThanOrEqual(MIN_MARGIN_MS);
  });

  test('a non-consent region renders NO gate and NO banner, and hydrates clean', async () => {
    const html = renderToString(<Tree region={TEXAS} initialConsent={null} />);

    // The reachability arm: `data-allowed="true"` has to be producible through this harness,
    // or the two assertions above could be green because the probe can only say 'false'.
    expect(html).toContain('data-allowed="true"');
    expect(html).toContain('data-required="false"');
    expect(html).not.toContain('Your privacy choices');
    expect(html).toContain('data-hydrated="false"');

    const container = await hydrateInto(html, <Tree region={TEXAS} initialConsent={null} />);

    expect(hydratedFlag(container)).toBe('true');
    expect(recoverable).toEqual([]);
    expect(hydrationConsoleErrors()).toEqual([]);
    expect(probeAttrs(container)).toEqual({
      required: 'false',
      allowed: 'true',
      consent: 'none',
    });
  });
});
