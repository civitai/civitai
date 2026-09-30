// The scaffold's `next/router` mock exports ONE router singleton as `default`,
// `Router` and the `useRouter()` return value alike. Taking the default import
// gets the same object without calling a hook at module scope (which
// react-hooks/rules-of-hooks correctly rejects — it is not a hook call here, but
// it is indistinguishable from one to the rule).
import Router from 'next/router';
import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
// Type-only namespace import, NOT `typeof import('…')` — the latter is rejected by
// @typescript-eslint/consistent-type-imports. Used by the `importOriginal` spread below.
import type * as TrpcModule from '~/utils/trpc';

/**
 * W10 NAVIGATE bridge — the HOST-INTEGRATION half of #5209.
 *
 * `resolveNavigateRequest`'s own contract is unit-tested in
 * `__tests__/pageBlockHostLogic.test.ts`. That suite cannot see the SEAM, which is
 * where the defect actually lived: the handler discarded the leading slash before
 * calling anything, read `payload.target` nowhere at all (its message generic was
 * literally `onMessage<{ path?: unknown } | undefined>`), and pushed every
 * destination shallowly. Three independent ways to be resolution-correct and
 * still broken, none of them visible to a pure test.
 *
 * So this file mounts the REAL `PageBlockHost` and drives the REAL postMessage
 * bridge, asserting what reaches `router.push` / `window.open` for each case:
 *
 *   1. `/models/500?modelVersionId=1001` → `router.push('/models/500?modelVersionId=1001')`
 *      with NO shallow option. 🔴 THE #5209 REGRESSION — before the fix this was
 *      `router.push('/apps/run/<slug>/models/500?...', undefined, { shallow: true })`,
 *      i.e. the URL bar changed and the page did not.
 *   2. `detail/500` → the app-scoped shallow push, unchanged.
 *   3. `target: 'new_tab'` → `window.open`, and NOT `router.push`. Before the fix
 *      `target` was ignored, so a new-tab request became a same-tab navigation —
 *      punching the viewer out of the app mid-task.
 *   4. the surface decides the app-scoped base (`private-run` ≠ `page-run`).
 *   5. the review surface navigates NOWHERE, in either scope.
 *   6. `/api/*` is refused site-absolute; pre-handshake posts are dropped.
 *
 * ⚠️ WHAT THIS FILE STRUCTURALLY CANNOT SEE, stated so nobody reads it as wider
 * than it is: the `new_tab` open must be SYNCHRONOUS inside the message handler,
 * because the user activation it relies on is transient (measured: deferring the
 * same open by 6s is blocked by the browser). A test that asserts only "window.open
 * was called" stays green if someone puts an `await` in front of it. There is no
 * user activation in a driven MessageEvent, so this cannot be tested here at all —
 * the constraint is recorded at the call site instead.
 */

// AppBlockChrome (in the host frame) calls useCurrentUser() for the platform-nav
// moderator gate; these suites render the real host without a CivitaiSessionProvider.
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

// 🔴 SPREAD the real module and override only `trpc`, rather than the wholesale
// factory the sibling PageBlockHost suites use. Those predate
// `local-rules/no-wholesale-module-mock` and are red on it today: a hand-written
// replacement object silently drops any export it forgot, and the failure mode is
// the whole FILE collecting 0 tests with no failing assertion — a green that
// measures nothing. Spreading means a future export of `~/utils/trpc` arrives
// intact instead of as `undefined`.
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: {
    collection: {
      follow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      unfollow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
    },
    generation: { resolveWildcardPack: { useMutation: () => ({ mutateAsync: vi.fn() }) } },
    blocks: {
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
      previewPostFromApp: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      createPostFromApp: { useMutation: () => ({ mutateAsync: vi.fn() }) },
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

// eslint-disable-next-line import/first
import { PageBlockHost } from '~/components/AppBlocks/PageBlockHost';

const router = Router;

function postFromBlock(type: string, payload?: unknown) {
  const iframeEl = page.getByTestId('app-page-iframe').element() as HTMLIFrameElement;
  const cw = iframeEl.contentWindow;
  if (!cw) throw new Error('iframe contentWindow missing');
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { type, payload },
      origin: window.location.origin,
      source: cw,
    })
  );
}

const SAME_ORIGIN_SRC = `${window.location.origin}/`;

const baseProps = {
  appBlockId: 'apb_test',
  blockId: 'my-page-app',
  appId: 'app_test',
  blockInstanceId: 'page_apb_test',
  appName: 'Model Benchmarking',
  iframeSrc: SAME_ORIGIN_SRC,
  surface: 'page-run' as const,
  bootSkeleton: false,
  sandbox: 'allow-scripts',
  trustTier: 'internal' as const,
  slug: 'my-page-app',
  token: 'tok_abc',
  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  declaredScopes: [] as string[],
  missingScopes: [] as string[],
  needsConsent: false,
  tokenError: false,
  viewer: null,
  theme: 'light' as const,
};

async function driveToReady() {
  await vi.waitFor(() => {
    const el = page.getByTestId('app-page-iframe').element() as HTMLIFrameElement;
    if (!el.contentWindow) throw new Error('not mounted yet');
  });
  await vi.waitFor(() => {
    postFromBlock('BLOCK_READY', {});
    const el = page.getByTestId('app-page-iframe').element() as HTMLIFrameElement;
    if (el.getAttribute('data-block-ready') !== 'true') throw new Error('not ready yet');
  });
}

