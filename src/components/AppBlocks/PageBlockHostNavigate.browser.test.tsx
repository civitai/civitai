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

  test("scope:'site' lands on the SITE route, non-shallow (the #5209 regression)", async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();

    postFromBlock('NAVIGATE', { scope: 'site', path: '/models/500?modelVersionId=1001' });

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

  test("a leading slash is irrelevant to scope:'site' — both spellings push the same href", async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();

    postFromBlock('NAVIGATE', { scope: 'site', path: '/generate' });
    postFromBlock('NAVIGATE', { scope: 'site', path: 'generate' });

    await vi.waitFor(() => {
      expect(router.push).toHaveBeenCalledTimes(2);
    });
    const calls = (router.push as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]).toEqual(['/generate', undefined, undefined]);
    expect(calls[1]).toEqual(['/generate', undefined, undefined]);
  });

  test('🔴 back-compat: an ABSOLUTE path with NO scope is APP-scoped, through the real bridge', async () => {
    // 🔴 THE REGRESSION A SLASH-KEYED CONTRACT WOULD HAVE SHIPPED. Every block
    // deployed today sends no `scope`, and `/settings` is the ordinary SPA spelling
    // of an app's OWN route — a page block owns a whole sub-path space. Under the
    // slash rule this call left the app; here it must not.
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();

    postFromBlock('NAVIGATE', { path: '/settings' });

    await vi.waitFor(() => {
      expect(router.push).toHaveBeenCalledTimes(1);
    });
    expect(router.push).toHaveBeenCalledWith('/apps/run/my-page-app/settings', undefined, {
      shallow: true,
    });
  });

  test('app-scoped (no scope field) still pushes the shallow sub-path', async () => {
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

  test('🔴 a non-ASCII app sub-path navigates, percent-encoded (worked at the merge base)', async () => {
    // 🔴 The app-scope half of the byte-equality regression, measured through the
    // real postMessage bridge rather than only at the resolver: at the merge base
    // there was no resolver and this pushed `/apps/run/<slug>/José`; the fixpoint
    // rule dropped it silently, with no NACK for the block to notice.
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();

    postFromBlock('NAVIGATE', { path: 'José/2' });

    await vi.waitFor(() => {
      expect(router.push).toHaveBeenCalledTimes(1);
    });
    expect(router.push).toHaveBeenCalledWith('/apps/run/my-page-app/Jos%C3%A9/2', undefined, {
      shallow: true,
    });
  });

  test("target:'new_tab' is opened BY THE HOST, and does not navigate the current tab", async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();

    postFromBlock('NAVIGATE', { scope: 'site', path: '/models/500', target: 'new_tab' });

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

    postFromBlock('NAVIGATE', { scope: 'site', path: '/models/500', target: 'current' });

    await vi.waitFor(() => {
      expect(router.push).toHaveBeenCalledTimes(1);
    });
    expect(openSpy).not.toHaveBeenCalled();
  });

  test('private-run still performs APP-SCOPED navigation, at the shared run base', async () => {
    // ⚠️ THIS CASE NO LONGER DISCRIMINATES A HARDCODED BASE, AND IT USED TO. It was
    // named "the app-scoped base follows the SURFACE — private-run keeps its own
    // route" and asserted `/apps/private-run/<slug>/detail`, on the argument that a
    // hardcoded `/apps/run` would send the viewer to the approved-only public route
    // and 404 the very suspended app they were looking at. #5255 deleted that route:
    // the private run is now served BY `/apps/run/<slug>`, so
    // `BLOCK_HOST_DEEP_LINK_BASE['private-run']` is `'/apps/run'` by design and this
    // assertion would pass against a hardcoded base. Renamed to the property it
    // still pins — that `private-run` navigates app-scoped AT ALL, which is the
    // positive control the site-capability case below depends on. What still pins
    // the per-surface lookup is the `null` pair (`review-preview`, `model-slot`),
    // asserted in the review case further down.
    renderWithProviders(<PageBlockHost {...baseProps} surface="private-run" />);
    await driveToReady();

    postFromBlock('NAVIGATE', { path: 'detail' });

    await vi.waitFor(() => {
      expect(router.push).toHaveBeenCalledTimes(1);
    });
    expect(router.push).toHaveBeenCalledWith('/apps/run/my-page-app/detail', undefined, {
      shallow: true,
    });
  });

  test('🔴 private-run refuses SITE scope while KEEPING app scope', async () => {
    // 🔴 THE PER-SURFACE CAPABILITY, through the real bridge. That surface resolves
    // an audience including `moderator`, serves suspended and delisted apps, and
    // passes no `reviewMode` — so site navigation there would let a suspended app
    // move a moderator's tab to any page route. App-scoped deep-linking inside the
    // owner's own preview is what the surface is for and stays working, which is
    // why this is a capability rather than another `null` base.
    //
    // 🔴 AND SINCE #5255 THIS IS THE ONLY HOST-SIDE DIFFERENCE BETWEEN THE TWO RUN
    // SURFACES. The private run no longer has its own route, so its deep-link base
    // is the same `'/apps/run'` `page-run` carries — the positive control below is
    // byte-identical to the one a `page-run` mount would produce. The two zeros
    // above are therefore the whole discrimination, which is what makes this case
    // load-bearing rather than a restatement of the base map.
    renderWithProviders(<PageBlockHost {...baseProps} surface="private-run" />);
    await driveToReady();

    postFromBlock('NAVIGATE', { scope: 'site', path: '/models/500' });
    postFromBlock('NAVIGATE', { scope: 'site', path: '/models/500', target: 'new_tab' });
    postFromBlock('NAVIGATE', { scope: 'site', path: '/generate' });

    await new Promise((r) => setTimeout(r, 150));
    expect(router.push).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();

    // Positive control, same mount, and it is the exact discriminator: an APP-scoped
    // request on this very surface DOES navigate. So the two zeros above measure the
    // site capability specifically, not a bridge wired to nothing and not a host
    // that refuses everything on `private-run`.
    postFromBlock('NAVIGATE', { path: 'detail' });
    await vi.waitFor(() => {
      expect(router.push).toHaveBeenCalledWith('/apps/run/my-page-app/detail', undefined, {
        shallow: true,
      });
    });
  });

  test('the review surface navigates NOWHERE — app scope OR site scope', async () => {
    // An unreviewed block must not be able to move a moderator's tab. THREE
    // independent refusals cover this (the `reviewMode` prop, a `null` deep-link
    // base, and a `false` site-navigation capability); the mount passes both props
    // exactly as ReviewBlockPreviewHost does.
    renderWithProviders(<PageBlockHost {...baseProps} surface="review-preview" reviewMode />);
    await driveToReady();

    postFromBlock('NAVIGATE', { path: 'detail' });
    postFromBlock('NAVIGATE', { scope: 'site', path: '/models/500' });
    postFromBlock('NAVIGATE', { scope: 'site', path: '/models/500', target: 'new_tab' });

    await new Promise((r) => setTimeout(r, 150));
    expect(router.push).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();

    // Positive control, same mount. A navigation control is structurally
    // impossible here — the surface refuses EVERY destination, which is the whole
    // assertion — so the control is on the BRIDGE instead: `data-block-ready` is
    // set by the host only after it processed a `postFromBlock('BLOCK_READY')`,
    // so it still reading `true` at the moment of measurement proves messages from
    // this helper are reaching a live host. A silently-broken `postFromBlock` or
    // `driveToReady` cannot satisfy this, and the three payloads above are each
    // shown to DO navigate on the `page-run` surface by the earlier tests in this
    // file — that is the non-zero half of the pair.
    const iframe = page.getByTestId('app-page-iframe').element();
    expect(iframe.getAttribute('data-block-ready')).toBe('true');
  });

  test('site-scope /api/* is refused (a block cannot sign the viewer out)', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();

    postFromBlock('NAVIGATE', { scope: 'site', path: '/api/auth/logout' });
    postFromBlock('NAVIGATE', { scope: 'site', path: '/api/auth/logout', target: 'new_tab' });
    postFromBlock('NAVIGATE', { scope: 'site', path: 'api/auth/logout' });

    await new Promise((r) => setTimeout(r, 150));
    expect(router.push).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();

    // Positive control, same mount: an ordinary site route from the same block DOES
    // navigate — so the two zeros above are a measurement of the exclusion and not
    // of a bridge that is wired to nothing.
    postFromBlock('NAVIGATE', { scope: 'site', path: '/models/500' });
    await vi.waitFor(() => {
      expect(router.push).toHaveBeenCalledWith('/models/500', undefined, undefined);
    });
  });

  test('an off-origin destination is refused in both targets', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();

    for (const path of [
      'https://evil.example/steal',
      '//evil.example',
      'javascript:alert(1)',
      // The percent-encoded dot-segment family (#5250 F1). These are not off-origin,
      // but they resolve to the refused `/api/auth/logout` and belong on the same
      // bridge assertion: `window.open` resolves the string with no Next involved,
      // and `router.push` gets Next's `new URL`-normalised pathname.
      '/%2e%2e/api/auth/logout',
      '/%2E%2E/api/auth/logout',
      '/%2e/api/auth/logout',
      '/.%2e/api/auth/logout',
      '/%2e./api/auth/logout',
      '/models/%2e%2e/api/auth/logout',
    ]) {
      postFromBlock('NAVIGATE', { scope: 'site', path });
      postFromBlock('NAVIGATE', { scope: 'site', path, target: 'new_tab' });
    }

    await new Promise((r) => setTimeout(r, 150));
    expect(router.push).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();

    // Positive control, same mount: an ordinary site route from the same block DOES
    // navigate, so the two zeros above measure the refusals and not a bridge wired
    // to nothing. Without this, a silently-broken `driveToReady`/`postFromBlock`
    // satisfies both `not.toHaveBeenCalled()` assertions vacuously.
    postFromBlock('NAVIGATE', { scope: 'site', path: '/models/500' });
    await vi.waitFor(() => {
      expect(router.push).toHaveBeenCalledWith('/models/500', undefined, undefined);
    });
  });

  test('the same off-origin and encoded-traversal set is refused in APP space too', async () => {
    // A `scope` field is untrusted input like any other, so NEITHER space may
    // reach these. Split from the site-space test above rather than folded into
    // it: posting all four variants per path in one mount floods the bridge and
    // the trailing positive control never lands (measured — the control failed
    // with 0 router calls, which would have read as a refusal defect).
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();

    for (const path of [
      'https://evil.example/steal',
      '//evil.example',
      'javascript:alert(1)',
      '/%2e%2e/api/auth/logout',
      '/%2E%2E/api/auth/logout',
      '/%2e/api/auth/logout',
      '/.%2e/api/auth/logout',
      '/%2e./api/auth/logout',
      '/models/%2e%2e/api/auth/logout',
    ]) {
      postFromBlock('NAVIGATE', { path });
    }

    await new Promise((r) => setTimeout(r, 150));
    expect(router.push).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();

    // Positive control, same mount, in the SAME space: an ordinary app sub-path
    // DOES navigate, so the zeros above measure the refusals and not a bridge
    // wired to nothing.
    postFromBlock('NAVIGATE', { path: 'detail' });
    await vi.waitFor(() => {
      expect(router.push).toHaveBeenCalledWith('/apps/run/my-page-app/detail', undefined, {
        shallow: true,
      });
    });
  });

  test('NAVIGATE before BLOCK_READY is dropped (pre-handshake blocks cannot drive nav)', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await vi.waitFor(() => {
      const el = page.getByTestId('app-page-iframe').element() as HTMLIFrameElement;
      if (!el.contentWindow) throw new Error('not mounted yet');
    });

    postFromBlock('NAVIGATE', { scope: 'site', path: '/models/500' });

    await new Promise((r) => setTimeout(r, 150));
    expect(router.push).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();

    // Positive control, same mount, and it is the exact discriminator: complete the
    // handshake and post the SAME payload. It navigates. So the zero above is a
    // measurement of the pre-handshake gate specifically — not of a bridge that was
    // never wired, and not of a host that refuses `/models/500` for some other
    // reason.
    await driveToReady();
    postFromBlock('NAVIGATE', { scope: 'site', path: '/models/500' });
    await vi.waitFor(() => {
      expect(router.push).toHaveBeenCalledWith('/models/500', undefined, undefined);
    });
  });
});
