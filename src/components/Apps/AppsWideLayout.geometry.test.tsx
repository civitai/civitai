/**
 * `/apps/*` SPENDS ITS WIDTH — the rendered proof, at two named container widths.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS BEING GUARDED
 * ─────────────────────────────────────────────────────────────────────────────
 * The ultrawide pass raised the shared apps container 1920 → 2560, so a route with no
 * body measure went from 1888 to 2528 of content. Nothing was clipped and nothing
 * errored — the extra 640px simply became PADDING, which on a `space-between` row lands
 * entirely between a row's content and the control that acts on it.
 *
 * Two mechanisms answer that:
 *
 *   · `AppsTableColgroup` — percentage widths on every column except the primary, which
 *     is left `auto` so the surplus lands there.
 *   · `AppsCardGrid` — `/apps/installed`'s cards step to a second column exactly where the
 *     surplus appeared, so a card's own width stops tracking the container and the
 *     name→Manage gap stops growing.
 *
 * 🔴 THE SPLIT WITH THE UNIT TIER IS NOT WHAT THIS PARAGRAPH ORIGINALLY SAID. It claimed a
 * misplaced `<colgroup>` is "ignored SILENTLY" and that `__tests__/appsWideLayout.test.ts`
 * "cannot see any of that". Both halves were refuted by mutation, in opposite directions:
 *
 *   - a `<colgroup>` moved AFTER `<Table.Tbody>` changed **no rendered width at all** (every
 *     assertion in this file stayed green), because React inserts nodes through the DOM API
 *     so the HTML parser's table foster-parenting never runs and Chromium honours the
 *     columns wherever the element sits — while the unit file's structural guard went red;
 *   - a `<colgroup>` DELETED entirely does turn these assertions red, which is the positive
 *     control proving that green was about placement rather than about this tier being
 *     blind.
 *
 * So: PLACEMENT and ledger↔table COLUMN COUNT are owned by `__tests__/appsWideLayout.test.ts`
 * (AST, per-table, in the blocking tier). WIDTHS are owned here. Neither is a substitute
 * for the other, and the sentence that said one of them saw everything was wrong.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 WHY THE `geometry` PROJECT AND NOT `component`
 * ─────────────────────────────────────────────────────────────────────────────
 * Every number here depends on the Mantine `Container`'s `max-width`/`padding-inline`,
 * on `Table`'s `width: 100%` and its cell padding, and on the CASCADE LAYER ORDER that
 * decides which of Tailwind's preflight, this repo's `globals.css` and Mantine's own
 * sheets wins. `test/component-setup.tsx` injects the `:root` custom properties ONLY —
 * 24 CSS rules, no preflight, no Mantine component rules — so in that tier a `<table>` is
 * unstyled, every column is content-width, and the container has no cap at all. The
 * measurements would be internally consistent and about a different page.
 *
 * The harness asserts the cascade actually arrived (`cascadeEvidence()`), so a stylesheet
 * that fails to load fails the run rather than quietly reproducing the defect's numbers.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE TWO WIDTHS ARE NAMED, AND NEITHER SITS ON A THRESHOLD
 * ─────────────────────────────────────────────────────────────────────────────
 * 1440 — the ordinary desktop, BELOW the old 1920 container, so it is the "nothing may
 *        move here" reference. Content: 1440 − 32 = 1408.
 * 2560 — exactly the container's cap, the widest full-bleed case. Content: 2528.
 *
 * The card grid's second column arrives at 2416 of content — 1008 above the first fixture
 * and 112 below the second, so neither measurement is on the rung. One measurement is not
 * a general claim, which is why every assertion below is a comparison BETWEEN the two.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ WHAT THIS FILE DOES NOT PROVE, STATED SO NOBODY READS IT AS PROVEN
 * ─────────────────────────────────────────────────────────────────────────────
 * The `/apps/installed` block below mounts the real `InstalledAppCard` inside
 * `AppsCardGrid` — but the GRID IS SUPPLIED BY THE TEST, so these assertions say "the card
 * behaves correctly when it is in the grid", not "the page puts it in one". Measured
 * against `origin/main`'s components with only the new module scaffolded in, the two
 * installed tests PASSED while the four table tests went red — i.e. this file alone cannot
 * see the page reverting to a `Stack`. That claim is `__tests__/appsWideLayout.test.ts`'s
 * "🔴 /apps/installed uses the card GRID, and no longer caps its body", which is red at
 * `origin/main` for exactly that reason. Two guards, one for the mechanism and one for its
 * adoption; neither is a substitute for the other.
 */
import { describe, expect, test, vi } from 'vitest';
import { cleanup } from 'vitest-browser-react';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { cascadeEvidence, nextLayout, renderAtViewport } from '../../../test/geometry-setup';
import type * as TrpcMod from '~/utils/trpc';
import type { GroupedApp } from '~/components/Apps/groupSubscriptionsByApp';
import type { SubscriptionRecord } from '~/server/schema/blocks/subscription.schema';
import type { MyAppRow } from '~/components/Apps/myAppsView';
import type { OffsiteReviewRequest, OnsiteReviewRequest } from '~/components/Apps/unifiedReviewRow';
import { capabilitiesForKind } from '~/shared/constants/app-capabilities.constants';

// The sub-nav needs a qualifying viewer or it renders no `<nav>` at all — same fixture
// as `AppsPageLayout.chromeAlignment.browser.test.tsx`, for the same reason.
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ appBlocks: true, appBlocksAuthor: true }),
  useOptionalFeatureFlags: () => ({ appBlocks: true, appBlocksAuthor: true }),
  useFeatureFlagsReady: () => true,
  FeatureFlagsProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock('~/providers/IsClientProvider', () => ({ useIsClient: () => true }));
vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: 1, username: 'author', isModerator: false }),
}));
// Spread the REAL module and override only `trpc` — the sub-nav's summary query is the
// only network this file's tree reaches.
// 🔴 A PROXY, NOT A HAND-ENUMERATED TREE. Four real components now render in this
// file and between them they touch a dozen procedures; a literal mock object fails
// with `Cannot read properties of undefined (reading 'useMutation')` for every one
// nobody remembered, which is a fixture problem masquerading as a component problem.
// The proxy answers ANY path with an inert hook, and `DATA` overrides only the reads
// whose CONTENT this file measures. Spread the real module and override `trpc` alone
// (local-rules/no-wholesale-module-mock).
vi.mock('~/utils/trpc', async (importOriginal) => {
  const inertQuery = {
    data: undefined,
    error: null,
    isLoading: false,
    isFetching: false,
    isPending: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
    refetch: vi.fn(),
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    invalidate: vi.fn(),
  };
  const hooks = {
    useQuery: () => inertQuery,
    useInfiniteQuery: () => inertQuery,
    useMutation: () => inertQuery,
    invalidate: vi.fn(),
    fetch: vi.fn(),
  };
  const node = (data?: unknown): unknown =>
    new Proxy(
      {},
      {
        get(_t, key: string) {
          if (key === 'useQuery' || key === 'useInfiniteQuery') {
            return () => (data === undefined ? inertQuery : { ...inertQuery, data });
          }
          if (key in hooks) return (hooks as Record<string, unknown>)[key];
          if (key === 'then') return undefined; // never look thenable to await
          return node();
        },
      }
    );
  /** The reads whose CONTENT this file measures — everything else is inert. */
  const DATA: Record<string, unknown> = {
    // `ActivePreviewsPanel`: one LIVE preview, so both of its controls render — the
    // shape the +563.87px column delta was measured on.
    'blocks.listActivePreviews': {
      cap: 3,
      active: [
        {
          publishRequestId: 'pr_1',
          slug: 'lighthouse',
          version: '1.0.0',
          state: 'preview-live',
          updatedAt: new Date().toISOString(),
        },
      ],
    },
    // `AppActivityPanel`: one RICH scope row. The disputed column decision is only
    // observable on that shape — `describeBlockAction` puts a SENTENCE in Action while
    // `humaniseScopeEndpoint` puts a raw technical ref in Detail.
    'blocks.listMyScopeInvocations': {
      pages: [
        {
          items: [
            {
              id: 'sc_1',
              createdAt: new Date('2026-09-01T00:00:00Z'),
              appBlockId: 'ab_9',
              appName: 'Lighthouse',
              appSlug: 'lighthouse',
              scope: 'buzz:tip',
              endpoint: 'POST /api/v1/buzz/tip',
              statusCode: 200,
              detail: { action: 'tip', toUserId: 4242, amount: 500 },
            },
          ],
          nextCursor: null,
        },
      ],
    },
    'blocks.listMyAppActivity': { pages: [{ items: [], nextCursor: null }] },
    // `OffsiteReportsQueue`: a LONG app name AND a LONG `details`, so the two candidate
    // primary columns can be told apart by what each cell does with the room.
    'appListings.listListingReports': {
      items: [
        {
          id: 'rep_1',
          status: 'pending',
          reason: 'TOSViolation',
          details:
            'The listing screenshots show a different application than the one actually ' +
            'served at the external URL, and the description claims a Civitai partnership ' +
            'that does not exist.',
          createdAt: new Date('2026-09-01T00:00:00Z'),
          reporter: { id: 11, username: 'reporter-one' },
          appListing: {
            id: 'apl_1',
            slug: 'lighthouse',
            name: 'Lighthouse — Model Diagnostics And Comparison Workbench',
            status: 'approved',
          },
        },
      ],
      nextCursor: null,
    },
  };
  const root: unknown = new Proxy(
    {},
    {
      get(_t, router: string) {
        if (router === 'useUtils') return () => node();
        if (router === 'useQueries') return () => [];
        if (router === 'then') return undefined;
        return new Proxy(
          {},
          {
            get(_t2, proc: string) {
              if (proc === 'then') return undefined;
              return node(DATA[`${router}.${proc}`]);
            },
          }
        );
      },
    }
  );
  return { ...(await importOriginal<typeof TrpcMod>()), trpc: root };
});
// `/apps/installed`'s module calls `createServerSideProps` at import time, which pulls the
// server graph into a browser bundle. Stubbed so the page's `InstalledAppCard` — the REAL
// card whose gap this file measures — can be imported without it.
vi.mock('~/server/utils/server-side-helpers', () => ({
  createServerSideProps: () => async () => ({ props: {} }),
}));

const { AppsPageLayout } = await import('~/components/Apps/AppsPageLayout');
const { AppsCardGrid } = await import('~/components/Apps/appsWideLayout');
const { UnifiedReviewList } = await import('~/components/Apps/UnifiedReviewList');
const { MyAppsBodyView } = await import('~/components/Apps/MyAppsBody');
const { InstalledAppCard } = await import('~/pages/apps/installed');
const { ActivePreviewsPanel } = await import('~/components/Apps/ActivePreviewsPanel');
const { OffsiteReportsQueue } = await import('~/components/Apps/OffsiteReviewQueue');
const { AppActivityPanel } = await import('~/components/Apps/AppActivityPanel');

/** The container's own content width at each fixture viewport, as literals. */
const NARROW = { width: 1440, height: 900, content: 1408 } as const;
const WIDE = { width: 2560, height: 1440, content: 2528 } as const;
const CONTAINER_DELTA = WIDE.content - NARROW.content; // 1120

/**
 * 🔴 THE WIDTHS BELOW 1440, AND THE DIMENSION THAT GOES WITH THEM.
 *
 * Every arm in this file used to read a WIDTH at 1440/2560 only, and that is precisely why
 * two bad ledgers shipped through a green suite: a column squeezed below its content does
 * not get NARROWER than the assertion expects, it gets TALLER. Measured on
 * `AppActivityPanel`, row height against a natural 36.19:
 *
 *                                    768      1200     1440     2560
 *   [7, 8, 10, null, 6]   round 2   48.09    48.09    48.09    36.19
 *   [3, 4, 20, 13, null]  round 3   64.89    64.89    64.89    48.09
 *
 * Both are invisible to a width assertion at 1440/2560, and round 3's is 79% taller than
 * `main` on an ordinary laptop. So the tier now measures HEIGHT as well as width, at two
 * widths BELOW 1440 as well as the two above — 768 and 1200 are where a squeeze bites,
 * because that is where a percentage share is smallest in absolute px.
 */
const TABLET = { width: 768, height: 900, content: 736 } as const;
const LAPTOP = { width: 1200, height: 900, content: 1168 } as const;

/** The four widths every table-shaped arm should be read at, narrow-first. */
const ALL_WIDTHS = [TABLET, LAPTOP, NARROW, WIDE] as const;

const px = (n: number) => Math.round(n * 100) / 100;

// ── fixtures ─────────────────────────────────────────────────────────────────

const ONSITE: OnsiteReviewRequest = {
  id: 'or1',
  appBlockId: null,
  slug: 'lighthouse',
  version: '1.0.0',
  submittedAt: '2026-01-01T00:00:00Z',
  bundleSizeBytes: '10',
  bundleSha256: 'sha',
  manifest: { name: 'Lighthouse' },
  fileSummary: {},
  manifestDiffSummary: {},
  reviewRepoUrl: 'https://forgejo.example/repo',
  submittedBy: { id: 7, username: 'onsite-dev', image: null },
} as OnsiteReviewRequest;

const OFFSITE: OffsiteReviewRequest = {
  id: 'fr1',
  appListingId: 'apl_1',
  slug: 'wayfarer',
  status: 'pending',
  submittedAt: '2026-02-01T00:00:00Z',
  changelog: null,
  appListing: {
    name: 'Wayfarer',
    externalUrl: 'https://ex.com',
    category: 'utility',
    contentRating: 'g',
  },
  submittedBy: { id: 9, username: 'offsite-dev', image: null },
};

const MINE_ROW: MyAppRow = {
  appListingId: 'apl_9',
  slug: 'lighthouse',
  name: 'Lighthouse',
  status: 'approved',
  kind: 'onsite',
  appBlockId: 'ab_9',
  role: 'owner',
  capabilities: capabilitiesForKind('onsite'),
  iconUrl: null,
  coverUrl: null,
  updatedAt: '2026-08-01T00:00:00Z',
  lastModerationAction: null,
} as MyAppRow;

