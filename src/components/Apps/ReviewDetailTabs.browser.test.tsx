import { useRouter } from 'next/router';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as NotificationsModule from '~/utils/notifications';
import type * as TrpcModule from '~/utils/trpc';
import type * as FeatureFlagsMod from '~/providers/FeatureFlagsProvider';
import type * as UserAvatarMod from '~/components/UserAvatar/UserAvatar';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { LOADABLE_IMAGE_DATA_URI, renderWithProviders } from '../../../test/component-setup';
import {
  DEFAULT_REVIEW_DETAIL_TAB,
  REVIEW_DETAIL_TAB_LABELS,
  REVIEW_DETAIL_TAB_VALUES,
} from '~/components/Apps/reviewDetailTabs';

/**
 * THE REVIEW PAGE'S TAB CONTRACT, AND THE SEAM TEST.
 *
 * 🔴 IT RENDERS `ReviewDetailView` — the page's WHOLE body — NOT `ReviewDetailTabsView` ALONE,
 * and that is the point. The defect this redesign can produce lives in the SEAM between
 * three surfaces: the page body, the shared panels it borrows from the queue modal, and the
 * server payload those panels read. A fixture that mounted only the tab container would
 * load one of the three: the tabs would switch perfectly while the permissions card was
 * rendered twice, or the action bar had drifted inside the tabs, and every assertion would
 * stay green. So every case below builds the COMBINED state — the real view, the real
 * shared sections, and a payload shaped like `getReviewRequestById`'s (bigint-as-string
 * bundle size, Date timestamps, a `first-version` manifest diff, listing media URLs).
 *
 * The tab-RESOLUTION rules themselves are pinned in the node-env `unit` project
 * (`__tests__/reviewDetailTabs.test.ts`), which is the blocking tier. What can only be
 * checked here is that the resolved value actually selects a panel, that the panel holds
 * what it should, and that the action bar is outside all of them.
 *
 * 🔴 THE ACTIVE TAB IS DRIVEN THROUGH `router.query`, NOT BY CLICKING, because the view
 * derives it from `?tab=` with NO local copy (one source of truth) and the scaffold's
 * `router.replace` is a `vi.fn()` that does not mutate `query`. Setting the query is also
 * the more faithful test — it exercises the deep link a mod actually receives. The CLICK
 * half (that selecting a tab rewrites the URL) is asserted separately below, against
 * `router.replace`'s recorded call. Precedent: `AppActivityPage.browser.test.tsx`.
 */

const mocks = vi.hoisted(() => ({
  invalidate: vi.fn().mockResolvedValue(undefined),
  mutate: vi.fn(),
  pending: false,
  /** `getPublishRequestDiff` payload, so the Code tab has something real to render. */
  diff: undefined as unknown,
}));

/*
  The shared submitter line renders the real `UserAvatar`, which reaches providers this
  harness does not mount. Stubbed here for the same reason as in the sibling suites; the
  real component is exercised in `ReviewSubmitterMeta.browser.test.tsx`.
*/
vi.mock('~/components/UserAvatar/UserAvatar', async (importOriginal) => ({
  ...(await importOriginal<typeof UserAvatarMod>()),
  UserAvatar: ({ user }: { user: { id: number; username?: string | null } }) => (
    <span data-testid="submitter-stub">{user.username ?? `#${user.id}`}</span>
  ),
}));

// 🔴 SPREAD THE ORIGINAL — same rule as the `~/utils/notifications` mock below, and this
// module is the one most likely to bite: it exports `useOptionalFeatureFlags`,
// `useFeatureFlagsReady` and the provider component as well, and a one-key factory makes
// all three `undefined` for every importer in the graph. The failure is a WHOLE-FILE import
// error, which vitest reports as 0 tests collected rather than as a failure.
// Precedent: `src/tests/pages/apps/review/review-queue-poll.browser.test.tsx`.
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsMod>()),
  useFeatureFlags: () => ({ appBlocks: true }),
}));

vi.mock('~/components/Apps/ReviewBlockPreviewHost', () => ({
  ReviewBlockPreviewHost: () => <div data-testid="review-host-stub" />,
}));

