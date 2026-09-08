import { useEffect, useReducer } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
// Type-only namespace import (NOT `typeof import('...')`, which
// @typescript-eslint/consistent-type-imports rejects) so the spread below keeps the
// real module's type.
import type * as TrpcMod from '~/utils/trpc';

/**
 * `AppsBuildBody` — THE UNSETTLED WINDOW. (clawgate #530; closes audit finding F6 from
 * civitai#4685, which recorded that this component had no rendered test in any tier.)
 *
 * 🔴 THE BUG THIS FILE IS THE REGRESSION TEST FOR. `blocks.getNavSummary` is client-only
 * (tRPC runs `ssr: false`), and `resolveAppsBuildState` reads its two all-false booleans as
 * `first-app`. So on `main` before this change EVERY author who has apps rendered state B —
 * "Ship your first app" — on the server and on the first client paint, and only swapped to
 * their workbench once the query landed. The wrong screen, briefly, on every visit.
 *
 * The analytics could not see it (`view` fires only when `settled`), which is exactly why
 * it survived a four-round and a two-round audit ladder: nothing that was measured moved.
 * It takes a RENDERED test, which is what this is.
 *
 * ── WHY THE MOCKS ARE SHAPED LIKE THIS ──────────────────────────────────────────
 * `mocks.isFetched` and `mocks.navSummary` are the query's two observable outputs, driven
 * independently on purpose: `isFetched` goes true on success OR error while `data` stays
 * `undefined` forever on an error, and the component keys its wait on the FORMER. Driving
 * them as one boolean would make the error cohort — the population most worth seeing —
 * untestable, and it is a cohort this component has already been corrected about once.
 *
 * 🔴 THE `getNavSummary` MOCK HONOURS `enabled`, AND THAT IS LOAD-BEARING RATHER THAN
 * FIDELITY FOR ITS OWN SAKE. A disabled query never runs, so React Query never sets
 * `isFetched` on it. A mock that ignored `enabled` would return whatever `mocks.isFetched`
 * says and the permanent-skeleton case below would be structurally unobservable — it would
 * pass while production hung. (The sibling `AppsSubNav.hydration.browser.test.tsx`
 * deliberately IGNORES `enabled` because its subject is the `useIsClient` deferral; the
 * choice is per-suite, not a house style.)
 */

/** A summary for an author who HAS apps — the cohort the bug hit. */
const SUMMARY_WITH_APPS = {
  hasInstalls: false,
  hasSubmissions: false,
  hasApprovedApps: false,
  isReviewer: false,
  hasEditableApps: true,
  hasPendingInvites: false,
};

/** The all-false summary — an author with genuinely nothing yet (real state B). */
const EMPTY_SUMMARY = { ...SUMMARY_WITH_APPS, hasEditableApps: false };

type TrackedAction = { type: string; details: { action: string; state: string } };

const mocks = vi.hoisted(() => ({
  isClient: true,
  isFetched: false,
  navSummary: undefined as undefined | Record<string, boolean>,
  flags: { appBlocks: true, appBlocksAuthor: true } as Record<string, boolean>,
  user: { id: 7, username: 'author', isModerator: false } as null | {
    id: number;
    username: string;
    isModerator?: boolean;
  },
  tracked: [] as TrackedAction[],
  /** What `enabled:` the component actually passed — asserted, not assumed. */
  lastEnabled: undefined as undefined | boolean,
}));

vi.mock('~/providers/IsClientProvider', () => ({ useIsClient: () => mocks.isClient }));
vi.mock('~/providers/FeatureFlagsProvider', () => ({ useFeatureFlags: () => mocks.flags }));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => mocks.user }));

vi.mock('~/components/TrackView/track.utils', () => ({
  useTrackEvent: () => ({
    trackAction: (payload: TrackedAction) => {
      mocks.tracked.push(payload);
      return Promise.resolve();
    },
  }),
}));

// Spread the REAL module and override only `trpc` (local-rules/no-wholesale-module-mock):
// a hand-written replacement silently breaks every importer the day '~/utils/trpc' grows an
// export this factory omits — the whole FILE then fails to load with 0 tests collected and
// no failing assertion.
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: {
    blocks: {
      getNavSummary: {
        useQuery: (_input: unknown, opts?: { enabled?: boolean }) => {
          mocks.lastEnabled = opts?.enabled;
          // A query that never ran never becomes `isFetched`. See the header.
          if (opts?.enabled === false) return { data: undefined, isFetched: false };
          return { data: mocks.navSummary, isFetched: mocks.isFetched };
        },
      },
      withdrawPublishRequest: {
        useMutation: () => ({ mutate: () => undefined, isPending: false }),
      },
    },
    // `MyAppsBody` — mounted by the workbench state. Held in its loading branch; this
    // suite is about WHICH screen renders, not about the table's contents.
    appListings: {
      listMine: { useQuery: () => ({ data: undefined, isLoading: true, error: null }) },
      listMyOrphanedSubmissions: {
        useQuery: () => ({ data: undefined, isLoading: true, error: null }),
      },
    },
    useUtils: () => ({
      appListings: {
        listMine: { invalidate: () => undefined },
        listMyOrphanedSubmissions: { invalidate: () => undefined },
      },
    }),
  },
}));

