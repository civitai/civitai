import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { REVIEW_RUN_FOR_REAL_BUZZ_CAP } from '~/shared/constants/block-scope.constants';
import type { MintReviewBlockTokenResult } from '~/server/services/blocks/publish-request.service';

/**
 * MOD REVIEW SANDBOX "run for real" (#2831) — `ReviewBlockPreviewHost` opt-in UI.
 *
 * Proves the mod-facing control surface of the run-for-real opt-in WITHOUT mounting
 * the heavy real PageBlockHost (stubbed to report its `reviewRunForReal` prop):
 *   - DEFAULT is render-only — no banner, the opt-in ("Run for real…") is off;
 *   - arming shows the LOUD consent copy incl. the exact Buzz cap + "SFW enforced";
 *   - CONFIRM re-mints with runForReal:true → the persistent banner shows and the
 *     host is handed reviewRunForReal=true (server-authoritative: driven off the
 *     minted token, not the UI flag);
 *   - EXIT re-mints render-only → banner clears, host back to reviewRunForReal=false.
 */

// Stub the real host so the test targets the control surface only. It surfaces the
// security-relevant prop so we can assert what the host is actually told to do.
vi.mock('~/components/AppBlocks/PageBlockHost', () => ({
  PageBlockHost: ({
    reviewRunForReal,
    canOpenPage,
  }: {
    reviewRunForReal?: boolean;
    canOpenPage?: boolean;
  }) => (
    <div
      data-testid="page-host"
      data-rfr={String(!!reviewRunForReal)}
      // Surfaced so the chrome "Recently run" wiring is assertable: this surface
      // must forward the VIEWER's `appBlocksPages`, not a per-surface constant.
      data-can-open-page={String(!!canOpenPage)}
    />
  ),
}));

vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: 1, username: 'mod' }),
}));

// The review surface reads `appBlocksPages` to decide whether the app-chrome may
// offer `/apps/run/<blockId>` shortcuts. The real hook THROWS without a
// FeatureFlagsProvider, and the flag is per-test controllable so both directions
// of the forward are assertable. Deliberately a WHOLE-module factory, not an
// `importOriginal` spread: the real module imports `setTrpcBatchingEnabled` from
// '~/utils/trpc', which the wholesale trpc factory below does not provide, so
// spreading the original makes the file fail to LOAD.
const flagState = vi.hoisted(() => ({ appBlocksPages: false }));
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => flagState,
}));

// Typed to the PRODUCTION mint-result shape (`buzzCap: number | null`,
// `runForReal: boolean`) so the run-for-real variant type-checks AND the mock
// exercises a well-typed state — not the narrowed literal `typeof` inference.
const RENDER_ONLY_MINT: MintReviewBlockTokenResult = {
  token: 'review.render-only.jwt',
  expiresAt: '2099-01-01T00:00:00Z',
  scopes: ['models:read:self', 'user:read:self'],
  domain: null,
  maxBrowsingLevel: 1,
  blockId: 'my-app',
  appId: 'pending-pubreq_X',
  appBlockId: 'pubreq_X',
  blockInstanceId: 'page_pubreq_X',
  appName: 'My App',
  sandbox: 'allow-scripts',
  runForReal: false,
  buzzCap: null,
};

const RUN_FOR_REAL_MINT: MintReviewBlockTokenResult = {
  ...RENDER_ONLY_MINT,
  token: 'review.run-for-real.jwt',
  scopes: ['ai:write:budgeted', 'apps:storage:read', 'apps:storage:write', 'user:read:self'],
  runForReal: true,
  buzzCap: REVIEW_RUN_FOR_REAL_BUZZ_CAP,
};

// A REAL stateful useMutation stub: `mutate({ runForReal })` synchronously swaps
// `data` between the two fixtures (mirrors a resolved re-mint), so the component
// re-renders exactly as it would against the server.
const mintCalls = vi.hoisted(() => ({ inputs: [] as Array<{ runForReal: boolean }> }));
vi.mock('~/utils/trpc', async () => {
  const React = await import('react');
  return {
    trpc: {
      blocks: {
        mintReviewBlockToken: {
          useMutation: () => {
            const [data, setData] = React.useState<MintReviewBlockTokenResult | undefined>(
              undefined
            );
            return {
              data,
              isPending: false,
              isError: false,
              mutate: (input: { publishRequestId: string; runForReal: boolean }) => {
                mintCalls.inputs.push({ runForReal: input.runForReal });
                setData(input.runForReal ? RUN_FOR_REAL_MINT : RENDER_ONLY_MINT);
              },
            };
          },
        },
      },
    },
  };
});

// eslint-disable-next-line import/first
import { ReviewBlockPreviewHost } from '~/components/Apps/ReviewBlockPreviewHost';

beforeEach(() => {
  mintCalls.inputs = [];
  flagState.appBlocksPages = false;
});