/**
 * A grouped install with NO pinned rows.
 *
 * 🔴 `pinned: []` IS LOAD-BEARING, not incidental. `PinnedInstallRow` calls
 * `trpc.blocks.uninstallFromModel.useMutation()` unconditionally, and the `trpc` stub above
 * carries only the sub-nav's query — so a fixture with a pinned install would crash at
 * mount rather than measure anything. The row this file is about is the CARD HEADER
 * (`installed.tsx`'s `Group justify="space-between"`), which renders either way.
 */
const BLANKET_VIEWER: SubscriptionRecord = {
  id: 'sub_1',
  scope: 'viewer_all_pages' as SubscriptionRecord['scope'],
  appBlockId: 'ab_9',
  blockId: 'lighthouse',
  appId: 'app_9',
  targetModelTypes: null,
  targetBaseModels: null,
  targetModelIds: null,
  pinnedModelNames: null,
  slotId: null,
  pinnedVersion: null,
  blockInstanceId: null,
  currentVersion: '1.0.0',
  availableVersions: [],
  settings: {},
  enabled: true,
  createdAt: new Date('2026-08-01T00:00:00Z'),
  updatedAt: new Date('2026-08-01T00:00:00Z'),
  manifest: { name: 'Lighthouse' },
};

const INSTALLED_APP: GroupedApp = {
  appBlockId: 'ab_9',
  blockId: 'lighthouse',
  appId: 'app_9',
  manifest: { name: 'Lighthouse' },
  pinned: [],
  // 🔴 A BLANKET SUB IS REQUIRED FOR THE ROW TO HAVE A CONTROL AT ALL. The card renders
  // Manage only when it has a seed (`blanketPublisher ?? blanketViewer ?? pinned[0]`), so
  // an all-empty fixture renders a name with no button — and the gap this file measures
  // would not exist. That is exactly how a geometry test comes back green having measured
  // nothing, so the narrow reading is asserted non-zero below rather than assumed.
  blanketViewer: BLANKET_VIEWER,
  blanketPublisher: undefined,
};

// ── measurement helpers ──────────────────────────────────────────────────────

/** Render `ui` as the BODY of the real, measure-free apps layout at `viewport`. */
async function renderRoute(ui: React.ReactElement, viewport: { width: number; height: number }) {
  const { observed } = await renderAtViewport(
    <AppsPageLayout title="Fixture">{ui}</AppsPageLayout>,
    viewport
  );
  return observed;
}

/** Every header cell's width, in document order, for the first table on the page. */
function headerWidths(): number[] {
  const cells = Array.from(document.querySelectorAll('table thead th'));
  return cells.map((c) => px(c.getBoundingClientRect().width));
}

/** The first body row's border-box HEIGHT — the dimension a width assertion cannot see. */
function firstRowHeight(): number {
  const row = document.querySelector('table tbody tr');
  if (!row) throw new Error('no table body row to measure');
  return px(row.getBoundingClientRect().height);
}

/**
 * How many LINE BOXES an element's text occupies.
 *
 * `range.getClientRects()` returns one rect per line box, so this counts wrapping directly
 * rather than inferring it from a height and a line-height. Returns `-1` for a missing
 * element so a caller asserting a number gets a loud wrong answer rather than a throw
 * inside a `map`.
 */
function lineCount(el: Element | null | undefined): number {
  if (!el) return -1;
  const range = document.createRange();
  range.selectNodeContents(el);
  return range.getClientRects().length;
}

/** Render `ui` in the real layout at each of `viewports`, applying `read` at each. */
async function atEachWidth<T>(
  ui: () => React.ReactElement,
  read: () => T,
  viewports: readonly { width: number; height: number }[] = ALL_WIDTHS
): Promise<T[]> {
  const out: T[] = [];
  for (const vp of viewports) {
    const observed = await renderRoute(ui(), vp);
    expect(observed).toEqual({ width: vp.width, height: vp.height });
    out.push(read());
    await cleanup();
  }
  return out;
}

function widthOf(testId: string): number {
  const el = document.querySelector(`[data-testid="${testId}"]`);
  if (!el) throw new Error(`nothing rendered for [data-testid="${testId}"]`);
  return px(el.getBoundingClientRect().width);
}

/**
 * Measure the same page at BOTH fixture widths and hand back the pair.
 *
 * The teardown between the two renders is explicit: `afterEach` has not run yet, and two
 * trees in the document would make every `querySelector` above read the first one.
 */
async function atBothWidths<T>(
  ui: () => React.ReactElement,
  measure: () => T
): Promise<{ narrow: T; wide: T }> {
  const observedNarrow = await renderRoute(ui(), NARROW);
  expect(observedNarrow).toEqual({ width: NARROW.width, height: NARROW.height });
  const narrow = measure();
  await cleanup();
  const observedWide = await renderRoute(ui(), WIDE);
  expect(observedWide).toEqual({ width: WIDE.width, height: WIDE.height });
  const wide = measure();
  await cleanup();
  return { narrow, wide };
}

// ── the cascade is real ──────────────────────────────────────────────────────

describe('the harness is measuring the real cascade', () => {
  test('the app stylesheets are loaded and applied', async () => {
    // POSITIVE CONTROL. Every assertion below is a comparison of two rendered widths, and
    // an unstyled document produces two internally-consistent numbers just as happily.
    await renderRoute(<div data-testid="probe" />, WIDE);
    const evidence = cascadeEvidence();
    expect(evidence.ruleCount).toBeGreaterThan(2000);
    expect(evidence.probeBoxSizing).toBe('border-box');
    expect(evidence.tailwindFlexUtilityResolves).toBe(true);
    expect(evidence.layerOrder.declaredBeforeAnyLayerBlock).toBe(true);
  });

  test('the measure-free container really is 1408 / 2528 of content', async () => {
    // The literals this whole file is arithmetic against, measured rather than assumed —
    // if the container's cap or padding moves, every delta below changes meaning.
    const { narrow, wide } = await atBothWidths(
      () => <div data-testid="probe" />,
      () => widthOf('probe')
    );
    expect(narrow).toBe(NARROW.content);
    expect(wide).toBe(WIDE.content);
    expect(wide - narrow).toBe(CONTAINER_DELTA);
  });
});

// ── table route 1: /apps/review ──────────────────────────────────────────────

