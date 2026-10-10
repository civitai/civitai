import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as BrowserSettingsProvider from '~/providers/BrowserSettingsProvider';
import type * as BrowsingLevelProvider from '~/components/BrowsingLevel/BrowsingLevelProvider';
import type * as CurrentUser from '~/hooks/useCurrentUser';
import type * as TrpcModule from '~/utils/trpc';
import type { OffsiteReviewRequest, OnsiteReviewRequest } from './unifiedReviewRow';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * THE COMBINED STATE: one list, two row sources, one deleted account.
 *
 * 🔴 WHY THIS IS A SEPARATE FILE FROM `UnifiedReviewList.browser.test.tsx`, AND WHY THAT
 * SUITE CANNOT CARRY THIS CLAIM. It stubs `UserAvatar` — reasonably, because the real one
 * reaches four providers that harness does not mount — and the stub renders
 *
 *     linkToProfile ? <a href={…}>{user.username ?? '[deleted]'}</a> : <span>…</span>
 *
 * which is the *username-absent* rendering wearing the deleted account's word, and an
 * UNCONDITIONAL link. So that suite renders a closed account as a live, clickable profile
 * and passes — the defect is the test's own output. Worse, grepping it for `[deleted]`
 * returns a hit, which reads as coverage. The stub is right for what those cases assert
 * (WHICH user, and whether a link exists at all); it simply cannot see this field.
 *
 * Here the COMPONENT is real and the PROVIDERS are stubbed, the same way round as
 * `ReviewSubmitterMeta.browser.test.tsx`.
 *
 * 🔴 AND WHY BOTH ROW KINDS IN ONE RENDER. `/apps/review` INTERLEAVES on-site publish
 * requests and off-site listing revisions into a single list and hands both submitters to
 * the same `UserAvatar`. The two come from DIFFERENT services, and for three review rounds
 * one of them selected `deletedAt` and the other did not — so the real defect was never
 * "the chip is wrong", it was "the two rows disagree about the same person, side by side,
 * on the screen where who submitted a bundle is the fact being judged". A fixture with one
 * row kind cannot express that, which is exactly how it survived.
 */

// The avatar + `Username` reach four providers this scaffold does not mount, and each throws
// on a missing context — which empties the tree and turns every assertion into a timeout
// rather than a readable failure. Same set as `ReviewSubmitterMeta.browser.test.tsx`.
//
// ⚠️ `useCurrentUser` returns a MODERATOR here, deliberately: `Username` renders
// `[deleted] #<id>` for a mod and a bare `[deleted]` for everyone else, and this list is a
// mod-only surface. The assertions below match the leading word so they hold either way.
vi.mock('~/hooks/useCurrentUser', async (importOriginal) => ({
  ...(await importOriginal<typeof CurrentUser>()),
  useCurrentUser: () => ({ id: 1, isModerator: true }),
}));
// ⚠️ Every export the module graph reaching this component imports has to be present. A
// factory that omits one fails the WHOLE FILE at import with `does not provide an export
// named …`, which the runner reports as `Tests no tests` — a file that looks skipped rather
// than broken. This PR hit exactly that in a sibling suite.
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ appBlocks: true, canViewNsfw: false }),
  useOptionalFeatureFlags: () => ({ appBlocks: true, canViewNsfw: false }),
  useFeatureFlagsReady: () => true,
  FeatureFlagsProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock('~/providers/BrowserSettingsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowserSettingsProvider>()),
  useBrowsingSettings: () => false,
}));
vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowsingLevelProvider>()),
  useViewerBrowsingLevelDebounced: () => 1,
}));
// `UserAvatar` calls `trpc.user.getById.useQuery` UNCONDITIONALLY (disabled via `enabled`,
// but the hook still runs), so that path has to exist on the replacement.
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: {
    user: { getById: { useQuery: () => ({ data: undefined, isInitialLoading: false }) } },
  },
}));

const { UnifiedReviewList } = await import('./UnifiedReviewList');

const DELETED_AT = new Date('2026-03-01T00:00:00Z');

/** The ON-SITE row — a publish request, from `publish-request.service.ts`. */
const onsite = (deleted: boolean): OnsiteReviewRequest =>
  ({
    id: 'or1',
    appBlockId: null,
    slug: 'my-onsite',
    version: '1.0.0',
    submittedAt: '2026-01-01T00:00:00Z',
    bundleSizeBytes: '1024',
    bundleSha256: 'a'.repeat(64),
    manifest: { name: 'Wayfarer', blockId: 'my-onsite', version: '1.0.0', scopes: [] },
    fileSummary: { files: [], added: [], removed: [], changed: [] },
    manifestDiffSummary: { kind: 'first-version', fields: [] },
    submittedBy: {
      id: 7,
      username: 'onsite-dev',
      deletedAt: deleted ? DELETED_AT : null,
      image: null,
    },
  } as unknown as OnsiteReviewRequest);