const { AppsBuildBody } = await import('./AppsBuildBody');

const SKELETON = 'apps-build-skeleton';
const FIRST_APP = 'apps-build-first-app';
const PITCH = 'apps-build-pitch';
const WORKBENCH_CTA = 'apps-build-new-app';

/**
 * 🔴 RENDER BARRIER — required before every "renders nothing" assertion. `render()` commits
 * through a React 18 concurrent root on a LATER task, so a synchronous absence assertion
 * right after `renderWithProviders` reads an EMPTY container and passes whatever the
 * component does. Render the sentinel alongside and await it first. (Same reasoning, and
 * the same mutation-found hole, as `AppsSubNav.hydration.browser.test.tsx`.)
 */
const RENDER_BARRIER = 'render-barrier';
const RenderBarrier = () => <div data-testid={RENDER_BARRIER} />;

async function renderBody(node = <AppsBuildBody />) {
  renderWithProviders(
    <>
      <RenderBarrier />
      {node}
    </>
  );
  await expect.element(page.getByTestId(RENDER_BARRIER)).toBeInTheDocument();
}

const seen = (testId: string) => page.getByTestId(testId).elements().length;

beforeEach(() => {
  mocks.isClient = true;
  mocks.isFetched = false;
  mocks.navSummary = undefined;
  mocks.flags = { appBlocks: true, appBlocksAuthor: true };
  mocks.user = { id: 7, username: 'author', isModerator: false };
  mocks.tracked = [];
  mocks.lastEnabled = undefined;
});

describe('AppsBuildBody — the unsettled window renders a skeleton, never state B', () => {
  test('🔴 author, summary NOT yet fetched → skeleton, and NO "first app" content', async () => {
    // The exact production shape: an author whose `getNavSummary` has not landed. On `main`
    // this rendered state B; this is the assertion that is RED at the base commit.
    await renderBody();

    await expect.element(page.getByTestId(SKELETON)).toBeInTheDocument();
    expect(seen(FIRST_APP), 'state-B content rendered during the unsettled window').toBe(0);
    // Belt and braces on the COPY as well as the testid: a refactor that moved the
    // `data-testid` off that block would otherwise silently defeat the line above.
    expect(page.getByText('Ship your first app').elements()).toHaveLength(0);
    expect(seen(WORKBENCH_CTA)).toBe(0);
  });

  test('the SERVER render (isClient=false) is the skeleton too, so first paint matches it', async () => {
    // `useIsClient()` is false on the server AND on the first client paint. Both must
    // produce the same output or hydration bails — the #418/#425 incident this page's
    // deferral exists to avoid. Asserting the pre-mount render pins that the fix did not
    // introduce a server/client split of its own.
    mocks.isClient = false;
    mocks.isFetched = true; // even with the query "landed", pre-mount must not use it
    mocks.navSummary = { ...SUMMARY_WITH_APPS };
    await renderBody();

    await expect.element(page.getByTestId(SKELETON)).toBeInTheDocument();
    expect(seen(FIRST_APP)).toBe(0);
    expect(seen(WORKBENCH_CTA)).toBe(0);
  });

  test('settled WITH apps → the workbench, and no skeleton left behind', async () => {
    mocks.isFetched = true;
    mocks.navSummary = { ...SUMMARY_WITH_APPS };
    await renderBody();

    await expect.element(page.getByTestId(WORKBENCH_CTA)).toBeInTheDocument();
    expect(seen(SKELETON)).toBe(0);
    expect(seen(FIRST_APP)).toBe(0);
  });

  test('settled with NOTHING → state B really does render (the skeleton is not a permanent stand-in)', async () => {
    // The positive control for every `seen(FIRST_APP)).toBe(0)` above: the same reader DOES
    // observe state B when it is the settled answer. Without this the absences could be
    // satisfied by a component that renders state B never, or by a query wired to nothing.
    mocks.isFetched = true;
    mocks.navSummary = { ...EMPTY_SUMMARY };
    await renderBody();

    await expect.element(page.getByTestId(FIRST_APP)).toBeInTheDocument();
    await expect.element(page.getByText('Ship your first app')).toBeInTheDocument();
    expect(seen(SKELETON)).toBe(0);
  });

  test('settled by an ERROR (isFetched true, data undefined) → state B, not a stuck skeleton', async () => {
    // `isFetched`, not `data !== undefined`, is the wait's key — deliberately, so an author
    // whose summary call FAILS still settles. Keyed on the data they would sit under the
    // skeleton forever, and they are the cohort most worth not stranding.
    mocks.isFetched = true;
    mocks.navSummary = undefined;
    await renderBody();

    await expect.element(page.getByTestId(FIRST_APP)).toBeInTheDocument();
    expect(seen(SKELETON)).toBe(0);
  });
});

