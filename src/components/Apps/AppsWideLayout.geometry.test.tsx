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
 * Two mechanisms answer that, and both are only observable as PIXELS:
 *
 *   · `AppsTableColgroup` — percentage widths on every column except the primary, which
 *     is left `auto` so the surplus lands there. A `<colgroup>` in the WRONG PLACE (after
 *     `<thead>`) is ignored SILENTLY; a ledger with the wrong column count mis-assigns
 *     widths silently; and neither shows up in the DOM as anything but a correct-looking
 *     `<col>` list. `__tests__/appsWideLayout.test.ts` pins the data and the wiring and
 *     cannot see any of that.
 *   · `AppsCardGrid` — `/apps/installed`'s cards step to a second column exactly where the
 *     surplus appeared, so a card's own width stops tracking the container and the
 *     name→Manage gap stops growing.
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
import { cascadeEvidence, renderAtViewport } from '../../../test/geometry-setup';
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
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: { blocks: { getNavSummary: { useQuery: () => ({ data: undefined }) } } },
}));
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

/** The container's own content width at each fixture viewport, as literals. */
const NARROW = { width: 1440, height: 900, content: 1408 } as const;
const WIDE = { width: 2560, height: 1440, content: 2528 } as const;
const CONTAINER_DELTA = WIDE.content - NARROW.content; // 1120

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
      [0, 10],
      [2, 12],
      [3, 14],
      [4, 10],
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
});