/** The OFF-SITE row — a listing revision, from `offsite-listing.service.ts`. */
const offsite = (deleted: boolean): OffsiteReviewRequest =>
  ({
    id: 'fr1',
    appListingId: 'apl_1',
    slug: 'my-offsite',
    status: 'pending',
    submittedAt: '2026-02-01T00:00:00Z',
    changelog: null,
    appListing: {
      name: 'Lantern',
      externalUrl: 'https://ex.com',
      category: 'utility',
      contentRating: 'g',
    },
    submittedBy: {
      id: 9,
      username: 'offsite-dev',
      deletedAt: deleted ? DELETED_AT : null,
      image: null,
    },
  } as unknown as OffsiteReviewRequest);

const renderList = (opts: { onsiteDeleted: boolean; offsiteDeleted: boolean }) =>
  renderWithProviders(
    <UnifiedReviewList
      onsiteItems={[onsite(opts.onsiteDeleted)]}
      offsiteItems={[offsite(opts.offsiteDeleted)]}
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

/** Every profile link the list rendered, by href. */
const profileHrefs = () =>
  Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href^="/user/"]')).map(
    (a) => a.getAttribute('href') ?? ''
  );

describe('a DELETED submitter on either row kind', () => {
  test.each([
    ['on-site', { onsiteDeleted: true, offsiteDeleted: false }, 'onsite-dev', 'offsite-dev'],
    ['off-site', { onsiteDeleted: false, offsiteDeleted: true }, 'offsite-dev', 'onsite-dev'],
  ] as const)(
    '🔴 the %s row reads "[deleted]" and carries NO profile link — while its neighbour still does',
    async (_kind, opts, goneName, liveName) => {
      renderList(opts);
      // 🔴 AWAIT THE STATE THAT ARRIVES IN BOTH THE HEALTHY AND THE BROKEN RENDER — the LIVE
      // neighbour — then read the deleted row synchronously. Awaiting "[deleted]" first made
      // every failure a 15-second locator timeout: the state never arrives under the mutant,
      // so the budget is spent waiting and the three assertions that actually describe the
      // defect never execute. The failure then reports a missing locator rather than a
      // rendered closed account, which is a candidate filter, not a diagnosis.
      await expect.element(page.getByText(liveName)).toBeInTheDocument();

      // 🔴 THE NAME IS GONE, not merely accompanied by a marker. `Username` replaces it.
      expect(
        page.getByText(goneName).elements(),
        `a closed account must not still be named @${goneName}`
      ).toHaveLength(0);
      expect(
        page.getByText('[deleted]', { exact: false }).elements().length,
        'the closed account must be rendered as deleted'
      ).toBeGreaterThan(0);

      // 🔴 AND THERE IS NO PROFILE TO CLICK THROUGH TO. `UserProfileLink` drops the anchor.
      const hrefs = profileHrefs();
      expect(hrefs, 'a closed account must not be linked').not.toContain(`/user/${goneName}`);

      // 🔴 THE CONTRAST, IN THE SAME RENDER, AND IT IS THE WHOLE POINT. The other row kind
      // comes from a different service and a different select. Without this, "no links at
      // all" — a list that failed to render, or a blanket suppression — would satisfy the
      // assertions above. (Its presence is the awaited anchor at the top of this case.)
      expect(hrefs, `the live neighbour must still be linked`).toContain(`/user/${liveName}`);
    }
  );

  test('🔴 POSITIVE CONTROL: with neither deleted, BOTH rows are named and linked', async () => {
    // Proves the two assertions above are about `deletedAt` and not about this harness
    // rendering no links in the first place — which is how the stubbed sibling suite reads
    // as coverage while providing none.
    renderList({ onsiteDeleted: false, offsiteDeleted: false });
    await expect.element(page.getByText('onsite-dev')).toBeInTheDocument();
    await expect.element(page.getByText('offsite-dev')).toBeInTheDocument();
    const hrefs = profileHrefs();
    expect(hrefs).toContain('/user/onsite-dev');
    expect(hrefs).toContain('/user/offsite-dev');
    expect(page.getByText('[deleted]', { exact: false }).elements()).toHaveLength(0);
  });
});
