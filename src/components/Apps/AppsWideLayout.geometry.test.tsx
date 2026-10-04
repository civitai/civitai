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
 *   · `AppsCardGrid` — `/apps/activity`'s cards step to a second column exactly where the
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
 * The `/apps/activity` block below mounts the real `InstalledAppCard` inside
 * `AppsCardGrid` — but the GRID IS SUPPLIED BY THE TEST, so these assertions say "the card
 * behaves correctly when it is in the grid", not "the page puts it in one". Measured
 * against `origin/main`'s components with only the new module scaffolded in, the two
 * installed tests PASSED while the four table tests went red — i.e. this file alone cannot
 * see the page reverting to a `Stack`. That claim is `__tests__/appsWideLayout.test.ts`'s
 * "🔴 /apps/activity uses the card GRID, and no longer caps its body", which is red at
 * `origin/main` for exactly that reason. Two guards, one for the mechanism and one for its
 * adoption; neither is a substitute for the other.
 */
import { describe, expect, test, vi } from 'vitest';
import { cleanup } from 'vitest-browser-react';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import {
  LOADABLE_IMAGE_DATA_URI,
  cascadeEvidence,
  nextLayout,
  renderAtViewport,
} from '../../../test/geometry-setup';
import { USERNAME_MAX_LENGTH } from '~/shared/zod/username.schema';
import type * as TrpcMod from '~/utils/trpc';
import type * as BrowserSettingsMod from '~/providers/BrowserSettingsProvider';
import type * as BrowsingLevelMod from '~/components/BrowsingLevel/BrowsingLevelProvider';
import type { GroupedApp } from '~/components/Apps/groupSubscriptionsByApp';
import type { SubscriptionRecord } from '~/server/schema/blocks/subscription.schema';
import type { MyAppRow } from '~/components/Apps/myAppsView';
import type { OffsiteReviewRequest, OnsiteReviewRequest } from '~/components/Apps/unifiedReviewRow';
import { capabilitiesForKind } from '~/shared/constants/app-capabilities.constants';

/**
 * 🔴 THE LEFT RAIL IS STUBBED OUT OF THIS FILE, AND THE REASON IS THE FILE'S SUBJECT.
 *
 * Every fixture below is named as a CONTENT WIDTH (736 / 1168 / 1408 / 2528) and every
 * number in the file is a function of that input: how a proportional `<colgroup>` spends
 * it, where a card grid steps, how tall a row gets when a column is squeezed. The rail
 * changes the INPUT (it takes 276px off the body on every `/apps/*` route); it does not
 * change any of those mechanisms. Re-baselining ~40 measured literals to rail-reduced
 * widths would mean re-deriving each of them from the implementation that just changed —
 * and would delete this file's coverage at exactly the 1408 / 2528 content widths the
 * ultrawide pass was written against.
 *
 * So `useAppsNavSections` returns an EMPTY list, which is a real production state (the
 * `< 2 sections` collapse) and makes `AppsPageLayout` render no rail and give the body the
 * full container. The rail's own cost is pinned exactly once, where it belongs:
 * `AppsPageLayout.chromeAlignment.browser.test.tsx` measures `bodyLeft − navLeft === 276`
 * on all 12 routes in both rail states, and `__tests__/appsRailGeometry.test.ts` pins the
 * constant it comes from.
 *
 * ⚠️ WHAT THAT LEAVES UNMEASURED, STATED RATHER THAN LEFT TO BE DISCOVERED: no test in
 * this file reads these TABLES at the content width a 1440 viewer with an OPEN rail
 * actually gets (1132). The `RAIL-OPEN` describe at the end of this file is a deliberate
 * PARTIAL answer and nothing more: it pins a PRECONDITION (the body really is 276px
 * narrower) and one NON-degradation (the card list still steps to two columns at the new
 * `APPS_CARD_LIST_MIN_COLUMN`). ⚠️ AN EARLIER DRAFT OF THIS SENTENCE CLAIMED IT "records
 * the two degradations that width causes". It records none — there is no degradation
 * asserted anywhere in this file at 1132, and saying otherwise turned an admitted gap
 * into a false claim of coverage, which is worse than the gap. The one degradation this
 * change does cause at a narrowed width is the `/apps/build` table scrolling a viewport
 * step earlier, and it is recorded at `SUBMISSIONS_TABLE_MIN_WIDTH`, not here.
 */
/**
 * The section list the layout sees, as a MUTABLE holder rather than a fixed `[]`. Vitest's
 * browser mode cannot `vi.spyOn` an ESM export ("Module namespace is not configurable"),
 * so the RAIL-OPEN block at the end of this file flips this instead — which is also the
 * clearer mechanism: one place decides whether the chrome is in the tree.
 */
const navState = vi.hoisted(() => ({ sections: [] as unknown[] }));

/**
 * Fixture values the `vi.mock` factory below AND the assertions both read, so the two
 * cannot drift. A scope id retyped on each side is the shape that keeps passing after the
 * fixture changes — the same consolidation pin `AppPermissionsActivityDrawer.browser.test.tsx`
 * makes for its empty-label sentence.
 */
const fixture = vi.hoisted(() => ({
  /**
   * DELIBERATELY LONGER THAN ANY REAL BLOCK SCOPE, and asserted to be below against
   * `BLOCK_SCOPE_TO_OAUTH_BIT` — the registry that DEFINES the population — rather than
   * against a remembered list.
   *
   * 🔴 IT ALSO OVERSHOOTS THE CONTAINER, WHICH A MERELY-LONGER ID DOES NOT. A 47-char
   * fixture was measured rendering on ONE line inside the 408px drawer,
   * so the arm below could not see the badge's `white-space: nowrap` / `overflow: hidden` at
   * all — it would have passed with the ellipsis intact. This id needs two lines at 408, so
   * the wrap is the thing under test rather than an incidental fit.
   */
  longScope: 'apps:diagnostics:telemetry:aggregate:write:self:secondary:partition',
  /** The longest REAL scope that also carries a description, for the own-line arm. */
  describedScope: 'apps:storage:shared:write',
  /**
   * The one row in the drawer fixture that carries a real phase-3 REVOKE BUTTON.
   *
   * `ai:write:budgeted` because it is consent-GATED (so the server would really list it in
   * `revokableScopes`), KNOWN to the scope registry (so `isKnownBlockScope` keeps it), and
   * SENSITIVE — which means its row also renders `SensitiveScopeBadge`, making it the widest
   * badge row in the fixture and therefore the right one to hang a control off when the question
   * is whether the control competes with the id for inline space at 408px.
   */
  revokableScope: 'ai:write:budgeted',
  /**
   * The drawer fixture's `revoked_scopes`, as a MUTABLE array the one strike-through arm fills and
   * empties again.
   *
   * 🔴 IT IS EMPTY BY DEFAULT ON PURPOSE — every other drawer arm measures the ORDINARY case, and a
   * globally-revoked fixture would strike the badge in the arms that read its geometry.
   *
   * 🔴 AND IT IS MUTATED IN PLACE, NEVER REASSIGNED. `DATA` is built once inside the `vi.mock`
   * factory and captures this array by REFERENCE, so `push`/`length = 0` are visible to the next
   * render while `fixture.drawerRevoked = [...]` would swap the holder and leave the factory
   * pointing at the old array — a mutation that silently does nothing. Same reason `navState` above
   * is a mutable holder: vitest browser mode cannot `vi.spyOn` an ESM export.
   */
  drawerRevoked: [] as string[],
}));
vi.mock('~/components/Apps/useAppsNavSections', () => ({
  useAppsNavSections: () => navState.sections,
}));

// The sub-nav needs a qualifying viewer or it renders no `<nav>` at all — same fixture
// as `AppsPageLayout.chromeAlignment.browser.test.tsx`, for the same reason.
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ appBlocks: true, appBlocksAuthor: true }),
  useOptionalFeatureFlags: () => ({ appBlocks: true, appBlocksAuthor: true }),
  useFeatureFlagsReady: () => true,
  FeatureFlagsProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock('~/providers/IsClientProvider', () => ({ useIsClient: () => true }));