describe('/apps/review — the queue table spends the width on its App column', () => {
  const list = () => (
    <UnifiedReviewList
      onsiteItems={[ONSITE]}
      offsiteItems={[OFFSITE]}
      direction="asc"
      openOnsiteReview={vi.fn()}
      openOffsiteReview={vi.fn()}
      isLoading={false}
      emptyLabel="empty"
      dateLabel="Submitted"
      actionLabel="Review"
      hasMore={false}
      onLoadMore={vi.fn()}
    />
  );

  test('the App column grows with the container, and takes MOST of the surplus', async () => {
    // 🔴 THE CLAIM IS A SHARE, NOT MERELY "IT GREW". Without a `<colgroup>` every column
    // grows — automatic table layout distributes surplus across all of them in proportion
    // to their content — so "the App column got wider" is satisfied by the DEFECT. What
    // separates the two is HOW MUCH of the 1120px it took: the ledger gives it 54% of the
    // table, i.e. more than the other four columns put together.
    const { narrow, wide } = await atBothWidths(list, headerWidths);
    expect(narrow, 'the queue renders five columns on the Pending tab').toHaveLength(5);
    expect(wide).toHaveLength(5);

    const appDelta = wide[1] - narrow[1];
    const otherDelta = wide.reduce((s, w, i) => (i === 1 ? s : s + (w - narrow[i])), 0);

    expect(appDelta, 'the App column did not grow at all').toBeGreaterThan(0);
    expect(
      appDelta,
      `the App column took ${px(appDelta)} of the container's ${CONTAINER_DELTA}px, and the ` +
        `other four columns took ${px(otherDelta)} between them — the primary column is ` +
        'supposed to absorb the slack'
    ).toBeGreaterThan(otherDelta);
    // …and the two together account for the whole container delta, so nothing has been
    // silently spent as table margin.
    expect(px(appDelta + otherDelta)).toBeCloseTo(CONTAINER_DELTA, 0);
  });

  test('the non-primary columns hold their declared share at the wide width', async () => {
    // The other half of "proportional": the fixed columns are a PERCENTAGE of the table,
    // not a content width that happens to have grown. Asserted at the wide fixture only,
    // because at 1408 a column can legitimately exceed its share (min-content wins).
    await renderRoute(list(), WIDE);
    const widths = headerWidths();
    const table = document.querySelector('table')!.getBoundingClientRect().width;
    for (const [index, share] of [
      [0, 6],
      [2, 6],
      [3, 9],
      [4, 6],
    ] as const) {
      expect(px(widths[index]), `column ${index} should be ${share}% of ${px(table)}`).toBeCloseTo(
        (share / 100) * table,
        0
      );
    }
    await cleanup();
  });
});

// ── table route 2: /apps/mine ────────────────────────────────────────────────

describe('/apps/mine — the author table spends the width on its App column', () => {
  const body = () => <MyAppsBodyView rows={[MINE_ROW]} />;

  test('the App column grows with the container, and takes MOST of the surplus', async () => {
    const { narrow, wide } = await atBothWidths(body, headerWidths);
    expect(narrow, 'the author table renders four columns').toHaveLength(4);
    expect(wide).toHaveLength(4);

    const appDelta = wide[0] - narrow[0];
    const otherDelta = wide.reduce((s, w, i) => (i === 0 ? s : s + (w - narrow[i])), 0);

    expect(appDelta).toBeGreaterThan(0);
    expect(
      appDelta,
      `the App column took ${px(appDelta)} and Cover/Status/Updated took ${px(otherDelta)}`
    ).toBeGreaterThan(otherDelta);
  });

  test('the App column is measurably the widest at BOTH widths', async () => {
    // A second, independent reading of the same decision: the primary column is the one
    // carrying the icon, the name and the slug, so it must never be out-grown by the
    // date column at either measurement point.
    const { narrow, wide } = await atBothWidths(body, headerWidths);
    expect(narrow[0]).toBe(Math.max(...narrow));
    expect(wide[0]).toBe(Math.max(...wide));
    // …and the header cell the ledger's primary is documented against is the one measured.
    await renderRoute(body(), WIDE);
    expect(widthOf('apps-mine-col-app')).toBe(px(headerWidths()[0]));
    await cleanup();
  });
});

// ── /apps/mine, the REGRESSION this ledger shipped ───────────────────────────

/**
 * 🔴 THE LEDGER ABOVE PAINTED THE `Updated` DATE ON TOP OF THE `Status` BADGES.
 *
 * Both `APPS_MINE_COLUMNS` and `MyAppsBody`'s `<AppsTableColgroup>` were introduced by
 * `2f3c556c7b` (#4619); `git show 2f3c556c7b^:src/components/Apps/MyAppsBody.tsx` has
 * neither, i.e. before that commit the browser auto-sized these columns to their content
 * and an overlap was not expressible. Measured against `origin/main` on the real page,
 * last status badge's right edge minus the date's left edge:
 *
 *      vw      1280   1366   1440   1600   1920   2560
 *      overlap  +22    +13     +6    −10    −43   −107
 *      date     2 lines everywhere except 2560
 *
 * (Positive = the badge is painted over the date. Read against the ADVISORY GLYPH — the
 * right-most thing in the cell — rather than the last badge, the overlap runs to +55 at
 * 1280 and is still +23 at 1600.)
 *
 * 🔴 WHY AUTOMATIC TABLE LAYOUT DID NOT SAVE IT, because that is the part a reader will
 * not guess. A column with a specified width is still floored at its cell's MIN-CONTENT
 * width — normally the thing that expands a column whose content does not fit. Here the
 * floor was a lie: Mantine's `Badge` sets `overflow: hidden`, so as a flex item its
 * automatic minimum size collapses, and the cell reported a min-content of 78px while a
 * `wrap="nowrap"` row of `flex-shrink: 0` badges actually painted 185.17px. 10% of the
 * 1406px table is 140.59px, the floor was "satisfied", and `<td>`'s `overflow: visible`
 * meant the 60px that did not fit was drawn over the next cell rather than clipped.
 *
 * 🔴 WHAT THIS GUARD ASSERTS, AND WHY IT IS NOT A CONSTANT PIN. A test reading
 * `expect(APPS_MINE_COLUMNS[2]).toBe(18)` is walkable by editing the constant, and says
 * nothing about the two mechanisms that have to agree (the share AND the row being
 * allowed to wrap). So the assertions are RELATIONSHIPS between painted boxes:
 * everything in the Status cell ends to the LEFT of where the date begins, the cell does
 * not overflow itself, and the date occupies one line.
 *
 * 🔴 THE WIDTHS ARE THE ONES THAT FAILED, AND BOTH ARE MEASURED. 1366 and 1440 are the
 * two most common laptop widths and were +13 and +6 at `origin/main`. Neither is the
 * file's `NARROW`/`WIDE` pair, because those two are about the SURPLUS and this defect
 * lives at the squeezed end.
 *
 * ⚠️ RED→GREEN MATRIX, MEASURED ONE HALF AT A TIME RATHER THAN ASSERTED. This block is
 * nine tests over the whole `geometry` project's 64; the counts are that project's:
 *
 *   both halves reverted (= `origin/main`)      6 failed | 58 passed
 *   ledger only, `wrap="nowrap"` restored       1 failed | 63 passed  ← the 768 arm
 *   wrap only, ledger back to [null, 5, 10, 5]  2 failed | 62 passed  ← the ONE-line arms
 *   both halves in place                        0 failed | 64 passed
 *
 * 🔴 READ THE MIDDLE TWO ROWS BEFORE ADDING TO THIS BLOCK. They say that the 1366/1440
 * overlap arms are satisfied by the SHARE alone — 18% of those tables is wider than the
 * two-badge row needs, so they cannot see the wrap being taken away. What pins the wrap
 * is the 768 arm, and what pins the share is the ONE-line pair. Each half has exactly one
 * arm that fails for its own reason; neither is redundant and neither covers the other.
 */