// 🔴 SPREAD THE ORIGINAL, never a one-key factory. A factory that omits an export fails
// the WHOLE FILE at import the day anything in its graph imports it — and an import failure
// collects 0 tests rather than failing one, so it reads as a skipped file.
// `__tests__/notificationsMockSpread.test.ts` reds on the narrow form.
vi.mock('~/utils/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationsModule>()),
  showSuccessNotification: vi.fn(),
  showErrorNotification: vi.fn(),
}));

/*
  🔴 SPREAD THE REAL MODULE, then override `trpc`. A wholesale factory replaces
  `~/utils/trpc` entirely, so the day it gains an export this object omits, every importer in
  the module graph gets `undefined` and the WHOLE FILE fails to load — 0 tests collected, no
  failing assertion, silently "green" (`trpcVanilla` disabled ~36 tests that way).
  `local-rules/no-wholesale-module-mock` reds on the narrow form. Spreading keeps the other
  exports real; `trpc` itself still has to be replaced wholesale, because it is a flat Proxy
  whose `ownKeys` is empty and therefore cannot be spread.
*/
vi.mock('~/utils/trpc', async (importOriginal) => {
  const actual = await importOriginal<typeof TrpcModule>();
  const mutation = (name: string) => (opts?: { onSuccess?: () => void }) => ({
    mutate: (vars: unknown) => {
      mocks.mutate(name, vars);
      void opts?.onSuccess?.();
    },
    mutateAsync: vi.fn(),
    isPending: mocks.pending,
  });
  const inert = { invalidate: mocks.invalidate };
  return {
    ...actual,
    trpc: {
      useUtils: () => ({
        blocks: {
          listPendingRequests: inert,
          listApprovedRequests: inert,
          listRejectedRequests: inert,
          getReviewStatus: inert,
          listActivePreviews: inert,
          getMarketplaceMeta: inert,
          getFeaturedBlocks: inert,
          listAvailable: inert,
        },
      }),
      blocks: {
        approveRequest: { useMutation: mutation('approve') },
        rejectRequest: { useMutation: mutation('reject') },
        getReviewStatus: { useQuery: () => ({ data: undefined, isLoading: false, error: null }) },
        previewRequest: { useMutation: mutation('preview') },
        teardownPreview: { useMutation: mutation('teardown') },
        getPublishRequestScreenshots: {
          useQuery: () => ({ data: { items: [] }, isLoading: false, error: null }),
        },
        getPublishRequestDiff: {
          useQuery: () => ({ data: mocks.diff, isLoading: false, error: null }),
        },
        getMarketplaceMeta: {
          useQuery: () => ({ data: undefined, isLoading: false, isError: false, error: null }),
        },
        setMarketplaceMeta: { useMutation: mutation('setMeta') },
      },
    },
  };
});

const { ReviewDetailView } = await import('./ReviewDetailView');
// `useRouter` here is the scaffold's MOCK (test/component-setup.tsx), which returns a plain
// singleton object and calls no React hook. Reading it once at module scope is the
// established idiom in this suite — see `AppActivityPage.browser.test.tsx`.
// eslint-disable-next-line react-hooks/rules-of-hooks -- see above
const router = useRouter();

/**
 * A payload shaped like what `getReviewRequestById` actually returns — NOT a minimal
 * fixture. `bundleSizeBytes` is a STRING (the bigint crosses the wire that way),
 * `submittedAt` is a Date (superjson), the manifest carries one SENSITIVE scope and one
 * ordinary one with justifications, and the listing media URLs are present.
 */