/*
  🔴 THE REAL `UserAvatar` RENDERS IN THIS TIER, AND THE STUB IT REPLACED WAS A MEASUREMENT
  DEFECT. This file's whole purpose is painted width, and the Submitter column's share is
  what the declared-share arm below reads — so stubbing the component
  whose width is the quantity under assertion measured the stub. (The behaviour suites
  elsewhere DO stub it; there the width is not what they assert.) What the real component
  needs is two viewer-state hooks no geometry fixture can supply: `useBrowsingSettings`
  (via `useGetEdgeUrl`) and `useViewerBrowsingLevelDebounced` (called directly) — both
  stubbed at the SOURCE rather than the component.
*/
vi.mock('~/providers/BrowserSettingsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowserSettingsMod>()),
  // The avatar reads one slice (`autoplayGifs`) through this selector; a geometry fixture
  // has no settings store, and the value cannot change a rendered width.
  useBrowsingSettings: () => undefined,
}));
vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowsingLevelMod>()),
  useViewerBrowsingLevelDebounced: () => 1,
}));
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
              // 🔴 A FIXED OFFSET FROM `now`, NOT AN ABSOLUTE INSTANT. The `When` cell
              // renders `DaysFromNow`, so an absolute fixture would render a string that
              // GROWS with wall-clock time ('7 days ago' → 'a year ago') and quietly
              // change the column widths this file measures. 20 minutes always renders
              // '20 minutes ago'.
              createdAt: new Date(Date.now() - 20 * 60 * 1000),
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
    // `AppPermissionsActivityDrawer`'s scope section. One over-long id (the clipping arm)
    // plus one real described id (the own-line arm).
    'blocks.listMyScopeGrants': [
      {
        appBlockId: 'ab_9',
        slug: 'lighthouse',
        name: 'Lighthouse',
        origin: 'install',
        // ORDER IS LOAD-BEARING: the grouping arm reads the gap from the described scope's
        // description DOWN to the NEXT scope's id, so the described one has to come first.
        // ⚠️ `fixture.revokableScope` is APPENDED, never inserted — the two arms above resolve
        // `describedScope` then `longScope` as consecutive rows, and putting a third between them
        // would silently change what `inter` measures.
        scopes: [fixture.describedScope, fixture.longScope, fixture.revokableScope],
        // 🔴 THE PHASE-3 CONSENT LAYER, WITHOUT WHICH THE DRAWER ARMS MEASURE THE WRONG TREE.
        // `ScopeConsentList` renders a per-scope affordance for every row — a control for a
        // revokable scope, an honest note for the rest — so a fixture carrying none of these
        // fields would lay the drawer out with no consent row at all and the clipping arm would
        // be reading a box no viewer gets. Exactly what the server sends:
        //   - `describedScope` (`apps:storage:shared:write`) is CONSENT-EXEMPT, so the server
        //     omits it from `revokableScopes` and it renders its `fixedScopeNote`.
        //   - `longScope` is not in the scope registry at all, so `isKnownBlockScope` excludes it
        //     too and it takes the GENERIC note — the longest note in the vocabulary, i.e. the
        //     most demanding case for the drawer's height.
        //   - `revokableScope` (`ai:write:budgeted`) is consent-gated and known, so it is the one
        //     row carrying a real "Remove" button at this width.
        revokableScopes: [fixture.revokableScope],
        // 🔴 AND THE VIEWER-SIDE SET, WHICH THE CONTROL ALSO DEPENDS ON. A row needs to be in the
        // app's consent-gated set AND in the viewer's granted set to get a "Remove" button —
        // `blocks.revokeScopes` refuses a scope the viewer never granted, so a control offered
        // without this would be one the server rejects. Omitting the field is NOT neutral: it means
        // "the server did not say", which renders every row in the `unknown` state with NO
        // affordance at all — measured, that is exactly what took the consent child out of the two
        // drawer arms below and made them measure a box no viewer gets. Same reason
        // `revokableScopes` is here.
        grantedScopes: [fixture.revokableScope],
        // BY REFERENCE — see `fixture.drawerRevoked`. Empty for every arm but the strike-through
        // one, which fills it in place and empties it again in a `finally`.
        revokedScopes: fixture.drawerRevoked,
        scopesRevokedAt: null,
      },
    ],
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
// `/apps/activity`'s module calls `createServerSideProps` at import time, which pulls the
// server graph into a browser bundle. Stubbed so the page's `InstalledAppCard` — the REAL
// card whose gap this file measures — can be imported without it.
vi.mock('~/server/utils/server-side-helpers', () => ({
  createServerSideProps: () => async () => ({ props: {} }),
}));

const { AppsPageLayout } = await import('~/components/Apps/AppsPageLayout');
const { AppsCardGrid, APPS_REVIEW_QUEUE_COLUMNS } = await import(
  '~/components/Apps/appsWideLayout'
);
const { UnifiedReviewList } = await import('~/components/Apps/UnifiedReviewList');
const { MyAppsBodyView } = await import('~/components/Apps/MyAppsBody');
const { InstalledAppCard } = await import('~/pages/apps/activity');
const { ActivePreviewsPanel } = await import('~/components/Apps/ActivePreviewsPanel');
const { OffsiteReportsQueue } = await import('~/components/Apps/OffsiteReviewQueue');
const { AppActivityPanel } = await import('~/components/Apps/AppActivityPanel');
const { AppPermissionsActivityDrawer } = await import(
  '~/components/AppBlocks/AppPermissionsActivityDrawer'
);
const { BLOCK_SCOPE_TO_OAUTH_BIT } = await import('~/shared/constants/block-scope.constants');
const { SCOPE_DESCRIPTIONS } = await import(
  '~/server/services/blocks/scope-descriptions.constants'
);

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

/** The shared loadable 1×1 data: URI — an http(s) src is never served to a test browser,
 *  so the `<img>` would fire a real `error` event mid-test (`no-unloadable-image-fixture`). */
const PIXEL = LOADABLE_IMAGE_DATA_URI;

/** The dedup key the adapter builds for `ONSITE` — the suffix of every row-scoped testid. */
const ONSITE_KEY = 'onsite:or1';

/**
 * 🔴 THE LONGEST USERNAME THE SCHEMA ALLOWS, DERIVED FROM THE BOUND ITSELF. The Submitter
 * cell's MIN-CONTENT is what the declared-share arm reads, and a long name is what sets it
 * — so a fixture shorter than the bound measures a cell narrower than production can
 * render, which is how that share shipped two sizes too small, twice.
 *
 * Derived rather than pinned: an earlier revision hardcoded 25 and a sibling unit test
 * regex-grepped THIS FILE AS A STRING to check the number. That mechanism was itself the
 * defect — the loose regex was walkable by a `//`-commented decoy — and importing the
 * constant makes the whole class unreachable. The chip is `wrap="nowrap"`, so this moves
 * min-content, not row height.
 */
const SUBMITTER_USERNAME = 'w'.repeat(USERNAME_MAX_LENGTH);

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
  // 🔴 THE WIDEST REALISTIC VERSION CELL, DELIBERATELY. The first-version badge sits beside
  // the `<Code>` semver on a nowrap row, so this is the shape whose max-content the Version
  // share has to clear — a fixture without it would measure a cell narrower than production
  // ever renders and the share could sit below its content unnoticed.
  manifestDiffSummary: { kind: 'first-version', fields: ['name', 'version'] },
  // The widest realistic Plays label (`abbreviateNumber` → "12.4k plays").
  playCount: 12_400,
  iconUrl: PIXEL,
  coverUrl: PIXEL,
  reviewRepoUrl: 'https://forgejo.example/repo',
  submittedBy: { id: 7, username: SUBMITTER_USERNAME, deletedAt: null, image: null },
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
  submittedBy: { id: 9, username: 'offsite-dev', deletedAt: null, image: null },
  playCount: 7,
  iconUrl: PIXEL,
  coverUrl: null,
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

/** The Pending/Rejected shape — seven columns, no Deploy. */
const reviewList = () => (
  <UnifiedReviewList
    onsiteItems={[ONSITE]}
    offsiteItems={[OFFSITE]}
    direction="asc"
    openOnsiteReview={vi.fn()}
    openOffsiteReview={vi.fn()}
    openVersionHistory={vi.fn()}
    isLoading={false}
    emptyLabel="empty"
    dateLabel="Submitted"
    actionLabel="Review"
    hasMore={false}
    onLoadMore={vi.fn()}
  />
);

/** The Approved shape — the SAME component with the retrigger handler that adds Deploy. */
const reviewListWithDeploy = () => (
  <UnifiedReviewList
    onsiteItems={[
      { ...ONSITE, deployState: 'live', reviewedAt: '2026-01-02T00:00:00Z' } as OnsiteReviewRequest,
    ]}
    offsiteItems={[OFFSITE]}
    direction="desc"
    openOnsiteReview={vi.fn()}
    openOffsiteReview={vi.fn()}
    openVersionHistory={vi.fn()}
    isLoading={false}
    emptyLabel="empty"
    dateLabel="Reviewed"
    actionLabel="View"
    hasMore={false}
    onLoadMore={vi.fn()}
    onRetriggerBuild={vi.fn()}
  />
);