describe('🔴 /apps/mine — the Status badges never paint over the Updated date', () => {
  /**
   * 🔴 THE ADVISORY GLYPH IS PART OF THE FIXTURE, and leaving it out would have measured a
   * narrower cell than production ever renders. `StatusBadges` always renders
   * `ListingProblemsIndicator`, which returns `null` for an empty `problems` array — and
   * `MINE_ROW` above omits the field. Every row on the live page carries at least one
   * advisory, and the glyph is the RIGHT-MOST thing in the cell, i.e. exactly the box this
   * block is about.
   */
  const OVERLAP_ROW: MyAppRow = {
    ...MINE_ROW,
    problems: [
      { code: 'no-screenshots', label: 'Add at least one screenshot', severity: 'advisory' },
    ],
  } as MyAppRow;

  const body = () => <MyAppsBodyView rows={[OVERLAP_ROW]} />;

  /** The two laptop widths the defect was measured at. */
  const OVERLAP_WIDTHS = [
    { width: 1366, height: 900 },
    { width: 1440, height: 900 },
  ] as const;

  /** The Status `<td>` and the Updated `<td>` of the first body row. */
  function statusAndDateCells(): { status: HTMLTableCellElement; date: HTMLTableCellElement } {
    const row = document.querySelector('table tbody tr');
    if (!row) throw new Error('the author table rendered no body row');
    const cells = Array.from(row.querySelectorAll('td'));
    if (cells.length !== 4) {
      throw new Error(`expected the four-column author row, got ${cells.length} cells`);
    }
    return {
      status: cells[2] as HTMLTableCellElement,
      date: cells[3] as HTMLTableCellElement,
    };
  }

  /** Every painted leaf inside an element — the boxes a reader actually sees. */
  function paintedLeaves(root: Element): Element[] {
    return Array.from(root.querySelectorAll('*')).filter(
      (el) => el.children.length === 0 && (el.textContent ?? '').trim().length + el.clientWidth > 0
    );
  }

  test('the fixture really renders the two badges AND the advisory (guards a vacuous pass)', async () => {
    // POSITIVE CONTROL, and the one that matters most here: an empty Status cell trivially
    // satisfies "nothing in it overlaps the date". Both badges carry a testid, and the
    // advisory glyph is the third box — if any of them stops rendering, this fails BEFORE
    // the geometry assertions get a chance to pass for the wrong reason.
    await renderRoute(body(), OVERLAP_WIDTHS[1]);
    const { status } = statusAndDateCells();
    expect(
      status.querySelector(`[data-testid="apps-mine-role-${OVERLAP_ROW.appListingId}"]`)
    ).not.toBeNull();
    expect(
      status.querySelector(`[data-testid="apps-mine-status-${OVERLAP_ROW.appListingId}"]`)
    ).not.toBeNull();
    expect(
      status.querySelector('[data-testid="apps-submission-problems"]'),
      'the completeness advisory is the right-most box in the cell; without it this block ' +
        'measures a narrower cell than the page ever renders'
    ).not.toBeNull();
    await cleanup();
  });

  test.each(OVERLAP_WIDTHS)(
    'at $width the Status cell ends before the Updated date begins',
    async (viewport) => {
      const observed = await renderRoute(body(), viewport);
      expect(observed).toEqual({ width: viewport.width, height: viewport.height });

      const { status, date } = statusAndDateCells();
      const leaves = paintedLeaves(status);
      expect(leaves.length, 'the Status cell painted nothing to measure').toBeGreaterThan(0);

      const rightmost = Math.max(...leaves.map((el) => el.getBoundingClientRect().right));
      const dateText = paintedLeaves(date)[0];
      expect(dateText, 'the Updated cell painted no date').toBeTruthy();
      const dateLeft = dateText.getBoundingClientRect().left;

      expect(
        px(rightmost - dateLeft),
        `the right-most box in the Status cell reaches ${px(rightmost)} while the date ` +
          `starts at ${px(dateLeft)} — a positive number here is the badge painted ON TOP ` +
          `of the date (measured +55 at 1280 and +23 at 1600 on origin/main)`
      ).toBeLessThan(0);

      await cleanup();
    }
  );

  test.each(OVERLAP_WIDTHS)(
    'at $width the Status cell does not overflow ITSELF',
    async (viewport) => {
      // The same defect stated without reference to the neighbour, so a future layout that
      // moves the date somewhere else cannot make the overlap check vacuous while the cell
      // is still painting outside its own box.
      await renderRoute(body(), viewport);
      const { status } = statusAndDateCells();
      expect(
        status.scrollWidth,
        `the Status cell paints ${status.scrollWidth}px of content into ` +
          `${status.clientWidth}px of cell; \`<td>\` is \`overflow: visible\`, so the ` +
          'difference is drawn over whatever sits to its right'
      ).toBeLessThanOrEqual(status.clientWidth);
      await cleanup();
    }
  );

  test('🔴 …and at 768, where NO share can hold the row, it still does not overflow', async () => {
    // 🔴 THIS IS THE ARM THAT PINS THE *WRAP*, AND THE TWO ABOVE DO NOT. Measured by
    // reverting one half at a time: with the ledger alone (Status back to `wrap="nowrap"`,
    // share 18%) every assertion at 1366/1440 stays GREEN, because 18% of those tables is
    // wider than the two-badge row needs. The share cannot be the answer at every width —
    // 18% of the 736px container here is 132px against the 217px this row paints, and the
    // widest real row ("Collaborator" + "removed by a moderator" + the advisory) is ~307px
    // and fits under no percentage that is also sane at 2560.
    //
    // What makes the cell safe at ANY width is that the row may wrap: its min-content then
    // becomes its widest single badge instead of a number no layout can produce, so the
    // content reflows onto a second line rather than being painted over the neighbour. The
    // date legitimately wraps at this width too, which is why only the two overflow
    // relationships are read here — a squeezed column is allowed to get taller, it is not
    // allowed to paint outside itself.
    const viewport = { width: TABLET.width, height: TABLET.height };
    await renderRoute(body(), viewport);
    const { status, date } = statusAndDateCells();
    expect(
      status.scrollWidth,
      `at 768 the Status cell paints ${status.scrollWidth}px into ${status.clientWidth}px`
    ).toBeLessThanOrEqual(status.clientWidth);
    const rightmost = Math.max(
      ...paintedLeaves(status).map((el) => el.getBoundingClientRect().right)
    );
    expect(px(rightmost - date.getBoundingClientRect().left)).toBeLessThanOrEqual(0);
    await cleanup();
  });

  test.each(OVERLAP_WIDTHS)('at $width the Updated date stays on ONE line', async (viewport) => {
    // The second half of the same squeeze: 5% resolved to 88px at 1440 against the 96.73px
    // ("Sep 4, 2026" max-content 64.73 + 32px cell padding) one line needs, so the date
    // wrapped at every width below 2560.
    await renderRoute(body(), viewport);
    const { date } = statusAndDateCells();
    const text = paintedLeaves(date)[0];
    expect(lineCount(text), `the date "${text.textContent}" wrapped`).toBe(1);
    await cleanup();
  });

  test('…and the App column still takes MOST of the surplus (the #4619 behaviour is intact)', async () => {
    // 🔴 THE FIX MUST NOT BE A REVERT. Widening two fixed columns takes the surplus from
    // the primary one, and past some share the table stops "spending the width" and goes
    // back to padding it — which is the defect #4619 exists to remove. Same shape as that
    // PR's own assertion, re-read here so this block owns the trade it made.
    const { narrow, wide } = await atBothWidths(body, headerWidths);
    const appDelta = wide[0] - narrow[0];
    const otherDelta = wide.reduce((s, w, i) => (i === 0 ? s : s + (w - narrow[i])), 0);
    expect(
      appDelta,
      `the App column took ${px(appDelta)} of the container's ${CONTAINER_DELTA}px and the ` +
        `other three took ${px(otherDelta)}`
    ).toBeGreaterThan(otherDelta);
    // …and the table still SPANS the container at both widths rather than capping itself.
    for (const vp of [NARROW, WIDE]) {
      await renderRoute(body(), vp);
      const table = document.querySelector('table')!.getBoundingClientRect().width;
      expect(px(table), `the table did not span the ${vp.width} container`).toBeGreaterThan(
        vp.content - 4
      );
      await cleanup();
    }
  });
});