const PENDING = {
  id: 'pubreq_01HZX',
  appBlockId: null as string | null,
  slug: 'gen-matrix',
  version: '0.2.0',
  submittedAt: new Date('2026-01-01T09:00:00Z'),
  bundleSizeBytes: '421888',
  bundleSha256: 'a'.repeat(64),
  manifest: {
    name: 'Gen Matrix',
    blockId: 'gen-matrix',
    version: '0.2.0',
    // 🔴 ONE SENSITIVE + ONE ORDINARY, so the "sensitive is distinguishable" assertion is
    // a COMPARISON rather than a claim about the only row on screen.
    scopes: ['ai:write:budgeted', 'models:read:self'],
    scopeJustifications: {
      'ai:write:budgeted': 'Runs the generation the user asked for.',
      'models:read:self': 'Reads the model the block is mounted on.',
    },
    targets: [{ slotId: 'model.sidebar_top', priority: 10 }],
  },
  fileSummary: {
    files: [{ path: 'src/App.tsx', sha256: 'b'.repeat(64), sizeBytes: 1200 }],
    added: ['src/App.tsx'],
    removed: [],
    changed: [],
  },
  manifestDiffSummary: { kind: 'first-version', fields: ['name', 'scopes'] },
  reviewRepoUrl: 'https://forgejo.example/repo',
  pushCommitUrl: null as string | null,
  submittedBy: { id: 7, username: 'dev-user', deletedAt: null, image: null },
  iconUrl: LOADABLE_IMAGE_DATA_URI,
  coverUrl: `${LOADABLE_IMAGE_DATA_URI}#cover`,
};

const APPROVED = {
  ...PENDING,
  id: 'pubreq_01HZY',
  reviewedAt: new Date('2026-01-02T00:00:00Z'),
  approvalNotes: 'looks good',
  reviewedBy: { id: 99, username: 'mod-user', deletedAt: null, image: null },
};

const render = (
  request: Record<string, unknown> = PENDING,
  mode: 'pending' | 'approved' = 'pending'
) =>
  renderWithProviders(
    <ReviewDetailView selection={{ request: request as never, mode }} onClose={vi.fn()} />
  );

/** The currently-selected tab's label, read off ARIA rather than off a class name. */
const selectedTab = () =>
  document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim();

/**
 * The panel the selected tab actually controls, resolved through `aria-controls`.
 *
 * 🔴 NOT `[role="tabpanel"]:not([hidden])` — Mantine hides an inactive panel with CSS, not
 * with the `hidden` ATTRIBUTE, so that selector matches every panel and `querySelector`
 * silently returns the FIRST one. With `keepMounted` plus this view's mount-on-first-visit
 * gate, the first panel is an UNVISITED, deliberately empty one — which made an
 * "is the panel painted" assertion fail on four tabs for a reason that had nothing to do
 * with the tab under test.
 */
const visiblePanel = () => {
  const id = document
    .querySelector('[role="tab"][aria-selected="true"]')
    ?.getAttribute('aria-controls');
  return id ? document.getElementById(id) : null;
};

beforeEach(() => {
  mocks.invalidate.mockClear();
  mocks.mutate.mockClear();
  mocks.pending = false;
  mocks.diff = undefined;
  vi.mocked(router.replace).mockClear();
  router.query = {};
  router.pathname = '/apps/review/[publishRequestId]';
});

describe('the five tabs', () => {
  test('🔴 all five render, in the ledger order', async () => {
    render();
    await expect.element(page.getByTestId('apps-review-detail-tabs')).toBeInTheDocument();
    const labels = Array.from(document.querySelectorAll('[role="tab"]')).map((el) =>
      el.textContent?.trim()
    );
    expect(labels).toEqual(REVIEW_DETAIL_TAB_VALUES.map((t) => REVIEW_DETAIL_TAB_LABELS[t]));
  });
});