describe('AppsBuildBody — states that must NOT gain a loading frame', () => {
  test('a NON-author gets the pitch immediately, with no skeleton, even pre-mount', async () => {
    // State A is the only PUBLIC-facing and deliberately-indexable state. Putting a loading
    // frame in front of it would put a skeleton in the SSR HTML a crawler reads.
    mocks.flags = { appBlocks: true, appBlocksAuthor: false };
    mocks.isClient = false;
    mocks.isFetched = false;
    await renderBody();

    await expect.element(page.getByTestId(PITCH)).toBeInTheDocument();
    expect(seen(SKELETON)).toBe(0);
  });

  test('logged out → the pitch, no skeleton', async () => {
    mocks.user = null;
    await renderBody();

    await expect.element(page.getByTestId(PITCH)).toBeInTheDocument();
    expect(seen(SKELETON)).toBe(0);
  });

  /**
   * 🔴 THE PERMANENT-SKELETON HAZARD, PINNED. The PAGE gate is `hasAppsStoreAccess`
   * (`appListings || appBlocks || appListingsPublicExternal`) while the summary query's
   * `enabled` requires `appBlocks` — so an author holding `appListings` alone reaches this
   * page with the query switched OFF. `isFetched` is then false forever, and a wait keyed on
   * `isAuthor && !(isClient && isFetched)` would render the skeleton until they navigated
   * away. The fix keys the wait on `enabled` instead; the all-false summary is that viewer's
   * correct and final answer, so they settle on the first paint.
   */
  test('🔴 author whose summary query is DISABLED settles immediately — no permanent skeleton', async () => {
    mocks.flags = { appBlocks: false, appListings: true, appBlocksAuthor: true };
    mocks.isFetched = false;
    mocks.navSummary = undefined;
    await renderBody();

    // The wiring this case depends on, asserted rather than assumed: if the component ever
    // stopped disabling the query for this viewer, the test below would be about a different
    // situation than the one its name claims.
    expect(mocks.lastEnabled, 'the summary query should be disabled for this viewer').toBe(false);
    await expect.element(page.getByTestId(FIRST_APP)).toBeInTheDocument();
    expect(seen(SKELETON)).toBe(0);
  });
});

/**
 * The `view` analytics event, which #530 fenced explicitly: it must still fire exactly once
 * per mount and only when settled. These drive the REAL `useEffect` + `viewed` ref — the
 * thing F6 recorded as untested — through a real mount→settle transition.
 */