// ── table route 3: /apps/review's ACTIVE PREVIEWS — the payload of round 1 ───

describe('/apps/review — the active-previews panel keeps its buttons near its rows', () => {
  /**
   * 🔴 THE TABLE THE FIRST PASS EXPOSED. `/apps/review` renders four tables and the change
   * that removed its 1368 body cap ledgered two of them. Measured on this one WITHOUT a
   * ledger, 1440 → 2560:
   *
   *   columns  228.02 | 165.17 | 146.45 | 152.05 | 682.31
   *            413.89 | 299.83 | 265.84 | 276.00 | 1238.44
   *   slug → "Tear down"  817.36 → 1381.23   (+563.87)
   *
   * i.e. removing the cap re-opened, on this table, exactly the defect the cap had been
   * suppressing. The ledger makes the ACTION column primary (case (b)), so the four short
   * data columns stay at their own widths and the surplus lands past the buttons.
   */
  function slugToTeardownGap(): number {
    const slug = document.querySelector('table tbody code');
    const buttons = Array.from(document.querySelectorAll('table tbody button'));
    const teardown = buttons.find((b) => (b.textContent ?? '').includes('Tear down'));
    if (!slug || !teardown) {
      throw new Error(
        `the previews panel did not render its row (slug=${!!slug} teardown=${!!teardown})`
      );
    }
    // The glyphs' own box, not the cell's — a cell already spans its column at every width.
    const range = document.createRange();
    range.selectNodeContents(slug);
    return px(teardown.getBoundingClientRect().left - range.getBoundingClientRect().right);
  }

  const panel = () => <ActivePreviewsPanel />;

  test('the panel renders its row at all (guards a vacuous measurement)', async () => {
    // Every assertion below is a comparison of two numbers read off this row. If the trpc
    // fixture stopped resolving, the panel returns `null` and the helpers throw — but the
    // COUNT is what proves the fixture shape is still the two-button LIVE one.
    await renderRoute(panel(), WIDE);
    expect(document.querySelectorAll('table tbody tr')).toHaveLength(1);
    // ONE `<button>` (Tear down) plus ONE `<a>` — Mantine's `component="a"` Button
    // renders an anchor, so a `button` count of 2 would be wrong, not stricter.
    expect(document.querySelectorAll('table tbody button')).toHaveLength(1);
    expect(document.querySelectorAll('table tbody a')).toHaveLength(1);
    expect(headerWidths()).toHaveLength(5);
    await cleanup();
  });

  test('🔴 the slug → "Tear down" gap does NOT grow with the container', async () => {
    const { narrow, wide } = await atBothWidths(panel, slugToTeardownGap);
    expect(narrow, 'the narrow fixture measured no gap at all').toBeGreaterThan(0);
    expect(
      wide,
      `the slug→"Tear down" gap went ${narrow} → ${wide} across a ${CONTAINER_DELTA}px ` +
        'container increase; the measured no-ledger baseline for this table was ' +
        '817.36 → 1381.23, which is what removing the 1368 cap re-opened'
    ).toBeLessThanOrEqual(narrow + 1);
  });

  test('…because the ACTION column is the one that grows here', async () => {
    // The mechanism, separately from its consequence — and the direct contrast with the
    // other two table blocks, where the FIRST columns grow instead. Same module, opposite
    // primary, because this table has no column that can use the room.
    const { narrow, wide } = await atBothWidths(panel, headerWidths);
    const actionDelta = wide[4] - narrow[4];
    const dataDelta = wide.reduce((s, w, i) => (i === 4 ? s : s + (w - narrow[i])), 0);
    expect(actionDelta).toBeGreaterThan(0);
    expect(
      actionDelta,
      `the action column took ${px(actionDelta)} of ${CONTAINER_DELTA}px and the four data ` +
        `columns took ${px(dataDelta)} between them`
    ).toBeGreaterThan(dataDelta);
  });
});

// ── table routes 4 and 5 — the two ledgers ROUND 2 GOT WRONG ────────────────

/** The glyph box of an element's text, rather than the box of the cell holding it. */
function glyphWidth(el: Element | null | undefined): number {
  if (!el) throw new Error('no element to measure');
  const range = document.createRange();
  range.selectNodeContents(el);
  return px(range.getBoundingClientRect().width);
}

/** The first row's `<td>`s of the first table on the page. */
function bodyCells(): Element[] {
  return Array.from(document.querySelectorAll('table tbody tr:first-child > td'));
}

describe('/apps/review reports — the other table a ledger cannot help', () => {
  /**
   * 🔴 UNLEDGERED AND DELIBERATELY SO — `__tests__/appsWideLayout.test.ts` requires this arm
   * BY NAME for the `no-surplus` exemption, so deleting it turns the exemption red rather
   * than leaving it an unmeasured claim. Three ledgers were tried and every one was either
   * taller than natural at 1200 or clipped the `lineClamp={2}` details harder.
   */
  const queue = () => <OffsiteReportsQueue />;

  test('the queue renders its row (guards a vacuous measurement)', async () => {
    await renderRoute(queue(), WIDE);
    expect(headerWidths()).toHaveLength(6);
    expect(bodyCells()).toHaveLength(6);
    expect(document.querySelectorAll('table tbody button').length).toBeGreaterThanOrEqual(1);
    await cleanup();
  });

  test('the reports table is no worse than natural at every width', async () => {
    // It carries no colgroup, so "natural" is what it renders — the assertion is that the
    // recorded band is still what the browser produces. A value pin with provenance: these
    // are the four numbers the exemption was decided on, and a copy change that moves them
    // should be a decision rather than a drift.
    const heights = await atEachWidth(queue, firstRowHeight);
    expect(document.querySelector('table > colgroup')).toBeNull();
    expect(
      heights,
      `row height at ${ALL_WIDTHS.map((v) => v.width).join('/')} — the band the no-surplus ` +
        'exemption was measured against'
    ).toEqual([177.88, 88.69, 88.69, 82.89]);
  });

  test('🔴 the details box is CAPPED, which is why no column could absorb the slack', async () => {
    // The measurement that rejected `Reason` as a primary: its text is capped at 260px, so
    // a column given the surplus renders a wider cell around an identical sentence.
    const detailsBox = () => {
      const cell = bodyCells()[1];
      const texts = Array.from(cell.children);
      return px(texts[texts.length - 1].getBoundingClientRect().width);
    };
    const boxes = await atEachWidth(queue, detailsBox);
    expect(Math.max(...boxes)).toBeLessThanOrEqual(260);
  });
});

