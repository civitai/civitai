import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
// Type-only namespace imports for the `importOriginal` spreads below (the repo's
// local-rules/no-wholesale-module-mock cure). NOT `typeof import(...)`, which
// @typescript-eslint/consistent-type-imports rejects.
import type * as TrpcMod from '~/utils/trpc';
import type * as FlagsMod from '~/providers/FeatureFlagsProvider';
import type { MintReviewBlockTokenResult } from '~/server/services/blocks/publish-request.service';

/**
 * THE MOD REVIEW PREVIEW WAS CLIPPED AND UNREACHABLE — measured.
 *
 * THE SYMPTOM. `OnsiteReviewModal` mounts the review preview in a panel of
 * `height: 420; overflow: hidden`. `ReviewBlockPreviewHost` reused
 * `PageBlockHost` and passed no `fit`, so the host took the default
 * `fit="viewport"` and claimed `min-height: calc(100dvh - HEADER_HEIGHT_PX)` —
 * roughly 1020px on a 1080px screen. 600px of the app was crushed out of the
 * panel, `overflow: hidden` refused to let the moderator scroll to it, and the
 * loss GREW with the viewport: the claim scales with `100dvh` while the panel is
 * a constant 420.
 *
 * THE FIX. `fit="fill"` — the host claims no height of its own (`flex: 1`,
 * floored at `FILL_MIN_HEIGHT_PX = 300`, comfortably under 420) and takes what
 * the panel actually has. The panel and the full-page preview's box are flex
 * columns so `flex: 1` has something to resolve against; without that the host
 * lands ON its floor and leaves the rest of the panel empty, which is a
 * different, quieter bug.
 *
 * 🔴 WHY THIS MEASURES INSTEAD OF READING STYLES. The defect is a LAYOUT
 * outcome. An assertion on `style.minHeight` restates the implementation and
 * passes whatever the browser then does with it. This runs in real Chromium and
 * asks the only questions that matter: is content pushed outside the panel
 * (`scrollHeight > clientHeight` on a box that will not scroll), and does the
 * host actually fill the space it was given.
 *
 * 🔴 THE RED ARM IS THE REPRODUCTION AND MUST STAY. It renders the SAME host
 * into the SAME panel with `fit="viewport"`, i.e. the state that shipped, and
 * shows that panel really does hide content. Delete it and the green arm stops
 * proving anything — a panel that silently had no bounded height would report
 * "no overflow" in both arms. It is an INVARIANT GUARD, not regression coverage:
 * it passes on `origin/main` too, by construction.
 *
 * NOTE ON REACH: this suite runs in CI as the REPORT-ONLY
 * `preview / component-tests` status. The gating half of this contract is the
 * `fill` opt-in ledger in `AppBlocks/__tests__/pageRunScrollContract.test.ts`.
 * This file is the empirical half, and it is the one that can see layout at all.
 */

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 1, username: 'mod' }) }));

vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FlagsMod>()),
  // The real hook needs a provider this harness does not mount. Only the two
  // flags `ReviewBlockPreviewHost` reads matter here, and neither affects layout.
  useFeatureFlags: () => ({ appBlocks: true, appBlocksPages: true }),
}));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: {
    generation: { resolveWildcardPack: { useMutation: () => ({ mutateAsync: vi.fn() }) } },
    blocks: {
      // The mint the review host fires on mount. Resolves synchronously to a
      // render-only token, which is the state the preview is in by default.
      mintReviewBlockToken: {
        useMutation: () => ({
          data: RENDER_ONLY_MINT,
          isPending: false,
          isError: false,
          mutate: vi.fn(),
        }),
      },
      submitWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      getMyBuzzBalance: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      getMyViewer: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      getMyBuzzTransactions: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      getMyBuzzAccounts: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      getMyDailyCompensation: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      estimateWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      pollWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      cancelWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      queryAppWorkflows: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      cancelAppWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      publishGenerationOutputs: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      getImagesByIds: { useMutation: () => ({ mutateAsync: vi.fn() }) },
    },
    apps: {
      shared: {
        append: { useMutation: () => ({ mutateAsync: vi.fn() }) },
        update: { useMutation: () => ({ mutateAsync: vi.fn() }) },
        vote: { useMutation: () => ({ mutateAsync: vi.fn() }) },
        unvote: { useMutation: () => ({ mutateAsync: vi.fn() }) },
        withdraw: { useMutation: () => ({ mutateAsync: vi.fn() }) },
        report: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      },
      storage: {
        set: { useMutation: () => ({ mutateAsync: vi.fn() }) },
        delete: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      },
    },
    useUtils: () => ({
      apps: {
        shared: {
          list: { fetch: vi.fn() },
          getCount: { fetch: vi.fn() },
          getCounts: { fetch: vi.fn() },
          get: { fetch: vi.fn() },
        },
        storage: {
          get: { fetch: vi.fn() },
          list: { fetch: vi.fn() },
          getQuota: { fetch: vi.fn() },
        },
      },
    }),
  },
}));