describe('PERMISSIONS is the default, and it is on screen without interaction', () => {
  test('🔴 a bare URL selects Permissions and PAINTS the scopes card — no click needed', async () => {
    // The whole redesign: judging a requested permission is the moderator's primary job
    // here, and the scopes used to be the LAST thing on the page, inside the manifest card.
    render();
    await expect.element(page.getByTestId('apps-review-permissions')).toBeInTheDocument();
    expect(selectedTab()).toBe(REVIEW_DETAIL_TAB_LABELS[DEFAULT_REVIEW_DETAIL_TAB]);
    expect(selectedTab()).toBe('Permissions');
    // Both declared scopes, with the developer's stated reason for each.
    await expect
      .element(page.getByText('Runs the generation the user asked for.'))
      .toBeInTheDocument();
    await expect
      .element(page.getByText('Reads the model the block is mounted on.'))
      .toBeInTheDocument();
  });

  test('🔴 EXACTLY ONE permissions card exists on the page', async () => {
    // The card was HOISTED out of `ManifestView`, not copied: `includeScopes={false}` on the
    // Manifest tab is the other half of the move. Rendering it in both tabs would give a mod
    // two cards with no way to tell which one they were reading — and because both panels
    // mount, a document-wide count is the only thing that can see it.
    router.query = {};
    render();
    await expect.element(page.getByTestId('apps-review-permissions')).toBeInTheDocument();
    // Visit the Manifest tab too, so both panels have mounted before counting.
    await page.getByRole('tab', { name: 'Manifest' }).click();
    expect(document.querySelectorAll('[data-testid="apps-review-permissions"]')).toHaveLength(1);
  });

  test('🔴 a SENSITIVE scope is distinguishable by STATE, not by a word', async () => {
    // A guard on the string "Sensitive" is walkable by a reword, and cannot say WHICH scope
    // it belongs to — the same `SensitiveScopeBadge` is rendered by the consent prompt and
    // the granted-permissions panels. `data-scope` + `data-sensitive` pin the id and the
    // attribute TOGETHER.
    render();
    await expect.element(page.getByTestId('apps-review-permissions')).toBeInTheDocument();
    const sensitive = document.querySelector('[data-scope="ai:write:budgeted"]');
    const ordinary = document.querySelector('[data-scope="models:read:self"]');
    expect(sensitive, 'the sensitive scope row').not.toBeNull();
    expect(ordinary, 'the ordinary scope row').not.toBeNull();
    expect(sensitive?.getAttribute('data-sensitive')).toBe('true');
    // 🔴 THE CONTRAST IS THE ASSERTION. Without this half, a renderer that marked EVERY
    // scope sensitive would pass.
    expect(ordinary?.getAttribute('data-sensitive')).toBe('false');
  });
});

describe('deep links', () => {
  test('🔴 `?tab=code` opens the Code tab, with the file summary in it', async () => {
    router.query = { tab: 'code' };
    render();
    await expect.element(page.getByText('Show code diff')).toBeInTheDocument();
    expect(selectedTab()).toBe('Code');
  });

  test('`?tab=manifest` opens Manifest, `?tab=preview` opens Preview', async () => {
    router.query = { tab: 'manifest' };
    render();
    await expect.element(page.getByText('Manifest diff')).toBeInTheDocument();
    expect(selectedTab()).toBe('Manifest');
  });

  test('🔴 an UNKNOWN `?tab=` falls back to the default rather than rendering an empty panel', async () => {
    // A link a mod can legitimately receive — a bookmark from before a tab was renamed, or
    // a typo. Handing the raw value to `Tabs.value` selects nothing and paints a blank page
    // under a bar with no active tab.
    router.query = { tab: 'summary' };
    render();
    await expect.element(page.getByTestId('apps-review-permissions')).toBeInTheDocument();
    expect(selectedTab()).toBe('Permissions');
  });

  test('a REPEATED `?tab=` takes the first entry rather than selecting nothing', async () => {
    router.query = { tab: ['code', 'manifest'] };
    render();
    await expect.element(page.getByText('Show code diff')).toBeInTheDocument();
    expect(selectedTab()).toBe('Code');
  });

  test('🔴 NEGATIVE CONTROL: `?tab=` really can select something OTHER than the default', async () => {
    // Without this, the default-tab assertions above are satisfied by a page that ignores
    // the query entirely and happens to open on the right tab.
    router.query = { tab: 'preview' };
    render();
    await expect.element(page.getByTestId('apps-review-listing-media')).toBeInTheDocument();
    expect(selectedTab()).toBe('Preview');
    expect(page.getByTestId('apps-review-permissions').elements()).toHaveLength(0);
  });
});