describe('/apps/review — the queue table spends the width on its App column', () => {
  const list = reviewList;
  const listWithDeploy = reviewListWithDeploy;

  test('the App column grows with the container, and takes MOST of the surplus', async () => {
    // 🔴 THE CLAIM IS A SHARE, NOT MERELY "IT GREW". Without a `<colgroup>` every column
    // grows — automatic table layout distributes surplus across all of them in proportion
    // to their content — so "the App column got wider" is satisfied by the DEFECT. What
    // separates the two is HOW MUCH of the 1120px it took: the ledger leaves it more than
    // every fixed share put together.
    const { narrow, wide } = await atBothWidths(list, headerWidths);
    const expected = APPS_REVIEW_QUEUE_COLUMNS.withoutDeploy.length;
    expect(narrow, `the queue renders ${expected} columns on the Pending tab`).toHaveLength(
      expected
    );
    expect(wide).toHaveLength(expected);

    const appDelta = wide[1] - narrow[1];
    const otherDelta = wide.reduce((s, w, i) => (i === 1 ? s : s + (w - narrow[i])), 0);

    expect(appDelta, 'the App column did not grow at all').toBeGreaterThan(0);
    expect(
      appDelta,
      `the App column took ${px(appDelta)} of the container's ${CONTAINER_DELTA}px, and the ` +
        `other ${expected - 1} columns took ${px(otherDelta)} between them — the primary ` +
        'column is supposed to absorb the slack'
    ).toBeGreaterThan(otherDelta);
    // …and the two together account for the whole container delta, so nothing has been
    // silently spent as table margin.
    expect(px(appDelta + otherDelta)).toBeCloseTo(CONTAINER_DELTA, 0);
  });

  test('the non-primary columns hold their declared share at the wide width', async () => {
    // The other half of "proportional": the fixed columns are a PERCENTAGE of the table,
    // not a content width that happens to have grown. Asserted at the wide fixture only,
    // because at 1408 a column can legitimately exceed its share (min-content wins).
    // Derived from the ledger rather than a hand-copied pair list, so adding a column
    // cannot drop a later one out of the check.
    await renderRoute(list(), WIDE);
    const widths = headerWidths();
    const table = document.querySelector('table')!.getBoundingClientRect().width;
    let checked = 0;
    for (const [index, share] of APPS_REVIEW_QUEUE_COLUMNS.withoutDeploy.entries()) {
      if (share === null) continue;
      checked += 1;
      expect(px(widths[index]), `column ${index} should be ${share}% of ${px(table)}`).toBeCloseTo(
        (share / 100) * table,
        0
      );
    }
    expect(checked, 'no fixed column was checked').toBe(
      APPS_REVIEW_QUEUE_COLUMNS.withoutDeploy.length - 1
    );
    await cleanup();
  });

  test('🔴 the APPROVED shape (with Deploy) holds its shares too, and does not overflow', async () => {
    // The Deploy column exists on one tab only, so the eight-column shape is a SECOND
    // table that no arm measured — and a share below its cell content is invisible to the
    // seven-column one. Both shapes are rendered from the same component, so the only
    // thing that separates them is the prop that adds the column.
    await renderRoute(listWithDeploy(), WIDE);
    const widths = headerWidths();
    const table = document.querySelector('table')!.getBoundingClientRect().width;
    expect(widths).toHaveLength(APPS_REVIEW_QUEUE_COLUMNS.withDeploy.length);
    let checked = 0;
    for (const [index, share] of APPS_REVIEW_QUEUE_COLUMNS.withDeploy.entries()) {
      if (share === null) continue;
      checked += 1;
      expect(
        px(widths[index]),
        `approved-shape column ${index} should be ${share}% of ${px(table)}`
      ).toBeCloseTo((share / 100) * table, 0);
    }
    // Same counter as the seven-column arm: a second `null` in the ledger would otherwise
    // drop a column from the check while `toHaveLength` still passed.
    expect(checked, 'no fixed column was checked').toBe(
      APPS_REVIEW_QUEUE_COLUMNS.withDeploy.length - 1
    );
    // Nothing paints outside the table at any of the four widths.
    await cleanup();
    for (const vp of ALL_WIDTHS) {
      await renderRoute(listWithDeploy(), vp);
      const el = document.querySelector('table') as HTMLElement;
      expect(
        el.scrollWidth,
        `the approved-shape table overflows its own box at ${vp.width}`
      ).toBeLessThanOrEqual(Math.ceil(el.clientWidth) + 1);
      await cleanup();
    }
  });

  test('🔴 the Version cell is no worse CONTAINED than the browser contains it unaided', async () => {
    /**
     * 🔴 THE FAILURE THIS CATCHES IS INVISIBLE TO EVERY WIDTH AND HEIGHT ASSERTION ABOVE.
     * The cell is a `wrap="nowrap"` Group holding a `<Code>` and a Badge, which is the
     * exact shape `/apps/mine`'s Status row had: its min-content is far below what it
     * PAINTS, so a share sized under the painted width leaves the content overhanging into
     * the next column or clipped inside its own — the row does not get taller and no
     * column gets narrower, so the row-height invariant and the declared-share arm both
     * stay green.
     *
     * TWO AXES, MEASURED DIFFERENTLY ON PURPOSE. Overhang is absolute — nothing may paint
     * outside the cell at any width. CLIPPING is measured against the same tree with its
     * `<colgroup>` REMOVED, for the reason the row-height invariant below gives at length:
     * at 768 this table's columns want more than the container's 736px between them
     * whatever the split, so a literal "never clipped" is a claim no correct ledger could
     * satisfy. What a ledger must never do is clip the cell WORSE than the browser does
     * unaided at that width — which is a comparison this arm takes rather than a number
     * either file asserts.
     */
    const offenders: string[] = [];
    for (const vp of ALL_WIDTHS) {
      await renderRoute(list(), vp);
      const measure = () => {
        const td = document.querySelector(
          `[data-testid="apps-unified-review-row-${ONSITE_KEY}"] td:nth-child(3)`
        ) as HTMLElement;
        const inner = document.querySelector(
          `[data-testid="apps-unified-review-version-trigger-${ONSITE_KEY}"]`
        ) as HTMLElement;
        const pad = parseFloat(getComputedStyle(td).paddingRight) || 0;
        const overhang =
          inner.getBoundingClientRect().right - (td.getBoundingClientRect().right - pad);
        // `scrollWidth > clientWidth` is the second half: content clipped INSIDE the
        // trigger is content a moderator cannot read, even with nothing painting outside.
        const clipped = inner.scrollWidth - Math.round(inner.getBoundingClientRect().width);
        return { overhang, clipped };
      };
      const withLedger = measure();
      const colgroup = document.querySelector('table > colgroup');
      expect(colgroup, 'this arm is supposed to measure a LEDGERED table').not.toBeNull();
      colgroup!.remove();
      await nextLayout();
      const natural = measure();
      // OVERHANG is absolute: nothing may paint outside the cell's content box at any
      // width. It is NOT compared to natural layout, because natural gives every
      // non-primary column more room than a ledger deliberately does — "no worse than
      // natural" on this axis is a claim no correct ledger could satisfy.
      if (withLedger.overhang > 1) {
        offenders.push(`@${vp.width}: overhangs its column by ${px(withLedger.overhang)}`);
      }
      if (withLedger.clipped > natural.clipped + 1) {
        offenders.push(
          `@${vp.width}: clips ${withLedger.clipped}px with the ledger vs ${natural.clipped}px without it`
        );
      }
      await cleanup();
    }
    expect(
      offenders,
      'the Version share is below what the cell paints — a nowrap row overhangs or clips ' +
        'rather than wrapping, which no width or height assertion can see'
    ).toEqual([]);
  });

  test('the new cells really render (guards a vacuous measurement)', async () => {
    // Every assertion above is a width comparison, and a cell that rendered nothing
    // produces two internally-consistent numbers just as happily. One entry per cell this
    // change added — Plays was missing from this list while the comment claimed it was
    // covered.
    await renderRoute(list(), NARROW);

    const text = (testId: string) => {
      const el = document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
      expect(
        el,
        `${testId} did not render — the measurement above covered an empty cell`
      ).not.toBeNull();
      return (el!.textContent ?? '').trim();
    };

    /**
     * 🔴 THE VALUE, NOT MERELY A NON-EMPTY ELEMENT. THREE of these five cells — Version,
     * Submitter, Plays — render `'—'` on their OWN testid when the datum is missing, so
     * "present" and even "non-empty" pass over a placeholder, which is the shape this arm
     * exists to catch. Asserting the fixture's own values is what makes those three
     * load-bearing, and it covers the submitter span's empty-child case (a `UserAvatar`
     * returning null for `id === -1` leaves the span in the DOM). The other two carry no
     * placeholder branch: `first-version` renders no testid at all when absent, and the age
     * cell has no `'—'` arm — which is why that one is a SHAPE matcher, the only form there
     * that also excludes an empty render.
     */
    expect(text(`apps-unified-review-version-${ONSITE_KEY}`)).toContain('1.0.0');
    expect(text(`apps-unified-review-first-version-${ONSITE_KEY}`)).toBe('first version');
    expect(text(`apps-unified-review-submitter-${ONSITE_KEY}`)).toContain(SUBMITTER_USERNAME);
    expect(text(`apps-unified-review-plays-${ONSITE_KEY}`)).toContain('plays');
    // 🔴 A SHAPE, NOT `not.toBe('—')`. That form is dead on this arm: `compactRelativeTime`
    // returns either the dash or a label, so it discriminates the production placeholder but
    // NOT the emptiness this arm is named for — rendering `{''}` passed it. The value itself
    // is pinned in `UnifiedReviewList.browser.test.tsx`; `now` here is the real clock, so a
    // shape is what this tier can assert.
    expect(text(`apps-unified-review-age-${ONSITE_KEY}`)).toMatch(/^(now|\d+(m|h|d|w|mo|y))$/);

    // The icon is a LEAF `<img>` — no text, no children — so presence plus a `src` is what
    // "it rendered" means there.
    const icon = document.querySelector(
      `[data-testid="apps-unified-review-icon-${ONSITE_KEY}"]`
    ) as HTMLImageElement | null;
    expect(icon, 'the row icon did not render').not.toBeNull();
    expect(icon!.getAttribute('src'), 'the row icon rendered with no src').toBeTruthy();
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

describe('/apps/activity activity — the table that a ledger cannot help', () => {
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
    //
    // 🔴 THE `When` READ DRILLS TO THE `<time>`, AND THAT IS A MEASUREMENT FIX RATHER
    // THAN A SOFTENING. `lineCount` is `Range.getClientRects().length`, which returns one
    // rect PER BOX in the range — so once `When` became `<Text><time>…</time></Text>`
    // (the `DaysFromNow` relative stamp) the wrapper's range held the `<time>` box AND its
    // text box and returned 2 with nothing having wrapped. Measured: the row-height arm
    // above stayed at 36.19 across all four widths through that change, which is the
    // independent proof that the cell is still one line. Reading the text-bearing element
    // is what makes this arm about WRAPPING again.
    const linesPerWidth = await atEachWidth(panel, () => {
      const cells = Array.from(document.querySelectorAll('table tbody tr:first-child > td'));
      const when = cells[0].querySelector('time') ?? cells[0].firstElementChild;
      return [lineCount(when), lineCount(cells[3].firstElementChild)];
    });
    expect(linesPerWidth).toEqual([
      [1, 1],
      [1, 1],
      [1, 1],
      [1, 1],
    ]);
  });
});

// ── the SIXTH width: the permissions drawer's ~408px container ──────────────

/**
 * 🔴 THE MOUNT EVERY WIDTH ABOVE IS BLIND TO.
 *
 * `AppActivityPanel` and `BlockScopeList` have a second home: the run-frame
 * "Permissions & activity" drawer, a Mantine `size="md"` `Drawer` — 27.5rem of content box
 * minus its body padding, i.e. ~408px — which can sit inside a 2560 viewport. The four
 * widths this file was written against are 768 / 1200 / 1440 / 2560, so the panel's
 * `no-surplus` exemption (≈735px of max-content against 736px of container at 768) is a
 * measurement that PINS viewport ≥768 and cannot describe this box at all: 735 in 408 is
 * ~80% over.
 *
 * 🔴 EVERY ARM HERE IS READ AT A 2560 VIEWPORT, WHICH IS THE POINT. A viewport media query is
 * the wrong instrument by construction — the container is 408 while the window is 2560 — so a
 * fix driven by `@media` would pass a narrow-viewport test and leave the real drawer broken.
 * Reading these at the widest fixture is what makes them a claim about the CONTAINER.
 *
 * 🔴 AND EVERY ARM THAT PINS THE PRE-CHANGE BEHAVIOUR LEADS WITH A LOCATOR THAT EXISTS THERE.
 * An earlier revision resolved `[data-testid="app-activity-panel"]` /
 * `[data-testid="block-scope-list"]`, testids this change introduces — so four arms went red at
 * `origin/main` inside the `need()` helper, on a missing test hook, which is evidence about
 * nothing. Mantine's own `.mantine-Drawer-*` / `.mantine-Badge-root` static classes and plain
 * `table`/`tbody` are present either way, so each of those arms' FIRST failing read at base is a
 * geometry one: `'table'` vs `'block'`, `TR right=2568.48` against a 2544 edge, the id fitting one
 * line at 16px, the description sitting 18px ABOVE its id, and the phone page still a table.
 *
 * ⚠️ TWO THINGS THIS DOES NOT CLAIM, because an earlier revision claimed both and was wrong.
 * (a) `data-activity-cell` and the status pill's `sr-only` span are introduced by this change, so
 * an arm that LEADS with `stackedCell()` or with that span is red at base on a missing hook — put
 * a base-stable read first, as the phone arm now does. (b) The sr-only arm is not in the base-red
 * set at all, and does not need to be: it pins a property of the NEW rendering, not of the old
 * one. Read the base-red count off a fresh run rather than from a number in this comment — arms
 * have been added to this block twice since the first one was taken.
 */
describe('🔴 THE PERMISSIONS DRAWER — a 408px container inside a 2560 viewport', () => {
  const drawer = () => (
    <AppPermissionsActivityDrawer appBlockId="ab_9" appName="Lighthouse" opened onClose={vi.fn()} />
  );

  /** The drawer renders through a Portal, so it is NOT wrapped in the apps page layout. */
  async function renderDrawer(viewport: { width: number; height: number }) {
    const { observed } = await renderAtViewport(drawer(), viewport);
    expect(observed).toEqual({ width: viewport.width, height: viewport.height });
  }

  function need<T extends Element>(selector: string): T {
    const el = document.querySelector<T>(selector);
    if (!el) throw new Error(`nothing rendered for ${selector}`);
    return el;
  }

  /** Mantine's own drawer body — the box the viewer actually has, fixed by `size="md"`. */
  const drawerBody = () => need<HTMLElement>('.mantine-Drawer-body');
  const activityTable = () => need<HTMLElement>('.mantine-Drawer-body table');
  const stackedRow = () => need<HTMLElement>('.mantine-Drawer-body tbody tr');
  const stackedCell = (name: string) =>
    need<HTMLElement>(`.mantine-Drawer-body tbody td[data-activity-cell="${name}"]`);

  /** `--drawer-size-md` = 27.5rem, and the body's 16px inline padding either side. */
  const DRAWER_BORDER_BOX = 440;
  const DRAWER_CONTENT_BOX = 408;

  /** The drawer body's CONTENT box — `getBoundingClientRect()` gives the border box. */
  function drawerContent(): { width: number; right: number } {
    const body = drawerBody();
    const style = getComputedStyle(body);
    const box = body.getBoundingClientRect();
    const padLeft = parseFloat(style.paddingLeft);
    const padRight = parseFloat(style.paddingRight);
    const borderRight = parseFloat(style.borderRightWidth);
    const borderLeft = parseFloat(style.borderLeftWidth);
    return {
      width: box.width - padLeft - padRight - borderLeft - borderRight,
      right: box.right - padRight - borderRight,
    };
  }

  /**
   * 🔴 THE PRECONDITION THE TWO DRAWER LITERALS SILENTLY REST ON. Mantine's drawer content is
   * `overflow-y: auto`, so a fixture tall enough to scroll takes ~15px of classic scrollbar off
   * the body's inner width and turns three arms red with a message about the drawer's SIZE. This
   * makes the scrollbar name itself instead.
   */
  function assertDrawerDoesNotScroll() {
    const content = need<HTMLElement>('.mantine-Drawer-content');
    expect(
      content.scrollHeight,
      `the drawer content scrolls (${content.scrollHeight} into ${content.clientHeight}) — a ` +
        'scrollbar narrows the body and every width below is measured against the wrong box'
    ).toBeLessThanOrEqual(content.clientHeight);
  }

  test('the fixture is over-long by the REGISTRY, not by memory', () => {
    // 🔴 A POSITIVE CONTROL ON THE CLIPPING ARM, NOT COVERAGE OF EITHER COMPONENT — it renders
    // nothing. `apps:storage:shared:write`, the longest id the app actually ships, fits the
    // drawer unaided. With the wrap read in place a too-short fixture now makes that arm RED at
    // the one-line height rather than falsely green, so what this buys is a legible failure:
    // "the fixture stopped overshooting" instead of "the scope id fits on one line". `BLOCK_SCOPE_TO_OAUTH_BIT` is the registry every scope is
    // declared in, so this is the authoritative population rather than a sample.
    const realIds = Object.keys(BLOCK_SCOPE_TO_OAUTH_BIT);
    expect(
      realIds.length,
      'the scope registry is empty — this control checks nothing'
    ).toBeGreaterThan(5);
    const longestReal = Math.max(...realIds.map((s) => s.length));
    expect(
      fixture.longScope.length,
      `the fixture id is ${fixture.longScope.length} chars against a longest real id of ` +
        `${longestReal} — it has to EXCEED the real population or it fits unaided`
    ).toBeGreaterThan(longestReal);
    // …and the own-line arm's scope must actually HAVE a description, or that arm measures
    // the "(no description)" italic instead of the thing it is named for.
    expect(SCOPE_DESCRIPTIONS[fixture.describedScope]).toBeTruthy();
  });

  test('🔴 the drawer really is ~408px of container inside a 2560 window', async () => {
    // The PRECONDITION for reading anything below as a container claim. Without it, "the panel
    // is stacked at 2560" would also be satisfied by a drawer that rendered full-bleed. An
    // INVARIANT guard, not a regression pin: nothing in this change can move Mantine's drawer
    // size, and it is here so the other arms' container is a measured number rather than a
    // remembered one.
    await renderDrawer(WIDE);
    assertDrawerDoesNotScroll();
    expect(px(drawerBody().getBoundingClientRect().width)).toBe(DRAWER_BORDER_BOX);
    // The border box is the drawer's declared size; the 32px difference is the body's own
    // padding, which is why the container query sees 408 and not 440.
    const content = drawerContent();
    expect(px(content.width)).toBe(DRAWER_CONTENT_BOX);
    // The two reads above are the whole container claim: 408 of container inside a window this
    // arm has already asserted is 2560. ⚠️ A third assertion on their DIFFERENCE was written and
    // deleted — both operands are pinned two lines up, so `2560 - 408 > 2000` cannot fail unless
    // one of them already has. Moving a tautology's operands does not stop it being one.
    await cleanup();
  });

  test("🔴 the drawer's activity feed renders the STACKED variant, and the wide page does not", async () => {
    // 🔴 ONE DOM, TWO LAYOUTS — so the contrast is read off `display`, not off two different
    // element trees. A second JSX branch is how the two renderings come to disagree, which is
    // the hazard `AppPermissionsActivityDrawer`'s own docblock names about its `App` column.
    await renderDrawer(WIDE);
    expect(getComputedStyle(activityTable()).display, 'the drawer table is still a table').toBe(
      'block'
    );
    expect(getComputedStyle(need<HTMLElement>('.mantine-Drawer-body thead')).display).toBe('none');
    expect(getComputedStyle(stackedRow()).display).toBe('grid');

    // 🔴 THE CARD'S READING ORDER, which is the user-visible product of the change and which no
    // `display` read can see. The DOM order is the table's (When · App · Action · Detail ·
    // Status); `grid-template-areas` re-lays it as time+status, then the action sentence, then
    // the app, then the technical ref. Deleting the areas block auto-places the cells in DOM
    // order into two tracks, which satisfies every other assertion in this file.
    const rect = (name: string) => stackedCell(name).getBoundingClientRect();
    const [when, status, action, app, detail] = ['when', 'status', 'action', 'app', 'detail'].map(
      rect
    );
    expect(px(Math.abs(when.top - status.top)), 'time and status are not on one line').toBeLessThan(
      2
    );
    expect(status.left, 'status is not to the RIGHT of the time').toBeGreaterThan(when.right);
    // …at the card's trailing edge, which comes from the TRACK rather than from a
    // `justify-self` (that declaration was written, measured inert and deleted — see the CSS).
    expect(
      px(drawerContent().right - status.right),
      "the status pill is not at the card's trailing edge"
    ).toBeLessThan(2);
    expect(action.top, 'the action sentence is not below the header line').toBeGreaterThanOrEqual(
      when.bottom - 0.5
    );
    expect(app.top, 'the app name is not below the action').toBeGreaterThanOrEqual(
      action.bottom - 0.5
    );
    expect(detail.top, 'the technical ref is not the footer').toBeGreaterThanOrEqual(
      app.bottom - 0.5
    );
    await cleanup();

    // The SAME panel, the SAME viewport, no drawer: unchanged.
    const { observed } = await renderAtViewport(
      <AppsPageLayout title="Fixture">
        <AppActivityPanel />
      </AppsPageLayout>,
      WIDE
    );
    expect(observed).toEqual({ width: WIDE.width, height: WIDE.height });
    expect(getComputedStyle(need<HTMLElement>('table')).display).toBe('table');
    expect(getComputedStyle(need<HTMLElement>('table thead')).display).toBe('table-header-group');
    await cleanup();
  });

  test('🔴 …and nothing in the stacked feed paints outside the 408px container', async () => {
    // The defect itself, stated as a relationship rather than as a pixel count: ~735px of
    // max-content in 408px of box. `<td>` is `overflow: visible`, so an over-wide cell is
    // DRAWN over its neighbour rather than clipped — there is no scrollbar to notice it by.
    await renderDrawer(WIDE);
    assertDrawerDoesNotScroll();
    const content = drawerContent();
    // Re-read the container here rather than trusting the arm above: an overflow claim measured
    // against a box that itself shrank would be satisfied by the wrong thing.
    expect(px(content.width)).toBe(DRAWER_CONTENT_BOX);
    const offenders: string[] = [];
    const boxes = Array.from(drawerBody().querySelectorAll<HTMLElement>('tbody tr, tbody td'));
    // Exactly one row of five cells plus the row itself; a lost column trips this rather than
    // quietly shrinking what is measured.
    expect(boxes.length, 'the stacked feed did not render one row of five cells').toBe(6);
    for (const el of boxes) {
      const box = el.getBoundingClientRect();
      if (px(box.right - content.right) > 0.5) {
        offenders.push(`${el.tagName}[${el.dataset.activityCell ?? '-'}] right=${px(box.right)}`);
      }
      // A second reading of the same property, kept because it is two lines — but NOT a second
      // independent detector: the killing mutants all fire the right-edge branch above, and
      // Chromium does not report overflow through `scrollWidth` on an `overflow: visible` box.
      if (el.scrollWidth > el.clientWidth + 0.5) {
        offenders.push(
          `${el.tagName}[${el.dataset.activityCell ?? '-'}] paints ${el.scrollWidth}px into ` +
            `${el.clientWidth}px`
        );
      }
    }
    // ⚠️ AND WHAT THIS LOOP CANNOT SEE, so its name is not read wider than it is: the `app`
    // cell's name carries Tailwind `truncate`, so a long app name ELLIPSISES inside the cell
    // rather than painting past it. That is a truncation of a self-describing string in a column
    // that is a label in this mount (every row is the same app), not an overflow — and a glyph
    // read cannot tell the two apart on a `nowrap` + `overflow: hidden` box.
    expect(offenders, `container content right edge ${px(content.right)}`).toEqual([]);
    const table = activityTable();
    expect(table.scrollWidth).toBeLessThanOrEqual(table.clientWidth + 0.5);

    // 🔴 THE UNBROKEN-TOKEN CELLS, POKED IN DIRECTLY — and the direct poke is the point rather
    // than a shortcut. They render an app-chosen storage key (`z.string().max(200)`, no
    // whitespace requirement) or a workflow id, i.e. an unbounded string with no break
    // opportunity, and `overflow-wrap: anywhere` is the only thing keeping it inside the card.
    // The shared trpc fixture at the top of this file cannot carry such a token: it would widen a
    // column at 768 and move the ≥768 single-line baseline the `no-surplus` exemption rests on,
    // which four other arms measure. Writing the string into the rendered cell measures the
    // shipped rule on the shipped element without touching that baseline.
    //
    // 🔴 READ ON THE GLYPHS, NOT ON THE CELL. The `<td>` is a grid item in a `minmax(0, 1fr)`
    // track, so its own box is inside the container whether or not its text is — measured, a
    // cell-box read passed with `overflow-wrap` deleted. A `Range` over the text contents is the
    // ink, which is what a reader sees painted over the drawer's edge.
    //
    // BOTH cells that can carry one: `detail` renders the key or a workflow id, and `action`'s
    // sentence INTERPOLATES the same key for the three `storage.*` cases (`describeBlockAction`),
    // which is why the CSS hardens the pair rather than `detail` alone.
    for (const name of ['detail', 'action'] as const) {
      const cell = stackedCell(name);
      // 🔴 THE POKE REPLACES THE CELL'S SUBTREE, SO PIN WHAT IT IS REPLACING. If either cell ever
      // wraps its text in a `<Code>` or a `lineClamp` element — the likeliest way clipping returns
      // — writing `textContent` would DELETE that element and the arm would still pass.
      expect(cell.childElementCount, `the ${name} cell is no longer a single text element`).toBe(1);
      const text = cell.firstElementChild;
      if (!(text instanceof HTMLElement)) throw new Error(`the ${name} cell rendered no element`);
      // 🔴 THE LEAF CHECK IS THE ONE THAT MATCHES THE HAZARD, and the count above does not: every
      // spelling of "the token gained a wrapper" keeps the CELL at one element child
      // (`<Text><Code>{key}</Code></Text>`, or a straight `Text` -> `Code` swap), so only reading
      // the POKED element's own children can see the element this write would delete. Both are
      // kept — the count catches a SECOND element, which this does not.
      expect(
        text.children.length,
        `the ${name} cell's text element now has children, which the poke would delete`
      ).toBe(0);
      text.textContent = `key-${'w'.repeat(70)}`;
      await nextLayout();
      // 🔴 THE EDGE IS RE-DERIVED AFTER THE POKE. It roughly doubles the row's height, and if that
      // ever makes the drawer scroll, the real content edge moves ~15px LEFT while a cached one
      // stays further right — the read would get quietly MORE permissive in exactly the case
      // `assertDrawerDoesNotScroll` exists to rule out.
      assertDrawerDoesNotScroll();
      const edge = px(drawerContent().right);
      const inkRange = document.createRange();
      inkRange.selectNodeContents(text);
      expect(
        px(inkRange.getBoundingClientRect().right),
        `a 74-character unbroken key in the ${name} cell paints to ` +
          `${px(inkRange.getBoundingClientRect().right)} past a ${edge} container edge — it must ` +
          'break mid-token'
      ).toBeLessThanOrEqual(edge + 0.5);
    }
    await cleanup();
  });

  /**
   * The LEAF element whose entire text is `scope` — i.e. Mantine's Badge label, which is where
   * `white-space: nowrap; overflow: hidden; text-overflow: ellipsis` lives.
   *
   * Located by TEXT so the arm can be watched fail on the pre-change component; `scopeBadge`
   * then climbs to the Badge ROOT by its Mantine static class rather than by `parentElement`,
   * because a future Badge that wraps its text in an inner span would make `parentElement` the
   * label itself — a box that trivially contains its own child, i.e. the `h="auto"` assertion
   * would pass with the clipping root unmeasured.
   */
  function scopeLabel(scope: string): HTMLElement {
    const hits = Array.from(document.querySelectorAll<HTMLElement>('*')).filter(
      (el) => el.children.length === 0 && el.textContent === scope
    );
    if (hits.length !== 1) {
      throw new Error(`expected exactly one leaf carrying "${scope}", found ${hits.length}`);
    }
    return hits[0];
  }

  function scopeBadge(scope: string): HTMLElement {
    const root = scopeLabel(scope).closest<HTMLElement>('.mantine-Badge-root');
    if (!root) throw new Error(`the leaf carrying "${scope}" is not inside a Mantine Badge`);
    return root;
  }

  /**
   * Measured heights of a Mantine `Badge size="sm"` with the fix in place. The LABEL's one-line
   * box is `--badge-lh` = `--badge-height-sm` − 2px = 16; the ROOT is the 18px `--badge-height-sm`
   * (2px of transparent border under `border-box` on top of the 16px line).
   */
  const BADGE_LABEL_ONE_LINE = 16;
  const BADGE_ROOT_ONE_LINE = 18;

  test('🔴 the over-long scope id renders in FULL and is not clipped', async () => {
    await renderDrawer(WIDE);
    // This arm reads the container's content edge too, so it needs the same precondition — a
    // scrollbar here would fail it with a message about the scope id.
    assertDrawerDoesNotScroll();
    const label = scopeLabel(fixture.longScope);
    // `textContent` is the whole id whether or not it is ellipsised — CSS truncation is a
    // RENDERING — so it is a sanity read on what is being measured, not the test.
    expect(label.textContent).toBe(fixture.longScope);
    // 🔴 TRUNCATION HAS TWO SHAPES AND EACH NEEDS ITS OWN READ — plus the direct one, which is
    // only available on the label. Mantine's label carries `overflow: hidden`, so
    // `scrollWidth > clientWidth` on THAT box is the canonical Chromium ellipsis detector; the
    // cells in the overflow arm are `overflow: visible`, where Chromium reports nothing through
    // it, which is why that arm cannot use this read and this one can.
    expect(
      label.scrollWidth,
      `the scope id paints ${label.scrollWidth}px into ${label.clientWidth}px of label — ` +
        "Mantine's Badge is ellipsising it"
    ).toBeLessThanOrEqual(label.clientWidth + 0.5);
    //
    // (a) the label paints PAST the drawer. No mutant in the sweep reaches this today, because
    // Mantine's own `overflow: hidden` clips instead — it fired at 2578.59 against a 2544.5 edge
    // on a revision that also set `overflow: visible`, which is the shape a future "fix" for an
    // ellipsis report would reintroduce.
    expect(
      px(label.getBoundingClientRect().right),
      `the scope id paints past the drawer's ${px(drawerContent().right)} content edge`
    ).toBeLessThanOrEqual(px(drawerContent().right) + 0.5);
    // (b) the HEIGHT observable — the control on (a) and on the direct read above rather than a
    // third detector: this id needs more than one line at 408px, so a fixture that stopped
    // overshooting fails HERE with a legible message instead of making the other two vacuous. Measured, removing either `whitespace-normal` or `break-all` from the
    // Badge's `classNames` fails here at the 16px one-line height. It is also the control that
    // stops (a) being vacuous — with a 47-char fixture the whole arm passed with the ellipsis
    // still in the component, because that id fit unaided.
    expect(
      px(label.getBoundingClientRect().height),
      "the scope id fits on one line, which at this length means Mantine's Badge ellipsised it"
    ).toBeGreaterThan(BADGE_LABEL_ONE_LINE * 1.5);
    // …and the BADGE grew with it. Mantine pins the root to one line and clips, so without
    // `h="auto"` the wrapped second line is cut off — a read no width assertion and no
    // `scrollWidth` can see. Measured: the label runs to 196.19 inside a badge ending at 189.19.
    const badge = scopeBadge(fixture.longScope);
    expect(
      px(badge.getBoundingClientRect().bottom),
      `the label runs to ${px(label.getBoundingClientRect().bottom)} while its badge ends at ` +
        `${px(badge.getBoundingClientRect().bottom)}`
    ).toBeGreaterThanOrEqual(px(label.getBoundingClientRect().bottom) - 0.5);
    await cleanup();
  });

  test("🔴 the status pill's screen-reader prefix is HIDDEN, not painted", async () => {
    // 🔴 THE ONLY TIER THAT CAN SEE THIS. `ScopeStatusBadge` names its bare integer with a
    // `<span className="sr-only">HTTP status </span>`, and both DOM-level assertions on it (the
    // cross-mount cell ledger and the span's own text) are satisfied by a span that PAINTS — the
    // `component` tier loads no Tailwind, so `sr-only` is inert there by construction. If the
    // utility ever stops being emitted (a dynamically-composed class, a content-glob change, a
    // move to an unscanned file) every activity row would read "HTTP status 200" in both mounts.
    // ⚠️ NOT "and nothing else would go red" — an earlier revision said that and it is false. A
    // visible prefix widens the Status column at ≥768 and takes the row 36.19 -> 48.09, so four of
    // the `no-surplus` arms die too. What THIS arm buys is the only failure that NAMES the cause:
    // those four read as a ledger regression, and none of them reads the 408px drawer at all.
    await renderDrawer(WIDE);
    const sr = need<HTMLElement>('.mantine-Drawer-body [data-activity-cell="status"] .sr-only');
    expect(sr.textContent).toBe('HTTP status ');
    const srStyle = getComputedStyle(sr);
    expect(srStyle.position, 'the sr-only prefix is in flow').toBe('absolute');
    // `overflow` as well as the box: an `sr-only` that kept `position`/`width` but lost its clip
    // would paint the prefix over the integer while every box read below still passed. That needs
    // a hand-written override rather than a purge, so it is defence rather than the named hazard.
    expect(srStyle.overflow, 'the sr-only prefix is not clipped').toBe('hidden');
    expect(
      px(sr.getBoundingClientRect().width),
      `the screen-reader prefix paints ${px(sr.getBoundingClientRect().width)}px wide`
    ).toBeLessThan(2);
    await cleanup();
  });

  /**
   * 🔴 THE PAGE MOUNT ALSO STACKS, AND EVERY ARM ABOVE READS THE DRAWER. The query container is
   * the panel, so the card variant fires at any container under 560px — and `/apps/activity` is
   * phone-reachable, where the apps container leaves ~358px. That rendering was unmeasured while
   * this block's own arm name ("…and the wide page does not") read as though stacked were
   * drawer-only. Same `PHONE` fixture the card-grid arm at the foot of this file uses.
   */
  test('🔴 …and the WHOLE-ACCOUNT feed stacks on a phone, inside its container', async () => {
    const PHONE = { width: 390, height: 844 } as const;
    const { observed } = await renderAtViewport(
      <AppsPageLayout title="Fixture">
        <AppActivityPanel />
      </AppsPageLayout>,
      PHONE
    );
    expect(observed).toEqual({ width: PHONE.width, height: PHONE.height });
    // 🔴 THE DISPLAY READS COME FIRST, AND THAT ORDER IS THE POINT — see this block's docblock.
    // `table` / `tbody tr` resolve on the pre-change component, so at base this arm fails on
    // `expected 'table' to be 'block'`. The panel's testid does NOT exist at base, so leading with
    // it would make the arm red on a missing hook — the exact failure the docblock forbids, on the
    // arm it warns the next author about.
    expect(getComputedStyle(need<HTMLElement>('table')).display).toBe('block');
    expect(getComputedStyle(need<HTMLElement>('tbody tr')).display).toBe('grid');
    const panelEl = need<HTMLElement>('[data-testid="app-activity-panel"]');
    const width = px(panelEl.getBoundingClientRect().width);
    // The positive control: this container really is under the 560px threshold, so the arm can
    // see the variant rather than asserting it at a width where it would apply anyway.
    expect(width, 'the phone container is not below the stacking threshold').toBeLessThan(560);
    const right = panelEl.getBoundingClientRect().right;
    const offenders = Array.from(panelEl.querySelectorAll<HTMLElement>('tbody tr, tbody td'))
      .filter((el) => px(el.getBoundingClientRect().right - right) > 0.5)
      .map((el) => `${el.tagName}[${el.dataset.activityCell ?? '-'}]`);
    expect(offenders, `phone container ${width}px, right edge ${px(right)}`).toEqual([]);
    await cleanup();
  });

  test('🔴 the description sits on its own line, and nearer its OWN id than the next one', async () => {
    await renderDrawer(WIDE);
    // Located by text, not by the list's testid, so this arm is red at base on GEOMETRY — at
    // `origin/main` the description shares a `wrap="nowrap"` row with the badge, so its top is
    // ABOVE the badge's bottom rather than below it.
    const describedBadge = scopeBadge(fixture.describedScope);
    const description = scopeLabel(SCOPE_DESCRIPTIONS[fixture.describedScope]);
    const badgeBottom = describedBadge.getBoundingClientRect().bottom;
    const intra = px(description.getBoundingClientRect().top - badgeBottom);
    expect(
      intra,
      'the description is beside its id, not under it — the two fight over one axis and the ' +
        'id loses'
    ).toBeGreaterThanOrEqual(0);
    // Guard the guard: a zero-height description would satisfy the above trivially.
    expect(px(description.getBoundingClientRect().height)).toBeGreaterThan(8);

    // 🔴 AND THE GROUPING IS UNAMBIGUOUS: the gap from a description UP to its own id must be
    // smaller than the gap DOWN to the next scope's id. Two `Stack`s at 4/2 made that a 2px
    // differential on a list whose entire purpose is which description belongs to which id.
    //
    // 🔴 `inter` IS MEASURED FROM THE PREVIOUS ROW'S **LAST CHILD**, NOT FROM THE DESCRIPTION —
    // AND READING IT FROM THE DESCRIPTION MADE THIS ARM VACUOUS THE MOMENT PHASE 3 LANDED.
    // Until then the description WAS the row's last child, so `nextBadge.top − description.bottom`
    // really did measure the outer `Stack gap`. Phase 3's `ScopeConsentList` adds a THIRD child to
    // every row (the revoke control, or an exempt note), and for this fixture's described scope
    // that child is a two-line note sitting INSIDE the span being measured. `inter` then became
    // ≈40px dominated by the note's own height — a quantity independent of either `Stack` gap — so
    // collapsing the outer gap back to `2`, or even to `0`, still satisfied `inter > intra * 2`
    // with an order of magnitude to spare. The arm was passing over a list with NO grouping cue at
    // all, which is the exact defect it was written to reject. Found by the test-review lane.
    //
    // Reading from the last child restores the property: the span contains nothing but the outer
    // gap again, whatever children a row grows in future.
    const prevRow = description.closest<HTMLElement>('[data-testid="block-scope-list"] > *');
    if (!prevRow) throw new Error('the description is not inside a scope row');
    const prevRowLastChild = prevRow.lastElementChild;
    if (!prevRowLastChild) throw new Error('the scope row has no children');
    // A POSITIVE CONTROL ON THE FIX: phase 3 must really have added a third child, or this arm has
    // silently gone back to measuring from the description and the paragraph above is stale.
    // `>= 3`, not `=== 3`: the exact count is an incidental quantity (a `revoked` or `revokable` row
    // also has three children, and an `unknown` row has two), while the real guard is the
    // `.not.toBe(description)` line below. An exact count would red on a safe change to the row's
    // internals and its message would misdescribe the cause. Round-2 test-lane nit.
    expect(
      prevRow.children.length,
      'the scope row has no consent child — re-read the comment above, this arm may be measuring ' +
        'from the description again'
    ).toBeGreaterThanOrEqual(3);
    expect(prevRowLastChild, "the description is still the row's last child").not.toBe(description);
    const nextBadge = scopeBadge(fixture.longScope);
    const inter = px(
      nextBadge.getBoundingClientRect().top - prevRowLastChild.getBoundingClientRect().bottom
    );
    // DOUBLE, not merely greater: the shape this rejects is the original 4/2 pair, where `inter`
    // WAS larger than `intra` and the cue was still a 2px differential on a block that grows to
    // ~36px as soon as an id wraps. A ratio is the weakest honest reading of "clearly nearer".
    expect(
      inter,
      `a description sits ${intra}px from its own id and the row ends ${inter}px from the next ` +
        'one — a differential under 2x is not a grouping cue, and the reader pairs it with either'
    ).toBeGreaterThan(intra * 2);

    // 🔴 AN INVARIANT GUARD, NOT REGRESSION COVERAGE, and labelled as one: a single-line badge
    // is 18px at base AND with `h="auto"` (the root is sized by its 16px label plus 2px of
    // border either way), so no mutation of this change can move it. What it pins is narrow and
    // worth having anyway — a one-line badge is the same HEIGHT as before, so the badge half of
    // the fix costs the other three call sites nothing per row. ⚠️ It says nothing about those
    // sites overall: the restructure and the outer gap DO change them, by about a line per
    // scope, and nothing measures their geometry.
    expect(px(describedBadge.getBoundingClientRect().height)).toBe(BADGE_ROOT_ONE_LINE);
    await cleanup();
  });

  /**
   * 🔴 PHASE 3 — THE REVOKE CONTROL MUST NOT REINTRODUCE THE TRUNCATION PHASE 1 REMOVED.
   *
   * This is the arm the phase-3 change exists to be checked by, and the hazard is specific rather
   * than general: the ONE place a control could have gone is inside `BlockScopeList`'s
   * `wrap="nowrap"` badge `Group`, beside the id. That Group's items share a single inline axis and
   * Mantine clamps the Badge root to the inline space left over, so a sibling button in there takes
   * width directly from the scope id at 408px — which is the exact axis phase 1 bought back. The
   * implementation puts the affordance on its OWN line beneath the description instead, and this
   * arm is what makes that a measured property rather than an intention in a comment.
   *
   * ⚠️ IT IS NOT A DUPLICATE OF THE CLIPPING ARM ABOVE. That one reads the same box on a tree with
   * NO consent layer; the fixture now carries one, so both arms run against the consent-bearing
   * tree and this one adds the two reads that are only meaningful with a control present — the
   * button really rendered, and it did not land on the id's row.
   */
  test('🔴 the revoke control does not narrow the scope id — still unclipped at 408px', async () => {
    await renderDrawer(WIDE);
    // Same precondition as every arm here: a scrollbar takes ~15px off the body's inner width and
    // would fail this with a message about the scope id. It matters MORE now — the consent layer
    // adds a row per scope, so the drawer is taller than the arms above were written against, and
    // if that ever pushes it into scrolling this is where it says so.
    assertDrawerDoesNotScroll();

    // (a) THE CONTROL IS ACTUALLY THERE. Without this the rest of the arm is vacuous: a drawer
    // that rendered no button trivially does not narrow anything, and this file's own docblock
    // warns that leading with a hook this change introduces makes an arm red at base for the wrong
    // reason — so it is asserted HERE rather than in the locator that opens the arm.
    const control = need<HTMLElement>('.mantine-Drawer-body [data-testid="scope-revoke-button"]');
    expect(control.dataset.scope, 'the control is on the wrong scope').toBe(fixture.revokableScope);
    // Exactly one, matching the single-entry `revokableScopes` — a control on an exempt row would
    // be a lie, and the component tier asserts that by name. Here it keeps the geometry claim
    // attributable to one box.
    expect(
      drawerBody().querySelectorAll('[data-testid="scope-revoke-button"]'),
      'more controls than the fixture makes revokable'
    ).toHaveLength(1);

    // (b) IT IS NOT ON THE BADGE'S ROW. The structural half of the hazard, read off the DOM rather
    // than off geometry, because it is the thing that would CAUSE the narrowing: the control must
    // not sit inside the `wrap="nowrap"` Group that holds the id.
    //
    // 🔴 ASSERTED AS AN IDENTITY AGAINST THE ROW, NOT AS A `querySelector` OFF
    // `parentElement.parentElement`. The walk-and-look-for-a-badge form encoded an UNCHECKED DOM
    // DEPTH — it is correct only while exactly one wrapper sits between the button and the row
    // (today `ScopeConsentAction`'s `<Group>`). Remove that wrapper as a pure refactor AND move the
    // node into the nowrap Group and the walk lands on the row `Stack`, where the badge is not a
    // direct child — so the old `toBeNull()` passed and the exact hazard shipped. Add a wrapper and
    // it lands one level too shallow, same result. Comparing against `controlRow` (which the
    // previous version computed and then threw away) pins the depth itself. Found by the
    // test-review lane.
    const controlRow = control.closest<HTMLElement>('[data-testid="block-scope-list"] > *');
    if (!controlRow) throw new Error('the revoke control is not inside a scope row');
    // ⚠️ A `control.parentElement?.parentElement === controlRow` ASSERTION WAS HERE AND IS DELETED.
    // Round 1 added it to replace a `querySelector` off the same walk, on the grounds that the walk
    // encoded an unchecked DOM depth — which was true of the querySelector form. But as an identity
    // check it buys ZERO additional hazard coverage: `controlRow` is derived from `control`, so it
    // cannot catch a cross-row misplacement either, and the depth-independent read below already
    // covers the whole hazard at any depth. What it WOULD do is red on the pure refactor of removing
    // `ScopeConsentAction`'s wrapper `<Group>`. Reported by the round-2 test lane; a guard whose only
    // effect is a false alarm on a safe change is worse than no guard.
    // ⚠️ A THIRD ASSERTION STOOD HERE AND IS DELETED AS A TAUTOLOGY — `controlRow.contains(control)`.
    // `controlRow` is `control.closest(...)`, which returns the element itself or an ancestor, and
    // `Node.contains` is true for self and for descendants — so it was TRUE UNDER EVERY POSSIBLE DOM,
    // including with the control moved into the badge group (the hazard) or into a DIFFERENT row. The
    // only falsifiable branch (`closest` → null) is already consumed by the `throw` above it, which
    // carries a different message. Round 2 replaced a useless depth check with a line that read as a
    // row-identity guard and checked nothing at all; the round-3 test lane measured it in jsdom.
    // The hazard is fully covered by the read below, which is depth-independent and genuinely
    // falsifiable.
    // The real check: the badge's own parent must not contain it.
    const badgeGroup = scopeBadge(fixture.revokableScope).parentElement;
    expect(badgeGroup, 'the badge has no parent Group').not.toBeNull();
    expect(
      badgeGroup!.contains(control),
      "the revoke control shares the badge's nowrap Group — it will take inline width from the id"
    ).toBe(false);

    // ⚠️ THE OVER-LONG ID'S THREE CLIPPING READS ARE DELIBERATELY *NOT* REPEATED HERE. An earlier
    // revision of this arm re-measured `scrollWidth`/height/right edge with a paragraph claiming
    // *"that one reads the same box on a tree with NO consent layer"* — and the second half of that
    // sentence defeated the first: this change adds the consent fields to the SHARED `DATA` row, so
    // the pre-existing clipping arm above now runs against the consent-bearing tree too and those
    // three reads were straight re-runs of it. The real content of this arm is (a) (b) (d) (e).
    // Found by the test-review lane.

    // (d) NOTHING IN THE CONSENT LAYER PAINTS OUTSIDE THE 408px CONTAINER. The affordances are new
    // boxes at this width — a button, and the generic note, which is the longest sentence the
    // vocabulary can put on a row — and a note that overflows is exactly the shape that reads as
    // "the drawer is broken" without any id being clipped.
    const edge = px(drawerContent().right);
    const offenders = Array.from(
      drawerBody().querySelectorAll<HTMLElement>(
        '[data-testid="scope-revoke-button"], [data-testid="scope-fixed-note"], ' +
          '[data-testid="scope-revoked-row"], [data-testid="scope-revoked-at"]'
      )
    )
      .filter((el) => px(el.getBoundingClientRect().right) > edge + 0.5)
      .map((el) => `${el.dataset.testid ?? el.tagName}@${px(el.getBoundingClientRect().right)}`);
    expect(offenders, `drawer content edge ${edge}`).toEqual([]);

    // (e) EVERY ROW HAS AN AFFORDANCE OR AN EXPLANATION — no silent row. A count relationship, not
    // a literal: it fails if the fixture grows a scope the consent layer says nothing about.
    const rows = Array.from(
      drawerBody().querySelectorAll<HTMLElement>('[data-testid="block-scope-list"] > *')
    );
    expect(rows, 'the fixture rendered no scope rows').toHaveLength(3);
    const silent = rows.filter(
      (row) =>
        !row.querySelector(
          '[data-testid="scope-revoke-button"], [data-testid="scope-fixed-note"], ' +
            '[data-testid="scope-revoked-row"]'
        )
    );
    expect(
      silent.map((r) => r.textContent?.slice(0, 40)),
      'rows with no consent affordance'
    ).toEqual([]);
    await cleanup();
  });

  /**
   * 🔴 THE STRIKE-THROUGH IS A COMPUTED STYLE, AND THIS IS THE ONLY TIER THAT CAN SEE IT.
   * `line-through` is a Tailwind utility, and the `component` tier loads no Tailwind — so the
   * component test asserting the CLASS is a claim about the class attribute, not about ink on the
   * screen. If the utility ever stops being emitted (a dynamically-composed class name, a content-
   * glob change, a move to an unscanned file) a withdrawn permission would render identically to a
   * live one on both surfaces, and only this read would notice. Same argument the `sr-only` arm
   * above makes for the status pill.
   */
  test('🔴 a REVOKED scope id is really struck through, not merely classed', async () => {
    // A LOCAL fixture override — the shared `DATA` row deliberately has an empty `revokedScopes`
    // so every arm above measures the ordinary case. Mutated IN PLACE (see `fixture.drawerRevoked`),
    // because `DATA` captured this array by reference, and restored in a `finally` so a failure
    // here cannot leave every later arm measuring a struck badge.
    fixture.drawerRevoked.push(fixture.revokableScope);
    try {
      await renderDrawer(WIDE);
      const label = scopeLabel(fixture.revokableScope);
      expect(
        getComputedStyle(label).textDecorationLine,
        'the withdrawn scope id is not struck through — a revoked permission looks live'
      ).toContain('line-through');
      // The POSITIVE CONTROL on that read: a row that is NOT revoked must come back clean, or the
      // assertion above is satisfied by a stylesheet striking every badge in the list.
      expect(
        getComputedStyle(scopeLabel(fixture.longScope)).textDecorationLine,
        'a live scope id is struck through too — the strike is not keyed on the revoked row'
      ).not.toContain('line-through');
      // …and the withdrawn row keeps its marker rather than only its styling.
      expect(
        drawerBody().querySelector('[data-testid="scope-revoked-mark"]'),
        'the withdrawn row has no "Removed" marker'
      ).not.toBeNull();
      // …and offers no control, since there is nothing left to withdraw.
      expect(
        drawerBody().querySelector(
          `[data-testid="scope-revoke-button"][data-scope="${fixture.revokableScope}"]`
        ),
        'a withdrawn permission still offers a Remove button'
      ).toBeNull();
      await cleanup();
    } finally {
      fixture.drawerRevoked.length = 0;
    }
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
    { name: '/apps/review queue', ui: reviewList },
    // 🔴 BOTH SHAPES, because they are two different ledgers over two different column
    // sets. The eight-column one is only reachable on the Approved tab, so an arm that
    // mounts the seven-column shape alone leaves the other's shares unmeasured.
    { name: '/apps/review queue (approved shape, with Deploy)', ui: reviewListWithDeploy },
    { name: '/apps/review previews', ui: () => <ActivePreviewsPanel /> },
    { name: '/apps/mine', ui: () => <MyAppsBodyView rows={[MINE_ROW]} /> },
  ] as const;

  test('the case list covers every LEDGERED table this file can mount', () => {
    // A loop over a list nobody pinned passes vacuously when the list shrinks.
    expect(CASES.map((c) => c.name)).toEqual([
      '/apps/review queue',
      '/apps/review queue (approved shape, with Deploy)',
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

// ── /apps/activity — the 640px dead gap ─────────────────────────────────────

describe('/apps/activity — the space-between row keeps its control near its content', () => {
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

/**
 * 🔴 RAIL-OPEN — the ONE arm in this file that renders the chrome the rest of it stubs
 * away, and the partial answer to the gap stated at the top.
 *
 * Everything above measures a wide-layout mechanism against a CONTENT WIDTH, with the rail
 * removed via the `< 2 sections` collapse so the four fixture widths keep meaning what
 * they say. That is the right scoping for those claims and the wrong scoping for one
 * question: what does a real viewer with an OPEN rail actually get? The rail takes 276px
 * off the body on every `/apps/*` route, so a 1440 monitor hands these components 1132 of
 * content and a 2560 one hands them 2252.
 *
 * This block measures that directly, at the one place it changes a PRODUCT outcome rather
 * than a pixel: the `/apps/activity` card list's column count, which is what
 * `APPS_CARD_LIST_MIN_COLUMN` exists to control. The constant moved 1200 → 1100 in this
 * same change precisely because at 1200 the second column stopped arriving AT ALL once the
 * rail was open — the 640px content-to-control gap the constant exists to close reopened
 * on exactly the monitors it was written for.
 *
 * ⚠️ TWO ARMS, NOT A BATTERY. This does not re-measure the tables above at 1132; that
 * remains genuinely uncovered, and the accepted consequence is recorded on
 * `SUBMISSIONS_TABLE_MIN_WIDTH` (the `/apps/build` table scrolls one viewport step
 * earlier).
 */
describe('🔴 RAIL-OPEN — the content width a real /apps viewer gets', () => {
  // A qualifying viewer, so the rail renders — set through the file's `navState` holder
  // and restored after each render, so this block cannot leak the rail into the arms above.
  const railGrid = () => (
    <AppsCardGrid testId="apps-installed-apps-grid">
      <InstalledAppCard app={INSTALLED_APP} onManage={vi.fn()} />
      <InstalledAppCard app={INSTALLED_APP} onManage={vi.fn()} />
    </AppsCardGrid>
  );

  async function renderWithRail(viewport: { width: number; height: number }) {
    const registry = await import('~/components/Apps/apps-sections');
    navState.sections = registry.appsSections.slice(0, 2);
    try {
      const { observed } = await renderAtViewport(
        <AppsPageLayout title="Fixture">{railGrid()}</AppsPageLayout>,
        viewport
      );
      expect(observed).toEqual({ width: viewport.width, height: viewport.height });
      const rail = document.querySelector('[data-apps-chrome="rail"]') as HTMLElement | null;
      const bodyColumn = document.querySelector(
        '[data-apps-chrome="body-column"]'
      ) as HTMLElement | null;
      const gridEl = document.querySelector('[data-apps-card-grid]') as HTMLElement;
      return {
        railShown: rail ? getComputedStyle(rail).display !== 'none' : false,
        bodyWidth: bodyColumn ? Math.round(bodyColumn.getBoundingClientRect().width) : null,
        columns: getComputedStyle(gridEl).gridTemplateColumns.split(' ').length,
      };
    } finally {
      navState.sections = [];
    }
  }

  test('the rail really is open, and the body really is 276px narrower', async () => {
    // The precondition for the column assertions below. Without it, "one column at 1440"
    // would also be satisfied by a render in which the rail never appeared.
    const narrow = await renderWithRail(NARROW);
    expect(narrow.railShown, 'the rail did not render — the section stub did not take').toBe(true);
    expect(narrow.bodyWidth).toBe(NARROW.content - 276);
    await cleanup();

    const wide = await renderWithRail(WIDE);
    expect(wide.railShown).toBe(true);
    expect(wide.bodyWidth).toBe(WIDE.content - 276);
    await cleanup();
  });

  test('🔴 the card list is ONE column at 1440 and TWO at 2560, WITH the rail open', async () => {
    // The product claim `APPS_CARD_LIST_MIN_COLUMN = 1100` exists to hold, measured in the
    // engine rather than in arithmetic. At the retired 1200 the 2560 case is ONE column —
    // that is the regression the constant change repairs, and it is invisible to every
    // other test in this file because they all render without the rail.
    const narrow = await renderWithRail(NARROW);
    expect(narrow.columns, '1440 with the rail open should stay a single column').toBe(1);
    await cleanup();

    const wide = await renderWithRail(WIDE);
    expect(
      wide.columns,
      'a 2560 monitor with the rail open fell back to ONE card column — the ' +
        'content-to-control gap APPS_CARD_LIST_MIN_COLUMN exists to close is back'
    ).toBe(2);
    await cleanup();
  });
});