// Typed to the PRODUCTION mint shape so a field rename fails at compile time
// rather than silently handing the host `undefined`.
const RENDER_ONLY_MINT: MintReviewBlockTokenResult = {
  token: 'review.render-only.jwt',
  expiresAt: '2099-01-01T00:00:00Z',
  scopes: ['user:read:self'],
  domain: null,
  maxBrowsingLevel: 1,
  blockId: 'review-fit-app',
  appId: 'pending-pubreq_FIT',
  appBlockId: 'pubreq_FIT',
  blockInstanceId: 'page_pubreq_FIT',
  appName: 'Review Fit App',
  sandbox: 'allow-scripts',
  runForReal: false,
  buzzCap: null,
};

// eslint-disable-next-line import/first
import { PageBlockHost } from '~/components/AppBlocks/PageBlockHost';
// eslint-disable-next-line import/first
import { ReviewBlockPreviewHost } from '~/components/Apps/ReviewBlockPreviewHost';

const SAME_ORIGIN_SRC = `${window.location.origin}/`;

/**
 * The review modal's preview panel, kept in sync with the wrapper in
 * `src/components/Apps/OnsiteReviewModal.tsx`. The two properties that decide
 * this bug are the FIXED height and `overflow: hidden` — a box that bounds its
 * children and then refuses to let anyone scroll to what it pushed out.
 */
const MODAL_PANEL_HEIGHT = 420;

function renderInModalPanel(children: React.ReactNode, overflow: 'hidden' | 'auto') {
  return renderWithProviders(
    <div
      data-testid="review-panel"
      style={{
        width: '100%',
        height: `${MODAL_PANEL_HEIGHT}px`,
        display: 'flex',
        flexDirection: 'column',
        overflow,
      }}
    >
      {children}
    </div>
  );
}

/** The direct-host props the RED ARM needs to restate the pre-fix mount. */
const directHostProps = {
  appBlockId: RENDER_ONLY_MINT.appBlockId,
  blockId: RENDER_ONLY_MINT.blockId,
  appId: RENDER_ONLY_MINT.appId,
  blockInstanceId: RENDER_ONLY_MINT.blockInstanceId,
  appName: RENDER_ONLY_MINT.appName,
  iframeSrc: SAME_ORIGIN_SRC,
  surface: 'review-preview' as const,
  sandbox: RENDER_ONLY_MINT.sandbox,
  trustTier: 'unverified' as const,
  slug: RENDER_ONLY_MINT.blockId,
  token: RENDER_ONLY_MINT.token,
  expiresAt: RENDER_ONLY_MINT.expiresAt,
  declaredScopes: RENDER_ONLY_MINT.scopes,
  missingScopes: [] as string[],
  needsConsent: false,
  tokenError: false,
  domain: RENDER_ONLY_MINT.domain,
  maxBrowsingLevel: RENDER_ONLY_MINT.maxBrowsingLevel,
  viewer: { id: 1, username: 'mod' },
  theme: 'light' as const,
  reviewMode: true,
};

function panel() {
  return page.getByTestId('review-panel').element() as HTMLElement;
}

function hostFrame() {
  return page.getByTestId('app-page-frame').element() as HTMLElement;
}