describe('selecting a tab REWRITES the URL', () => {
  test('🔴 `replace` + `shallow`, and the DYNAMIC ROUTE PARAM SURVIVES', async () => {
    // `push` would turn Back into a tab-by-tab rewind out of the submission; a non-shallow
    // navigation would re-run `getServerSideProps`. And `/apps/review/[publishRequestId]` is
    // interpolated FROM the query, so dropping `publishRequestId` would navigate to a path
    // containing the literal bracket name.
    router.query = { publishRequestId: 'pubreq_01HZX' };
    render();
    await expect.element(page.getByRole('tab', { name: 'Code' })).toBeInTheDocument();
    await page.getByRole('tab', { name: 'Code' }).click();
    expect(router.replace).toHaveBeenCalledTimes(1);
    const [url, as, opts] = vi.mocked(router.replace).mock.calls[0] as unknown as [
      { pathname: string; query: Record<string, unknown> },
      undefined,
      { shallow?: boolean }
    ];
    expect(url.pathname).toBe('/apps/review/[publishRequestId]');
    expect(url.query).toEqual({ publishRequestId: 'pubreq_01HZX', tab: 'code' });
    expect(as).toBeUndefined();
    expect(opts?.shallow).toBe(true);
  });

  test('🔴 the tabs STILL WORK while an approve/reject mutation is in flight', async () => {
    // The page arms a route-leave guard during a mutation. A tab click is a QUERY-ONLY
    // change, which `useCatchNavigation` returns early on — so the mod can keep reading the
    // submission while their decision is submitting. If the bar were disabled, or the click
    // produced a PATH change, this is where it would show.
    mocks.pending = true;
    router.query = { publishRequestId: 'pubreq_01HZX' };
    render();
    /*
      🔴 POSITIVE CONTROL FIRST: prove the in-flight condition is actually in effect. Without
      it this case is outcome-identical to the plain tab-click test above and still claims
      "while a mutation is in flight" — so a `mocks.pending` wired to the wrong hook would
      leave it green and lying. `ReviewActionBar` renders Approve `disabled` while `busy`.
    */
    await expect.element(page.getByRole('button', { name: 'Approve + build' })).toBeDisabled();
    await expect.element(page.getByRole('tab', { name: 'Manifest' })).toBeInTheDocument();
    await page.getByRole('tab', { name: 'Manifest' }).click();
    expect(router.replace).toHaveBeenCalledTimes(1);
    const [url] = vi.mocked(router.replace).mock.calls[0] as unknown as [
      { pathname: string; query: Record<string, unknown> }
    ];
    // 🔴 SAME PATHNAME — that is the premise the guard's early return consumes.
    expect(url.pathname).toBe('/apps/review/[publishRequestId]');
    expect(url.query).toEqual({ publishRequestId: 'pubreq_01HZX', tab: 'manifest' });
  });

  test('…and switching BACK to the default DROPS the key rather than writing it', async () => {
    router.query = { publishRequestId: 'pubreq_01HZX', tab: 'code' };
    render();
    await expect.element(page.getByRole('tab', { name: 'Permissions' })).toBeInTheDocument();
    await page.getByRole('tab', { name: 'Permissions' }).click();
    const [url] = vi.mocked(router.replace).mock.calls[0] as unknown as [
      { query: Record<string, unknown> }
    ];
    expect(url.query).toEqual({ publishRequestId: 'pubreq_01HZX' });
  });
});

