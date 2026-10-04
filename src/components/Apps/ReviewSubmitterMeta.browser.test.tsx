import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as BrowserSettingsProvider from '~/providers/BrowserSettingsProvider';
import type * as BrowsingLevelProvider from '~/components/BrowsingLevel/BrowsingLevelProvider';
import type * as CurrentUser from '~/hooks/useCurrentUser';
import type * as TrpcModule from '~/utils/trpc';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * The review submitter line — the REAL `UserAvatar`, not a stub.
 *
 * 🔴 THIS IS THE FILE WHERE THE AVATAR IS ACTUALLY EXERCISED. Four sibling suites
 * (`OnsiteReviewModal`, `ReviewDetailView`, `CombinedReviewModal`, `AgentReviewPanel`) stub
 * `UserAvatar` because their harnesses do not mount the four providers it reaches — which
 * means none of them can tell whether the real component renders at all against the payload
 * the review surfaces hand it. "A field exists in a DTO" is not a guard; only a render is.
 * So here the COMPONENT is real and the PROVIDERS are stubbed, which is the other way round.
 *
 * 🔴 AND IT IS THE SAME COMPONENT, WITH THE SAME PROPS, AS THE QUEUE LIST'S SUBMITTER CELL
 * (`UnifiedReviewList.tsx`: `size="sm" withUsername linkToProfile`). The whole point of the
 * change is that one person reads identically on the list and on the submission. The
 * PAYLOAD half of that parity — that the two reads select the same `submittedBy` fields — is
 * a different kind of claim and is pinned in
 * `src/server/services/blocks/__tests__/review-submitter-select-parity.test.ts`; a render
 * here cannot see it.
 */

// The avatar + `Username` reach four providers this scaffold does not mount, and each of
// them throws on a missing context — which empties the tree and turns every assertion into
// a timeout rather than a readable failure. Precedent: `AnnouncementsPanel.browser.test.tsx`.
vi.mock('~/hooks/useCurrentUser', async (importOriginal) => ({
  ...(await importOriginal<typeof CurrentUser>()),
  useCurrentUser: () => ({ id: 1, isModerator: true }),
}));
// ⚠️ Every export the module graph reaching this component imports has to be present. A
// factory that omits one fails the WHOLE FILE at import with
// `does not provide an export named …` — which the runner reports as `Tests no tests`, i.e.
// a file that looks skipped rather than broken.
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

/*
  🔴 SPREAD THE REAL MODULE, then override `trpc`. A wholesale factory replaces
  `~/utils/trpc` entirely, so the day it gains an export this object omits, every importer in
  the module graph gets `undefined` and the WHOLE FILE fails to load — 0 tests collected, no
  failing assertion, silently "green" (`trpcVanilla` disabled ~36 tests that way).
  `local-rules/no-wholesale-module-mock` reds on the narrow form. Spreading keeps the other
  exports real; `trpc` itself still has to be replaced wholesale, because it is a flat Proxy
  whose `ownKeys` is empty and therefore cannot be spread.
*/
// `UserAvatar` calls `trpc.user.getById.useQuery` UNCONDITIONALLY (it is disabled via
// `enabled`, but the hook still runs), so that path has to exist on the replacement.
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: {
    user: { getById: { useQuery: () => ({ data: undefined, isInitialLoading: false }) } },
  },
}));

const { ReviewSubmitterMeta } = await import('./OnsiteReviewModal');

/**
 * The exact submitter shape BOTH reads select: `{ id, username, deletedAt, image }`.
 *
 * 🔴 `deletedAt` IS IN THE SELECT BECAUSE SOMETHING BRANCHES ON IT, and the deleted case
 * below is that branch. Its parity across every reader of the chip is pinned structurally in
 * `src/server/services/blocks/__tests__/review-submitter-select-parity.test.ts`; what only a
 * render can show is that the field changes what a moderator sees.
 */
const SUBMITTER = { id: 7, username: 'dev-user', deletedAt: null, image: null };