describe('the mod review preview fits its panel instead of being clipped out of it', () => {
  test('RED ARM (invariant guard) — `fit="viewport"` really is pushed out of the 420px panel', async () => {
    // The pre-fix mount, restated. This is the reproduction and it passes on
    // `origin/main` too — it exists so the green arm's "no overflow" is a fact
    // about the fix rather than about a fixture that never bounded anything.
    // `overflow: 'hidden'` here restates the panel AS IT SHIPPED — both legs of
    // the defect together: a claim far taller than the box, and a box that will
    // not let anyone scroll to what it pushed out.
    renderInModalPanel(<PageBlockHost {...directHostProps} fit="viewport" />, 'hidden');
    await expect.element(page.getByTestId('app-page-frame')).toBeInTheDocument();

    const box = panel();
    expect(box.clientHeight).toBeLessThanOrEqual(MODAL_PANEL_HEIGHT);
    // Content pushed past the panel...
    expect(box.scrollHeight).toBeGreaterThan(box.clientHeight);
    // ...and the panel will NOT let the moderator scroll to it. Both halves are
    // needed: `scrollHeight > clientHeight` alone is "there is overflow", which
    // an `overflow: auto` box would satisfy while still being usable.
    expect(getComputedStyle(box).overflowY).toBe('hidden');
    // Name the SIZE of the loss. This is the number the fix has to move, and a
    // bare "there is some overflow" would be satisfied by a few stray pixels.
    // It is deliberately expressed against the viewport the runner opened rather
    // than as a constant, because the loss IS `100dvh − header − panel`: that is
    // what makes it grow with the screen.
    expect(box.scrollHeight - box.clientHeight).toBeGreaterThan(
      window.innerHeight - 60 - MODAL_PANEL_HEIGHT - 40
    );
  });

  test('GREEN ARM — the real review host fits the panel, with nothing hidden', async () => {
    // 🔴 THE REAL COMPONENT, not a hand-passed `fit`. The defect lived in the
    // SEAM: `PageBlockHost` was fine, `OnsiteReviewModal` was fine, and the
    // wiring between them dropped the prop. A test that passes `fit="fill"`
    // itself would be green at `origin/main` and prove nothing.
    renderInModalPanel(
      <ReviewBlockPreviewHost
        publishRequestId="pubreq_FIT"
        slug="review-fit-app"
        iframeSrc={SAME_ORIGIN_SRC}
      />,
      // Matches the shipped panel after this fix — see the wrapper in
      // `OnsiteReviewModal.tsx` for why `auto` and not `hidden`.
      'auto'
    );
    await expect.element(page.getByTestId('app-page-frame')).toBeInTheDocument();

    const box = panel();
    const frame = hostFrame();

    // 🔴 RED AT BASE, and this is the assertion that carries the fix: without
    // `fit="fill"` the host claims `calc(100dvh - HEADER_HEIGHT_PX)`, so it
    // reports the full viewport height here instead of the panel's.
    expect(frame.getAttribute('data-fit')).toBe('fill');
    expect(frame.getBoundingClientRect().height).toBeLessThanOrEqual(MODAL_PANEL_HEIGHT);

    // 🔴 AND THE OTHER FAILURE DIRECTION — `fill` must not collapse the host, nor
    // leave it sitting on its `FILL_MIN_HEIGHT_PX` floor in a 420px panel. That
    // is the quieter bug a non-flex panel reintroduces: a short preview in a tall
    // box, which reads as a styling nit. A zero-height host would also report
    // "no overflow", so this is what stops the assertion above passing for the
    // wrong reason.
    expect(frame.getBoundingClientRect().height).toBeGreaterThan(320);

    // Nothing is stranded. Stated as the DISJUNCTION the surface actually
    // promises rather than a flat "no overflow": at ordinary modal widths the
    // banner is one row and the host fits exactly, but this runner's viewport is
    // ~414px WIDE, the banner wraps, and the floor legitimately binds — at which
    // point the panel must be scrollable rather than clipping. The red arm's
    // panel satisfies NEITHER branch, which is what makes this a real test and
    // not a tautology.
    const overflow = box.scrollHeight - box.clientHeight;
    const reachable = ['auto', 'scroll'].includes(getComputedStyle(box).overflowY);
    expect(
      overflow === 0 || reachable,
      `preview overflows its panel by ${overflow}px with overflowY=${
        getComputedStyle(box).overflowY
      } — that content is unreachable`
    ).toBe(true);
    // And whatever residue the floor leaves is SMALL — a fraction of the loss the
    // red arm measures, not merely "some overflow".
    expect(overflow).toBeLessThan(60);
  });

  /**
   * SECOND MEASUREMENT POINT. The loss grows with the viewport, so one panel size
   * is not a claim about the surface — it is a claim about 420px. The full-page
   * preview (`/apps/review/preview/<id>`) mounts the SAME component in a box of
   * `100dvh - header`, which is the tall end of the same axis, and it had the
   * same shape of bug in a milder form: the host claimed the whole box for
   * itself while the read-only banner still had to fit above it.
   */
  test('the tall mounter too — a full-height box shows no overflow either', async () => {
    const boxHeight = window.innerHeight - 60;
    renderWithProviders(
      <div
        data-testid="fullpage-box"
        style={{
          height: `${boxHeight}px`,
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <ReviewBlockPreviewHost
          publishRequestId="pubreq_FIT"
          slug="review-fit-app"
          iframeSrc={SAME_ORIGIN_SRC}
        />
      </div>
    );
    await expect.element(page.getByTestId('app-page-frame')).toBeInTheDocument();

    const box = page.getByTestId('fullpage-box').element() as HTMLElement;
    // Positive control on the fixture: a box that failed to take a height would
    // report no overflow for a reason unrelated to the fix.
    expect(box.clientHeight).toBeGreaterThan(200);
    // RED AT BASE: the host claimed `100dvh - 60px` = the whole box, and the
    // banner above it pushed the total past the box.
    expect(box.scrollHeight).toBe(box.clientHeight);
    expect(hostFrame().getAttribute('data-fit')).toBe('fill');
  });
});