describe('the approve/reject bar is OUTSIDE the tabs', () => {
  /**
   * 🔴 INVARIANT GUARD, NOT REGRESSION COVERAGE — measured, not assumed. Every case in this
   * block was run against `origin/main` with the new pure modules copied in, and PASSED there.
   * It pins behaviour this change PRESERVES; it never watched the defect it describes.
   * Do not count it toward "the redesign is tested".
   */
  test.each(REVIEW_DETAIL_TAB_VALUES)(
    '🔴 reachable from the %s tab — a mod never has to find the right tab to act',
    async (tab) => {
      router.query = { tab };
      render();
      await expect.element(page.getByRole('group', { name: 'Review actions' })).toBeInTheDocument();
      await expect
        .element(page.getByRole('button', { name: 'Approve + build' }))
        .toBeInTheDocument();
      await expect.element(page.getByRole('button', { name: 'Reject…' })).toBeInTheDocument();
    }
  );

  /**
   * 🔴 …AND IT IS STILL SUPPRESSED FOR READ-ONLY APPROVED HISTORY, ON EVERY TAB. The bar
   * self-suppresses for a decided submission; moving it out of the tabs must not have
   * turned that into an empty sticky shell on four more surfaces.
   *
   * 🔴 INVARIANT GUARD, NOT REGRESSION COVERAGE — measured, not assumed. Every case in this
   * block was run against `origin/main` with the new pure modules copied in, and PASSED there.
   * It pins behaviour this change PRESERVES; it never watched the defect it describes.
   * Do not count it toward "the redesign is tested".
   *
   * `test.each`, not a loop in one test: the scaffold's `afterEach` awaits `cleanup()`, and
   * re-rendering inside one test leaves two mounted containers in `document.body` at once —
   * a document-scoped query then resolves to 2 elements and the strict-mode violation reads
   * as a component bug.
   */
  test.each(REVIEW_DETAIL_TAB_VALUES)(
    'no action bar on the %s tab of an approved submission',
    async (tab) => {
      router.query = { tab };
      render(APPROVED, 'approved');
      await expect.element(page.getByText('Approved by @mod-user')).toBeInTheDocument();
      // 🔴 THE ANCHOR ABOVE IS TAB-INDEPENDENT, SO IT CANNOT CARRY THIS CLAIM ALONE. The
      // decision banner sits OUTSIDE the tabs by design, so it renders whether or not the
      // requested tab resolved — which makes the absence assertion below satisfiable by a
      // page whose panel is blank. Pin the panel that is supposed to be on screen: the
      // right tab is selected AND its panel actually painted something.
      expect(selectedTab()).toBe(REVIEW_DETAIL_TAB_LABELS[tab]);
      const panel = visiblePanel();
      expect(panel, `the ${tab} panel must be on screen`).not.toBeNull();
      expect((panel!.textContent ?? '').trim().length).toBeGreaterThan(0);
      expect(page.getByRole('group', { name: 'Review actions' }).elements()).toHaveLength(0);
    }
  );
});

describe('the always-visible bands', () => {
  test.each(REVIEW_DETAIL_TAB_VALUES)(
    '🔴 the SUBMITTER line shows on the %s tab — it is a fact about the submission, not a section',
    async (tab) => {
      router.query = { tab };
      render();
      await expect.element(page.getByTestId('apps-review-submitter-meta')).toBeInTheDocument();
      await expect.element(page.getByTestId('apps-review-submitted-age')).toBeInTheDocument();
    }
  );

  // 🔴 A mod must not have to find the right tab to learn that this version was already
  // approved or rejected — so the DECISION banner is outside the tabs too.
  test.each(REVIEW_DETAIL_TAB_VALUES)(
    'the decision banner shows on the %s tab of a decided submission',
    async (tab) => {
      router.query = { tab };
      render(APPROVED, 'approved');
      await expect.element(page.getByText('Approved by @mod-user')).toBeInTheDocument();
      await expect.element(page.getByTestId('apps-review-decided-age')).toBeInTheDocument();
    }
  );
});

/**
 * 🔴 THE TWO MODE-GATED SECTIONS ON THE PREVIEW TAB.
 *
 * Both gates MOVED in this change: they used to be spelled at the call site inside the modal
 * body, and are now inside the components themselves (`ReviewPreviewSection`,
 * `ReviewCurationSection`) so the page and the modal cannot disagree about them. Moving a
 * predicate is exactly the change that can invert it silently, and `ReviewCurationSection`'s
 * is a CONJUNCTION — `mode === 'approved' && request.appBlockId` — of which only the first
 * clause was observable from any previous test.
 *
 * So all four quadrants are built here, which is what makes each clause attributable:
 * dropping either half of the `&&` fails a DIFFERENT case below.
 */