describe('PageBlockHost NAVIGATE bridge (#5209)', () => {
  let openSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    (router.push as unknown as ReturnType<typeof vi.fn>).mockClear();
    // Stub rather than let a real tab open during the run. The `noopener` feature
    // string makes the real return value null even on success, so nothing in the
    // host reads it and returning undefined is faithful.
    openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
  });

  afterEach(() => {
    openSpy.mockRestore();
  });

  test('site-absolute path lands on the SITE route, non-shallow (the #5209 regression)', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();

    postFromBlock('NAVIGATE', { path: '/models/500?modelVersionId=1001' });

    await vi.waitFor(() => {
      expect(router.push).toHaveBeenCalledTimes(1);
    });
    // The literal expected call. Pre-fix this was
    // ('/apps/run/my-page-app/models/500?modelVersionId=1001', undefined, { shallow: true }).
    expect(router.push).toHaveBeenCalledWith(
      '/models/500?modelVersionId=1001',
      undefined,
      undefined
    );
    // Stated separately so a partial fix (right href, still shallow) cannot pass:
    // a shallow push at a site route changes the URL and renders nothing.
    const [, , options] = (router.push as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(options).toBeUndefined();
  });

  test('app-scoped (no leading slash) still pushes the shallow sub-path', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();

    postFromBlock('NAVIGATE', { path: 'detail/500' });

    await vi.waitFor(() => {
      expect(router.push).toHaveBeenCalledTimes(1);
    });
    expect(router.push).toHaveBeenCalledWith('/apps/run/my-page-app/detail/500', undefined, {
      shallow: true,
    });
  });

  test("target:'new_tab' is opened BY THE HOST, and does not navigate the current tab", async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();

    postFromBlock('NAVIGATE', { path: '/models/500', target: 'new_tab' });

    await vi.waitFor(() => {
      expect(openSpy).toHaveBeenCalledTimes(1);
    });
    expect(openSpy).toHaveBeenCalledWith('/models/500', '_blank', 'noopener');
    // 🔴 The half that was broken: `target` was read NOWHERE, so this request used
    // to fall through to a same-tab push.
    expect(router.push).not.toHaveBeenCalled();
  });

  test("target:'current' does NOT open a tab (control for the assertion above)", async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();

    postFromBlock('NAVIGATE', { path: '/models/500', target: 'current' });

    await vi.waitFor(() => {
      expect(router.push).toHaveBeenCalledTimes(1);
    });
    expect(openSpy).not.toHaveBeenCalled();
  });

  test('the app-scoped base follows the SURFACE — private-run keeps its own route', async () => {
    // A hardcoded `/apps/run` here sends the viewer to the PUBLIC run route, which
    // requires `status: 'approved'` and therefore 404s for the very suspended app
    // they are looking at.
    renderWithProviders(<PageBlockHost {...baseProps} surface="private-run" />);
    await driveToReady();

    postFromBlock('NAVIGATE', { path: 'detail' });

    await vi.waitFor(() => {
      expect(router.push).toHaveBeenCalledTimes(1);
    });
    expect(router.push).toHaveBeenCalledWith('/apps/private-run/my-page-app/detail', undefined, {
      shallow: true,
    });
  });

  test('the review surface navigates NOWHERE — app-scoped OR site-absolute', async () => {
    // An unreviewed block must not be able to move a moderator's tab. Two
    // independent refusals cover this (the `reviewMode` prop and a `null` deep-link
    // base); the mount passes both props exactly as ReviewBlockPreviewHost does.
    renderWithProviders(<PageBlockHost {...baseProps} surface="review-preview" reviewMode />);
    await driveToReady();

    postFromBlock('NAVIGATE', { path: 'detail' });
    postFromBlock('NAVIGATE', { path: '/models/500' });
    postFromBlock('NAVIGATE', { path: '/models/500', target: 'new_tab' });

    await new Promise((r) => setTimeout(r, 150));
    expect(router.push).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
  });

  test('site-absolute /api/* is refused (a block cannot sign the viewer out)', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();

    postFromBlock('NAVIGATE', { path: '/api/auth/signout' });
    postFromBlock('NAVIGATE', { path: '/api/auth/signout', target: 'new_tab' });

    await new Promise((r) => setTimeout(r, 150));
    expect(router.push).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();

    // Positive control, same mount: an ordinary site route from the same block DOES
    // navigate — so the two zeros above are a measurement of the exclusion and not
    // of a bridge that is wired to nothing.
    postFromBlock('NAVIGATE', { path: '/models/500' });
    await vi.waitFor(() => {
      expect(router.push).toHaveBeenCalledWith('/models/500', undefined, undefined);
    });
  });

  test('an off-origin destination is refused in both targets', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();

    for (const path of ['https://evil.example/steal', '//evil.example', 'javascript:alert(1)']) {
      postFromBlock('NAVIGATE', { path });
      postFromBlock('NAVIGATE', { path, target: 'new_tab' });
    }

    await new Promise((r) => setTimeout(r, 150));
    expect(router.push).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
  });

  test('NAVIGATE before BLOCK_READY is dropped (pre-handshake blocks cannot drive nav)', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await vi.waitFor(() => {
      const el = page.getByTestId('app-page-iframe').element() as HTMLIFrameElement;
      if (!el.contentWindow) throw new Error('not mounted yet');
    });

    postFromBlock('NAVIGATE', { path: '/models/500' });

    await new Promise((r) => setTimeout(r, 150));
    expect(router.push).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
  });
});