describe('/apps/installed activity — the table that a ledger cannot help', () => {
  /**
   * 🔴 THIS TABLE IS DELIBERATELY UNLEDGERED, and this arm is what keeps that decision
   * honest — `__tests__/appsWideLayout.test.ts` requires it BY NAME for the `no-surplus`
   * exemption, so deleting it turns the exemption red rather than silently unmeasured.
   *
   * Its natural layout already renders every cell on one line at every width, because its
   * max-content sum (~735px) is the container's content width at 768. Both ledgers that
   * shipped made rows TALLER — 48.09 and 64.89 against 36.19 — and neither was visible to a
   * width assertion at 1440/2560.
   */
  const panel = () => <AppActivityPanel />;

  test('the fixture is the RICH shape (guards a vacuous measurement)', async () => {
    // On a passive row every cell is short and nothing can wrap, so the heights below
    // would agree for a reason that has nothing to do with the layout.
    await renderRoute(panel(), WIDE);
    const cells = Array.from(document.querySelectorAll('table tbody tr:first-child > td'));
    expect(cells).toHaveLength(5);
    expect(cells[2].textContent).toContain('Tipped');
    expect(cells[3].textContent).toContain('/api/v1/buzz/tip');
    await cleanup();
  });

  test('the activity table renders ONE LINE per cell at every width', async () => {
    // 🔴 THE ARM THE EXEMPTION IS NAMED AGAINST. Four widths, two of them below 1440,
    // asserting HEIGHT — the three things this tier lacked when the two bad ledgers passed.
    const heights = await atEachWidth(panel, firstRowHeight);
    expect(
      heights,
      `row height at ${ALL_WIDTHS.map((v) => v.width).join('/')} — every value must be the ` +
        'single-line height; a taller one means a column was squeezed below its content'
    ).toEqual([36.19, 36.19, 36.19, 36.19]);
  });

  test('🔴 DETAIL is a fixed token — no layout can give it a usable pixel', async () => {
    // Round 2 made this the PRIMARY column on the strength of its name. Its glyph box is
    // identical at every width, which is half of why no ledger helps this table: one of
    // the two cells that would have to absorb the surplus cannot.
    const glyphs = await atEachWidth(panel, () =>
      glyphWidth(
        (Array.from(document.querySelectorAll('table tbody tr:first-child > td'))[3] as Element)
          .firstElementChild
      )
    );
    expect(new Set(glyphs).size, `Detail glyph widths were ${glyphs.join(' / ')}`).toBe(1);
  });

  test('…and ACTION, the other candidate, is a BOUNDED sentence', async () => {
    // The other half. It is genuinely variable — unlike `Detail` — but it stops growing,
    // so handing it the surplus would park the remainder mid-row. Constant here because
    // natural layout already gives it more than it needs at every width.
    const read = () => {
      const cell = Array.from(document.querySelectorAll('table tbody tr:first-child > td'))[2];
      return {
        glyph: glyphWidth(cell.firstElementChild),
        cell: px(cell.getBoundingClientRect().width),
      };
    };
    const measured = await atEachWidth(panel, read);
    expect(new Set(measured.map((m) => m.glyph)).size).toBe(1);
    for (const m of measured) expect(m.cell).toBeGreaterThan(m.glyph);
    // Guard-the-guard: an empty sentence would satisfy both trivially.
    expect(measured[0].glyph).toBeGreaterThan(100);
  });

  test('…and the two cells a ledger squeezed are each ONE line box', async () => {
    // The mechanism behind the height, so a future change that keeps the height constant
    // some other way is still legible. `When` broke a `YYYY-MM-DD HH:mm` stamp across three
    // lines under the shipped ledger; `Detail`'s monospace ref broke across two.
    const linesPerWidth = await atEachWidth(panel, () => {
      const cells = Array.from(document.querySelectorAll('table tbody tr:first-child > td'));
      return [lineCount(cells[0].firstElementChild), lineCount(cells[3].firstElementChild)];
    });
    expect(linesPerWidth).toEqual([
      [1, 1],
      [1, 1],
      [1, 1],
      [1, 1],
    ]);
  });
});

describe('🔴 NO LEDGER MAKES ITS ROWS TALLER AT A NARROWER WIDTH', () => {
  /**
   * THE TIER-WIDE INVARIANT, and the one that would have caught both bad ledgers.
   *
   * A percentage share is smallest in absolute px at the NARROWEST container, so a share
   * sized from a 1408 measurement can sit below its cell's content at 768 and 1200. The
   * cell does not then get narrower than a width assertion expects — it gets TALLER. Every
   * arm in this file read a width at 1440/2560 only, so two ledgers shipped green:
   * `AppActivityPanel`'s rows were 48.09 and then 64.89 against a natural 36.19.
   *
   * The invariant is stated as SHAPE rather than as a number: a table's row height must not
   * increase as the container gets narrower. It is deliberately not "equals N px" — these
   * tables have different row contents and a literal per table would rot on any copy
   * change — and it is not "equals the no-ledger height" either, because this tier cannot
   * render a component with its own colgroup removed.
   */
  const CASES = [
    {
      name: '/apps/review queue',
      ui: () => (
        <UnifiedReviewList
          onsiteItems={[ONSITE]}
          offsiteItems={[OFFSITE]}
          direction="asc"
          openOnsiteReview={vi.fn()}
          openOffsiteReview={vi.fn()}
          isLoading={false}
          emptyLabel="empty"
          dateLabel="Submitted"
          actionLabel="Review"
          hasMore={false}
          onLoadMore={vi.fn()}
        />
      ),
    },
    { name: '/apps/review previews', ui: () => <ActivePreviewsPanel /> },
    { name: '/apps/mine', ui: () => <MyAppsBodyView rows={[MINE_ROW]} /> },
  ] as const;

  test('the case list covers every LEDGERED table this file can mount', () => {
    // A loop over a list nobody pinned passes vacuously when the list shrinks.
    expect(CASES.map((c) => c.name)).toEqual([
      '/apps/review queue',
      '/apps/review previews',
      '/apps/mine',
    ]);
  });

  test.each(CASES)('$name — the ledger costs no vertical space at any width', async ({ ui }) => {
    // 🔴 MEASURED AGAINST THE SAME TREE WITH ITS `<colgroup>` REMOVED, not against a
    // literal and not against the other widths. Rows legitimately get taller at 768 for
    // ANY table — less width means more wrapping — so "not taller than at 2560" is a claim
    // no correct table could satisfy. What a ledger must never do is make a row taller
    // than the browser's own layout would at THAT width, and the only honest baseline for
    // that is natural layout of the same content. Detaching the `<colgroup>` and
    // re-measuring gives exactly that, in one render.
    const offenders: string[] = [];
    for (const vp of ALL_WIDTHS) {
      const observed = await renderRoute(ui(), vp);
      expect(observed).toEqual({ width: vp.width, height: vp.height });
      const withLedger = firstRowHeight();
      const colgroup = document.querySelector('table > colgroup');
      expect(colgroup, 'this case is supposed to be a LEDGERED table').not.toBeNull();
      colgroup!.remove();
      await nextLayout();
      const natural = firstRowHeight();
      if (withLedger > natural + 0.01) {
        offenders.push(
          `@${vp.width}: ${withLedger} with the ledger vs ${natural} without it ` +
            `(+${px(withLedger - natural)})`
        );
      }
      await cleanup();
    }
    expect(
      offenders,
      'the column ledger made rows TALLER than the browser lays them out unaided — a share ' +
        'is below its cell content at that width, which a width assertion cannot see'
    ).toEqual([]);
  });
});