function mount() {
  renderWithProviders(
    <ReviewBlockPreviewHost
      publishRequestId="pubreq_X"
      slug="my-app"
      iframeSrc="https://my-app.example/?mr=entry"
    />
  );
}

describe('ReviewBlockPreviewHost — run-for-real opt-in', () => {
  test('DEFAULT is render-only: host gets reviewRunForReal=false, no banner, opt-in offered', async () => {
    mount();
    // The mount effect mints render-only.
    await expect.element(page.getByTestId('page-host')).toBeInTheDocument();
    expect(page.getByTestId('page-host').element().getAttribute('data-rfr')).toBe('false');
    // No active banner; the opt-in control is present.
    expect(page.getByTestId('review-run-for-real-banner').elements()).toHaveLength(0);
    await expect.element(page.getByTestId('review-run-for-real-arm')).toBeInTheDocument();
    // First mint was render-only (runForReal:false).
    expect(mintCalls.inputs[0]).toEqual({ runForReal: false });
  });

  test('arming shows the LOUD consent copy with the exact Buzz cap + "SFW enforced"', async () => {
    mount();
    await page.getByTestId('review-run-for-real-arm').click();

    const consent = page.getByTestId('review-run-for-real-consent');
    await expect.element(consent).toBeInTheDocument();
    const text = consent.element().textContent ?? '';
    expect(text).toContain('UNAPPROVED');
    expect(text).toContain('YOUR account');
    expect(text).toContain(String(REVIEW_RUN_FOR_REAL_BUZZ_CAP));
    expect(text).toContain('SFW enforced');
    // Arming does NOT mint run-for-real yet — only the initial render-only mint ran.
    expect(mintCalls.inputs).toEqual([{ runForReal: false }]);
  });

  test('CONFIRM re-mints runForReal:true → banner shows + host gets reviewRunForReal=true', async () => {
    mount();
    await page.getByTestId('review-run-for-real-arm').click();
    await page.getByTestId('review-run-for-real-confirm').click();

    await expect.element(page.getByTestId('review-run-for-real-banner')).toBeInTheDocument();
    await vi.waitFor(() =>
      expect(page.getByTestId('page-host').element().getAttribute('data-rfr')).toBe('true')
    );
    // The re-mint requested run-for-real.
    expect(mintCalls.inputs.at(-1)).toEqual({ runForReal: true });
  });

  test('EXIT tears down run-for-real → banner clears, host back to render-only', async () => {
    mount();
    await page.getByTestId('review-run-for-real-arm').click();
    await page.getByTestId('review-run-for-real-confirm').click();
    await expect.element(page.getByTestId('review-run-for-real-banner')).toBeInTheDocument();

    await page.getByTestId('review-run-for-real-exit').click();

    await vi.waitFor(() =>
      expect(page.getByTestId('review-run-for-real-banner').elements()).toHaveLength(0)
    );
    await vi.waitFor(() =>
      expect(page.getByTestId('page-host').element().getAttribute('data-rfr')).toBe('false')
    );
    // Exit re-minted render-only.
    expect(mintCalls.inputs.at(-1)).toEqual({ runForReal: false });
  });

  test('CANCEL on the consent gate returns to the opt-in without minting run-for-real', async () => {
    mount();
    await page.getByTestId('review-run-for-real-arm').click();
    await page.getByTestId('review-run-for-real-cancel').click();

    await expect.element(page.getByTestId('review-run-for-real-arm')).toBeInTheDocument();
    expect(page.getByTestId('review-run-for-real-consent').elements()).toHaveLength(0);
    // No run-for-real mint ever happened.
    expect(mintCalls.inputs.every((i) => i.runForReal === false)).toBe(true);
  });
});

// The app-chrome "Recently run" menu links ONLY to `/apps/run/<blockId>`, which
// 404s for a viewer without `appBlocksPages` — on EVERY surface, because that
// route's own gate is on the viewer, not on where the link was clicked from.
// This surface previously passed nothing, so the fail-closed default hid the
// menu even for the mods who DO hold the flag. It must forward the flag, both
// ways. Mutation-sanity: hardcoding `canOpenPage={false}` (or dropping the prop)
// fails the ON case; hardcoding `true` fails the OFF case.
describe('ReviewBlockPreviewHost — forwards the viewer’s appBlocksPages to the host chrome', () => {
  test('flag ON → canOpenPage=true (a mod reviewer keeps the "Recently run" shortcuts)', async () => {
    flagState.appBlocksPages = true;
    mount();
    await expect.element(page.getByTestId('page-host')).toBeInTheDocument();
    expect(page.getByTestId('page-host').element().getAttribute('data-can-open-page')).toBe('true');
  });

  test('flag OFF → canOpenPage=false (no guaranteed-404 links for a pages-dark reviewer)', async () => {
    flagState.appBlocksPages = false;
    mount();
    await expect.element(page.getByTestId('page-host')).toBeInTheDocument();
    expect(page.getByTestId('page-host').element().getAttribute('data-can-open-page')).toBe(
      'false'
    );
  });
});