const REQUEST = {
  submittedBy: SUBMITTER,
  submittedAt: new Date('2026-01-01T09:00:00Z'),
  bundleSizeBytes: '421888',
};

/**
 * 🔴 `now` IS A PARAMETER, SO THERE ARE NO FAKE TIMERS IN THIS FILE. That property is the
 * reason `compactRelativeTime` exists as the single ladder under `~/components/Apps` — its
 * own docstring records that the ladder it replaced read the clock itself and therefore
 * needed faked timers to test. Keep it that way: a test here that reaches for
 * `vi.useFakeTimers` is a sign the ladder grew a clock read.
 */
const NOW = new Date('2026-01-01T12:00:00Z'); // exactly 3h after the submission

describe('ReviewSubmitterMeta — the real UserAvatar', () => {
  test('🔴 renders the submitter as the SAME profile-linking chip the queue list uses', async () => {
    renderWithProviders(<ReviewSubmitterMeta request={REQUEST} now={NOW} />);
    await expect.element(page.getByTestId('apps-review-submitter-meta')).toBeInTheDocument();
    // The username is on screen…
    await expect.element(page.getByText('dev-user')).toBeInTheDocument();
    // …and `linkToProfile` produced a real anchor to the profile, which is what makes this
    // the queue's chip rather than a lookalike.
    const link = document.querySelector('a[href="/user/dev-user"]');
    expect(link, 'profile link for the submitter').not.toBeNull();
    // The `#<id>` fallback must NOT appear for a named submitter.
    expect(page.getByTestId('apps-review-submitter-fallback').elements()).toHaveLength(0);
  });

  test('🔴 a submitter with NO USERNAME renders `#<id>`, never an empty line', async () => {
    // A deleted or never-named account is still an identity a moderator acts on. The queue
    // cell shows exactly this; so does the submission.
    renderWithProviders(
      <ReviewSubmitterMeta
        request={{
          ...REQUEST,
          submittedBy: { id: 42, username: null, deletedAt: null, image: null },
        }}
        now={NOW}
      />
    );
    await expect
      .element(page.getByTestId('apps-review-submitter-fallback'))
      .toHaveTextContent('#42');
    // …and NO profile link, because there is no profile to link to.
    expect(document.querySelectorAll('a[href^="/user/"]')).toHaveLength(0);
  });

  test('🔴 a DELETED submitter is named "[deleted]" and is NOT linked — the `deletedAt` branch', async () => {
    // The consumer branch the select exists for, and the reason omitting the field was a live
    // defect rather than a missing nicety. `UserAvatar` reads `deletedAt` in two places:
    // `UserProfileLink` returns its children unwrapped (no anchor) and `Username` renders
    // "[deleted]" instead of the name. With the field absent from the select the value is
    // `undefined` ⇒ falsy ⇒ a closed account rendered as a live, clickable profile.
    //
    // 🔴 THE FIXTURE KEEPS ITS USERNAME. A deleted account whose username were also null
    // would be caught by the `#<id>` fallback case above, so the two tests would not be
    // distinguishable — and the real rows keep the name, which is exactly why this branch
    // exists.
    renderWithProviders(
      <ReviewSubmitterMeta
        request={{
          ...REQUEST,
          submittedBy: { ...SUBMITTER, deletedAt: new Date('2026-01-01T00:00:00Z') },
        }}
        now={NOW}
      />
    );
    await expect.element(page.getByTestId('apps-review-submitter-meta')).toBeInTheDocument();
    await expect.element(page.getByText('[deleted]')).toBeInTheDocument();
    // 🔴 THE NAME IS GONE, not merely accompanied by a marker.
    expect(page.getByText('dev-user').elements()).toHaveLength(0);
    // …and there is no profile to click through to.
    expect(document.querySelectorAll('a[href^="/user/"]')).toHaveLength(0);
  });

  test('a submitter WITH an avatar image still renders the chip (no throw on the edge path)', async () => {
    // `image` drives `useGetEdgeUrl`, the one branch a null-image fixture never reaches.
    renderWithProviders(
      <ReviewSubmitterMeta
        request={{ ...REQUEST, submittedBy: { ...SUBMITTER, image: 'abc-123-def' } }}
        now={NOW}
      />
    );
    await expect.element(page.getByText('dev-user')).toBeInTheDocument();
  });
});