// ── /apps/installed — the 640px dead gap ─────────────────────────────────────

describe('/apps/installed — the space-between row keeps its control near its content', () => {
  /**
   * The gap between the app NAME's right edge and the Manage button's left edge.
   *
   * 🔴 MEASURED ON THE TEXT, NOT ON ITS CELL. The row's left child is `flex: 1`, so its
   * BOX already spans the whole row at every width — reading the cell would report a
   * constant zero gap and pass against the defect. What actually recedes is the button
   * relative to the glyphs, which is what a moderator or an owner sees.
   */
  function nameToButtonGap(): number {
    const nameCell = Array.from(document.querySelectorAll('[data-apps-card-grid] .truncate')).at(0);
    const button = Array.from(document.querySelectorAll('[data-apps-card-grid] button')).at(-1);
    if (!nameCell || !button) throw new Error('the installed card did not render its row');
    // A `range` around the text node gives the glyphs' own box rather than the flex cell's.
    const range = document.createRange();
    range.selectNodeContents(nameCell);
    return px(button.getBoundingClientRect().left - range.getBoundingClientRect().right);
  }

  const grid = () => (
    <AppsCardGrid testId="apps-installed-apps-grid">
      <InstalledAppCard app={INSTALLED_APP} onManage={vi.fn()} />
    </AppsCardGrid>
  );

  test('🔴 the gap does NOT grow when the container does', async () => {
    // The recorded defect, as a comparison: at 1920 → 2560 the audit measured this gap
    // growing by exactly the container's own 640px, because a full-width card hands every
    // extra pixel to the space between the name and the button. Two named widths, because
    // one measurement is not a claim about a dimension.
    const { narrow, wide } = await atBothWidths(grid, nameToButtonGap);
    expect(narrow, 'the narrow fixture measured no gap at all').toBeGreaterThan(0);
    expect(
      wide,
      `the name→Manage gap went ${narrow} → ${wide} across a ${CONTAINER_DELTA}px container ` +
        'increase; the card grid is supposed to spend that on a second column'
    ).toBeLessThanOrEqual(narrow);
  });

  test('…because the CARD stops tracking the container (one column, then two)', async () => {
    // The mechanism, stated separately from its consequence so a future change that keeps
    // the gap constant some other way is still legible. The card is full-width at 1408 and
    // roughly half-width at 2528.
    const { narrow, wide } = await atBothWidths(grid, () =>
      px(document.querySelector('[data-apps-card-grid] > *')!.getBoundingClientRect().width)
    );
    expect(narrow).toBe(NARROW.content);
    // Two 1fr tracks with a 16px gap: (2528 − 16) / 2 = 1256.
    expect(wide).toBe(1256);
    expect(wide).toBeLessThan(narrow);
  });

  test("🔴 the Hidden tab's 12px gap gives the SAME rung, measured in the browser", async () => {
    // F8's equivalence, in the engine rather than in arithmetic. `appsCardGridColumnsAt`
    // MIRRORS the CSS; this reads the CSS. Two tracks either way, and the child is the
    // gap's own width narrower — which is also the only consumer the `gap` prop has, so
    // deleting the prop is visible here as well as at its call site.
    const { observed } = await renderAtViewport(
      <AppsPageLayout title="Fixture">
        <AppsCardGrid testId="apps-installed-hidden-grid" gap={12}>
          <InstalledAppCard app={INSTALLED_APP} onManage={vi.fn()} />
          <InstalledAppCard app={INSTALLED_APP} onManage={vi.fn()} />
        </AppsCardGrid>
      </AppsPageLayout>,
      WIDE
    );
    expect(observed).toEqual({ width: WIDE.width, height: WIDE.height });
    const gridEl = document.querySelector('[data-apps-card-grid]') as HTMLElement;
    expect(getComputedStyle(gridEl).columnGap).toBe('12px');
    // Two 1fr tracks with a 12px gap: (2528 − 12) / 2 = 1258 — the same TWO columns the
    // 16px default yields at this width, which is the whole claim.
    expect(px((gridEl.firstElementChild as HTMLElement).getBoundingClientRect().width)).toBe(1258);
    await cleanup();
  });

  test('🔴 ON A PHONE the card fits the screen — the `min(100%, …)` is load-bearing', async () => {
    // 🔴 THE ONE ASSERTION THAT MAKES THAT `min()` MORE THAN A COMMENT. Without it the
    // track floor is a flat 1200px, and neither of this file's other fixtures is narrower
    // than that — so dropping it passed the whole suite. Measured at 390×844 with the
    // `min()` removed: gridBox 358, gridScroll 1200, child 1200, and
    // `document.scrollWidth` UNCHANGED — the card is CLIPPED at the grid's edge with no
    // scrollbar and no page overflow to notice it by, which is worse than the "overflows
    // horizontally" the docstring used to claim. This route is phone-reachable, and this
    // component converted three of its lists from `Stack` to grid.
    const PHONE = { width: 390, height: 844 } as const;
    const { observed } = await renderAtViewport(
      <AppsPageLayout title="Fixture">{grid()}</AppsPageLayout>,
      PHONE
    );
    expect(observed).toEqual({ width: PHONE.width, height: PHONE.height });
    const gridEl = document.querySelector('[data-apps-card-grid]') as HTMLElement;
    const child = gridEl.firstElementChild as HTMLElement;
    const gridBox = px(gridEl.getBoundingClientRect().width);
    const childBox = px(child.getBoundingClientRect().width);
    // ONE column, and the card is inside the grid rather than hanging out of it.
    expect(childBox).toBeLessThanOrEqual(gridBox);
    // …and the grid is not itself a scroll container hiding the overflow.
    expect(gridEl.scrollWidth).toBeLessThanOrEqual(Math.ceil(gridBox));
    // The positive control on the two assertions above: the grid really is narrower than
    // the track floor here, so this fixture CAN see the defect. Without this, a viewport
    // that quietly grew past 1200 would make both checks vacuous.
    expect(gridBox).toBeLessThan(1200);
    await cleanup();
  });
});