describe('AppsBuildBody — the view event is unchanged by the skeleton', () => {
  /** Flips the query to "landed with apps" AFTER mount, i.e. a real settle. */
  function SettleAfterMount() {
    const [, force] = useReducer((n: number) => n + 1, 0);
    useEffect(() => {
      mocks.isFetched = true;
      mocks.navSummary = { ...SUMMARY_WITH_APPS };
      force();
    }, []);
    return <AppsBuildBody />;
  }

  test('no view is posted while the skeleton is up', async () => {
    await renderBody();
    await expect.element(page.getByTestId(SKELETON)).toBeInTheDocument();
    expect(mocks.tracked).toEqual([]);
  });

  /**
   * Watches `document.body` for a state-B block ever being ADDED, so a block that appeared
   * for a single commit and was replaced is still caught — an assertion taken after the
   * transition cannot see it.
   *
   * 🔴 IT WATCHES `attributes`, NOT JUST `childList`, AND WITHOUT THAT IT MEASURES NOTHING.
   * Every branch of `AppsBuildBody` returns a Mantine `Stack` — the same `<div>` at the same
   * position — so React RECONCILES IN PLACE and the state-B block is never an ADDED NODE. A
   * childList-only watcher sees the container appear empty and then a `data-testid` quietly
   * change; it reports a clean zero over a first paint that really did render state B. That
   * is not reasoning, it is the measured record from this exact fixture at the base commit:
   *   add DIV#__vitest_1__ inner-first-app=false
   *   …
   *   attr data-testid old=apps-build-first-app new=null      ← the only trace B leaves
   * So a sighting is any node that BECAME state B or STOPPED BEING it, plus the childList
   * case for completeness.
   *
   * 🔴 AND `takeRecords()` IS PROCESSED, NOT DRAINED. The first version ended with
   * `observer.takeRecords().forEach(() => undefined)`, which EMPTIES the queue and throws the
   * records away — the callback is a microtask, so anything still queued when the awaited
   * assertion resolved was discarded unread.
   *
   * Both defects were found the same way and it is the only reason either is not still here:
   * the test was run against the BASE commit and did not go red. A watcher whose zero you
   * have not watched become non-zero on known-bad code is a claim about the watcher.
   */
  function watchForStateB() {
    const sightings: string[] = [];
    const consume = (records: MutationRecord[]) => {
      for (const record of records) {
        if (record.type === 'attributes') {
          const now = (record.target as HTMLElement).getAttribute('data-testid');
          if (now === FIRST_APP) sightings.push('became state B');
          if (record.oldValue === FIRST_APP) sightings.push('stopped being state B');
          continue;
        }
        for (const node of Array.from(record.addedNodes)) {
          if (!(node instanceof HTMLElement)) continue;
          const hit = node.matches(`[data-testid="${FIRST_APP}"]`)
            ? node
            : node.querySelector(`[data-testid="${FIRST_APP}"]`);
          if (hit) sightings.push(`added: ${hit.textContent?.slice(0, 40) ?? ''}`);
        }
      }
    };
    const observer = new MutationObserver(consume);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ['data-testid'],
    });
    return {
      sightings,
      /** Flush anything the microtask callback has not delivered yet, then stop. */
      stop: () => {
        consume(observer.takeRecords());
        observer.disconnect();
      },
    };
  }

  test('🔴 mount → settle posts exactly ONE view, for the SETTLED state, and state B is never painted', async () => {
    const watcher = watchForStateB();
    try {
      await renderBody(<SettleAfterMount />);
      await expect.element(page.getByTestId(WORKBENCH_CTA)).toBeInTheDocument();
    } finally {
      watcher.stop();
    }

    expect(watcher.sightings, 'state B was painted during the mount→settle transition').toEqual([]);
    expect(mocks.tracked).toEqual([
      { type: 'AppsBuild_Action', details: { action: 'view', state: 'workbench' } },
    ]);
  });

  /**
   * 🔴 THE CONTROL DRIVES A REAL state-B → workbench TRANSITION, NOT MERELY A PAGE THAT
   * RENDERS STATE B, AND THE DIFFERENCE IS THE POINT. The assertion above is an ABSENCE, so
   * its worth is exactly the watcher's ability to observe the trace it is denying — and that
   * trace is an ATTRIBUTE change on an in-place-reconciled `<div>`. A control that only
   * mounted state B would be satisfied by the watcher's `childList` branch alone, so the
   * attribute branch could be broken, the test above could go vacuously green, and this
   * control would keep passing and vouch for it. Same watcher, same swap, opposite verdict.
   */
  test('POSITIVE CONTROL: the watcher sees a state-B → workbench swap (the trace the test above denies)', async () => {
    mocks.isFetched = true;
    mocks.navSummary = { ...EMPTY_SUMMARY };

    const watcher = watchForStateB();
    try {
      // Awaited, unlike the fire-and-forget renders elsewhere in this file: `rerender` is
      // only reachable through the resolved result, and an un-awaited render swallows a
      // mount crash into an empty container (see `renderWithProviders`).
      const { rerender } = await renderWithProviders(<AppsBuildBody />);
      await expect.element(page.getByTestId(FIRST_APP)).toBeInTheDocument();
      mocks.navSummary = { ...SUMMARY_WITH_APPS };
      await rerender(<AppsBuildBody />);
      await expect.element(page.getByTestId(WORKBENCH_CTA)).toBeInTheDocument();
    } finally {
      watcher.stop();
    }

    expect(watcher.sightings).toContain('stopped being state B');
  });

  test('a settled NON-author posts one view for `pitch`', async () => {
    mocks.flags = { appBlocks: true, appBlocksAuthor: false };
    await renderBody();

    await expect.element(page.getByTestId(PITCH)).toBeInTheDocument();
    expect(mocks.tracked).toEqual([
      { type: 'AppsBuild_Action', details: { action: 'view', state: 'pitch' } },
    ]);
  });
});