describe('ReviewSubmitterMeta — relative time', () => {
  test('🔴 the AGE is shown, not the absolute date', async () => {
    renderWithProviders(<ReviewSubmitterMeta request={REQUEST} now={NOW} />);
    const age = page.getByTestId('apps-review-submitted-age');
    await expect.element(age).toHaveTextContent('3h');
    // The thing it replaced: a `toLocaleString()` dump. Its year is the cheapest proof the
    // absolute form is not what is being painted.
    expect(age.element().textContent).not.toContain('2026');
  });

  test('🔴 THE ABSOLUTE INSTANT SURVIVES, on `title` and as a machine-readable `datetime`', async () => {
    // "3h ago" is what a mod triaging a queue needs; the exact instant is what a moderation
    // DECISION RECORD needs, and a review page is both. Dropping it to save width would
    // make the page unusable as evidence.
    renderWithProviders(<ReviewSubmitterMeta request={REQUEST} now={NOW} />);
    // ⚠️ `await` FIRST. Browser mode commits asynchronously, so reading `.element()`
    // straight after `render` races the commit — and the failure reads as "the element is
    // missing" rather than "you looked too early".
    await expect.element(page.getByTestId('apps-review-submitted-age')).toBeInTheDocument();
    const el = page.getByTestId('apps-review-submitted-age').element();
    expect(el.tagName.toLowerCase()).toBe('time');
    expect(el.getAttribute('datetime')).toBe('2026-01-01T09:00:00.000Z');
    expect(el.getAttribute('title')).toBe(REQUEST.submittedAt.toLocaleString());
  });

  /**
   * 🔴 EVERY RUNG IS REACHABLE WITHOUT FAKING TIMERS — `now` is injected.
   *
   * `test.each`, not a loop inside ONE test: the scaffold's `afterEach` awaits `cleanup()`,
   * so a loop that re-renders without it leaves two mounted containers in `document.body`
   * at once and a document-scoped `getByTestId` resolves to 2 elements — a strict-mode
   * violation reported as "the matcher did not succeed", which reads as a ladder bug.
   */
  test.each([
    ['2026-01-01T11:59:30Z', 'now'],
    ['2026-01-01T11:45:00Z', '15m'],
    ['2026-01-01T06:00:00Z', '6h'],
    ['2025-12-29T12:00:00Z', '3d'],
    ['2025-12-18T12:00:00Z', '2w'],
    ['2025-10-01T12:00:00Z', '3mo'],
    ['2023-01-01T12:00:00Z', '3y'],
  ])('submitted %s reads as %s', async (submittedAt, expected) => {
    renderWithProviders(
      <ReviewSubmitterMeta request={{ ...REQUEST, submittedAt: new Date(submittedAt) }} now={NOW} />
    );
    await expect.element(page.getByTestId('apps-review-submitted-age')).toHaveTextContent(expected);
  });

  test('a FUTURE timestamp reads `now` rather than a negative age (clock skew is ordinary)', async () => {
    renderWithProviders(
      <ReviewSubmitterMeta
        request={{ ...REQUEST, submittedAt: new Date('2026-01-01T12:00:10Z') }}
        now={NOW}
      />
    );
    await expect.element(page.getByTestId('apps-review-submitted-age')).toHaveTextContent('now');
  });

  test('the bundle size still rides the same line', async () => {
    renderWithProviders(<ReviewSubmitterMeta request={REQUEST} now={NOW} />);
    await expect
      .element(page.getByTestId('apps-review-submitter-meta'))
      .toHaveTextContent('412.0 KiB');
  });
});