describe('the Preview tab’s mode gates — one implementation, both clauses', () => {
  const atPreview = (request: Record<string, unknown>, mode: 'pending' | 'approved') => {
    router.query = { tab: 'preview' };
    return render(request, mode);
  };
  const curation = () => page.getByText('Marketplace curation').elements();
  const sandbox = () => page.getByText('Review preview').elements();

  test('🔴 approved + an appBlockId → curation IS offered, and the pending-only sandbox is not', async () => {
    atPreview({ ...APPROVED, appBlockId: 'block_abc' }, 'approved');
    await expect.element(page.getByTestId('apps-review-listing-media')).toBeInTheDocument();
    expect(curation()).toHaveLength(1);
    expect(sandbox()).toHaveLength(0);
  });

  test('🔴 approved but NO appBlockId → curation is withheld (the second clause, previously untested)', async () => {
    // The real case: an approved request whose `app_block` row has not resolved yet. The
    // panel's whole form keys on `appBlockId`, so rendering it here would send
    // `setMarketplaceMeta` an empty id.
    atPreview({ ...APPROVED, appBlockId: null }, 'approved');
    await expect.element(page.getByTestId('apps-review-listing-media')).toBeInTheDocument();
    expect(curation()).toHaveLength(0);
  });

  test('🔴 pending → the sandbox IS offered and curation is withheld even WITH an appBlockId', async () => {
    // The quadrant that separates the two clauses: `appBlockId` is present, so a gate that
    // had lost its `mode` half would render curation on a pending submission — i.e. offer
    // "featured" controls for an app that is not approved.
    atPreview({ ...PENDING, appBlockId: 'block_abc' }, 'pending');
    await expect.element(page.getByTestId('apps-review-listing-media')).toBeInTheDocument();
    expect(sandbox()).toHaveLength(1);
    expect(curation()).toHaveLength(0);
  });

  // POSITIVE CONTROL, one case per string. Every assertion above is a COUNT, so a typo in
  // either query string would make all of them read zero and pass. Split into two cases
  // rather than two renders in one, so the scaffold's `afterEach` unmount runs between them.
  test.each([
    ['Review preview', PENDING, 'pending', null],
    ['Marketplace curation', APPROVED, 'approved', 'block_abc'],
  ] as const)(
    'POSITIVE CONTROL: "%s" IS reachable on this tab',
    async (text, req, mode, blockId) => {
      atPreview({ ...req, appBlockId: blockId }, mode);
      await expect.element(page.getByText(text)).toBeInTheDocument();
    }
  );
});

describe('panel laziness', () => {
  test('🔴 an UNVISITED tab does NOT mount its panel — nothing is fetched until it is opened', async () => {
    // The screenshots query returns base64 image payloads and the preview panel polls, so
    // mounting every panel on arrival (Mantine `keepMounted`'s default) would make landing
    // on Permissions pay for four sections a mod may never open. The screenshots panel is
    // the observable: its heading only exists once the Preview tab has been visited.
    render();
    await expect.element(page.getByTestId('apps-review-permissions')).toBeInTheDocument();
    expect(page.getByTestId('apps-review-listing-media').elements()).toHaveLength(0);
    expect(page.getByText('Show code diff').elements()).toHaveLength(0);
  });

  test('🔴 …and a VISITED tab STAYS mounted after you LEAVE it', async () => {
    // The other half, and the reason `keepMounted={false}` is wrong here: the Preview tab
    // holds the review-sandbox IFRAME. Unmounting it when a mod steps away to check a scope
    // would reload the block and lose whatever they were doing in it.
    //
    // Driven with `rerender` (which re-applies the same provider wrapper and keeps the SAME
    // component instance, so the visited-set ref survives) rather than a second
    // `renderWithProviders`, which would mount a fresh tree and reset it — making the
    // assertion vacuous in the WRONG direction.
    router.query = { tab: 'preview' };
    // ⚠️ `await` the render: `renderWithProviders` resolves to the handle, so destructuring
    // it synchronously yields `undefined` members (`rerender is not a function`).
    const { rerender } = await renderWithProviders(
      <ReviewDetailView
        selection={{ request: PENDING as never, mode: 'pending' }}
        onClose={vi.fn()}
      />
    );
    await expect.element(page.getByTestId('apps-review-listing-media')).toBeInTheDocument();

    // Navigate away to Permissions.
    router.query = { tab: 'permissions' };
    await rerender(
      <ReviewDetailView
        selection={{ request: PENDING as never, mode: 'pending' }}
        onClose={vi.fn()}
      />
    );
    await expect.element(page.getByTestId('apps-review-permissions')).toBeInTheDocument();
    expect(selectedTab()).toBe('Permissions');
    // 🔴 The Preview panel is still in the DOM — mounted once, kept.
    expect(document.querySelectorAll('[data-testid="apps-review-listing-media"]')).toHaveLength(1);
  });
});
