import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
// Type-only namespace import for the `importOriginal` spread below (the repo's
// local-rules/no-wholesale-module-mock cure). NOT `typeof import(...)`, which
// @typescript-eslint/consistent-type-imports rejects.
import type * as TrpcMod from '~/utils/trpc';

/**
 * THEME_CHANGE on the PAGE host (`/apps/run/<slug>`, slot `app.page`).
 *
 * THE GAP: the host handed a block its theme exactly once — in `BLOCK_INIT`, and
 * (where the gate is on) in the iframe URL fragment. Neither can move afterwards:
 * the SDK DEDUPES `BLOCK_INIT` (only the first is honored), and
 * `useBlockIframeSrc` deliberately FREEZES the fragment at mount so a toggle
 * can't re-navigate a third-party frame. So a viewer flipping dark mode left
 * every mounted block rendering its mount-time theme until reloaded.
 *
 * 🔴 THIS SUITE IS HALF THE COVERAGE — the exact mirror of
 * `IframeHostThemeChange.browser.test.tsx`. `IframeHost` (model slot) is a
 * SEPARATE surface with its OWN postMessage bridge; the two share no code path,
 * so a fix wired into one is invisible to the other's suite. That the pair
 * EXISTS is pinned structurally by `__tests__/hostThemeChangeParity.test.ts`.
 *
 * On this surface `theme` is a PROP: the route (`/apps/run/[slug]`) computes it
 * from `useComputedColorScheme` and re-renders us on a toggle — which is what
 * the `rerender` below simulates.
 *
 * Mocks mirror `PageBlockHostSignIn.browser.test.tsx` (the page scaffold).
 */
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  // FeatureFlagsProvider (in PageBlockHost's real render graph) statically imports
  // `setTrpcBatchingEnabled` from this module (#2946). vi.mock replaces the module
  // wholesale, so the factory must re-declare it or the ESM link fails.
  setTrpcBatchingEnabled: vi.fn(),
  trpc: {
    // Collection follow/unfollow host bridge (SET_COLLECTION_FOLLOW). Both
    // hosts register the handler, so every host-rendering suite needs these
    // two session-authed mutations present on the mocked client.
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

const SAME_ORIGIN_SRC = `${window.location.origin}/`;

function iframeEl() {
  return page.getByTestId('app-page-iframe').element() as HTMLIFrameElement;
}

function postFromBlock(type: string, payload?: unknown) {
  const cw = iframeEl().contentWindow;
  if (!cw) throw new Error('iframe contentWindow missing');
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { type, payload },
      origin: window.location.origin,
      source: cw,
    })
  );
}

/** Capture host→block posts. `send` targets the iframe's contentWindow. */
function listenForHostPosts() {
  const received: Array<{ type: string; payload: unknown }> = [];
  const cw = iframeEl().contentWindow;
  if (!cw) throw new Error('iframe contentWindow missing');
  const handler = (e: MessageEvent) => {
    const d = e.data as { type?: string; payload?: unknown } | null;
    if (d && typeof d.type === 'string') received.push({ type: d.type, payload: d.payload });
  };
  cw.addEventListener('message', handler);
  return {
    received,
    of: (type: string) => received.filter((m) => m.type === type),
    last: (type: string) => [...received].reverse().find((m) => m.type === type),
    stop: () => cw.removeEventListener('message', handler),
  };
}

/**
 * Tap EVERY host→frame `postMessage`, installed BEFORE render.
 *
 * The `listenForHostPosts` helper above can only attach once the iframe is in
 * the DOM — i.e. after React has committed and flushed effects — so it is
 * structurally blind to anything the host posts on MOUNT. That blindness is
 * exactly what makes the `initSentRef` gate untestable with it: deleting the
 * gate makes the host push THEME_CHANGE on mount, and the listener never sees
 * it. (Measured: that mutation survived the whole suite.)
 *
 * This patches the `contentWindow` GETTER on the prototype and wraps
 * `postMessage` on the real Window it returns. It deliberately returns the REAL
 * window (not a Proxy) so `usePostMessage`'s `event.source === contentWindow`
 * identity pin still holds for the block→host direction.
 */
function tapFramePosts() {
  const desc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
  if (!desc?.get) throw new Error('contentWindow descriptor missing');
  const realGet = desc.get;
  const seen: Array<{ type?: string; payload?: unknown }> = [];
  const patched = new WeakSet<Window>();
  Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
    configurable: true,
    get(this: HTMLIFrameElement) {
      const cw = realGet.call(this) as Window | null;
      if (cw && !patched.has(cw)) {
        patched.add(cw);
        const orig = cw.postMessage.bind(cw);
        (cw as unknown as { postMessage: unknown }).postMessage = (
          msg: unknown,
          target: string
        ) => {
          seen.push(msg as { type?: string });
          return orig(msg as never, target as never);
        };
      }
      return cw;
    },
  });
  return {
    seen,
    restore: () => Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', desc),
  };
}

const baseProps = {
  appBlockId: 'apb_test',
  blockId: 'my-page-app',
  appId: 'app_test',
  blockInstanceId: 'page_apb_test',
  appName: 'Budgeted Generator',
  iframeSrc: SAME_ORIGIN_SRC,
  surface: 'page-run' as const,
  // Required. These suites cover the DEFAULT (host-veil) presentation;
  // the bootSkeleton path is covered in PageBlockHostLaunchReveal.
  bootSkeleton: false,
  sandbox: 'allow-scripts',
  trustTier: 'internal' as const,
  slug: 'my-page-app',
  token: 'tok_abc',
  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  declaredScopes: ['ai:write:budgeted'],
  missingScopes: [] as string[],
  needsConsent: false,
  tokenError: false,
  viewer: null,
};

describe('PageBlockHost THEME_CHANGE (app.page)', () => {
  /**
   * Mount, attach the host→block listener BEFORE the handshake, then ack READY.
   *
   * Order matters: the listener has to be attached while BLOCK_INIT posts are
   * still flowing, so every assertion below rests on a listener PROVEN to
   * observe real host pushes. Attaching it after READY would leave a quiet
   * channel, and a `toHaveLength(0)` on a probe wired to nothing is
   * indistinguishable from a genuine zero.
   */
  async function mountAndReady(theme: 'light' | 'dark') {
    const { rerender } = await renderWithProviders(<PageBlockHost {...baseProps} theme={theme} />);
    await vi.waitFor(() => {
      if (!iframeEl().contentWindow) throw new Error('not mounted yet');
    });
    const posts = listenForHostPosts();
    // POSITIVE CONTROL: the listener sees the host's own BLOCK_INIT.
    await vi.waitFor(() => {
      if (posts.of('BLOCK_INIT').length === 0) throw new Error('listener saw no BLOCK_INIT');
    });
    await vi.waitFor(() => {
      postFromBlock('BLOCK_READY', {});
      if (iframeEl().getAttribute('data-block-ready') !== 'true') throw new Error('not ready yet');
    });
    return { rerender, posts };
  }

  test('a mid-session theme toggle pushes THEME_CHANGE with the new theme', async () => {
    const { rerender, posts } = await mountAndReady('light');
    expect(posts.of('THEME_CHANGE')).toHaveLength(0);

    await rerender(<PageBlockHost {...baseProps} theme="dark" />);

    await vi.waitFor(() => {
      const m = posts.last('THEME_CHANGE');
      if (!m) throw new Error('no THEME_CHANGE yet');
      expect(m.payload).toEqual({ theme: 'dark' });
    });
    posts.stop();
  });

  test('toggling back pushes again — not a one-shot latch', async () => {
    const { rerender, posts } = await mountAndReady('light');

    await rerender(<PageBlockHost {...baseProps} theme="dark" />);
    await vi.waitFor(() => expect(posts.of('THEME_CHANGE')).toHaveLength(1));

    await rerender(<PageBlockHost {...baseProps} theme="light" />);
    await vi.waitFor(() => expect(posts.of('THEME_CHANGE')).toHaveLength(2));
    expect(posts.of('THEME_CHANGE').map((m) => m.payload)).toEqual([
      { theme: 'dark' },
      { theme: 'light' },
    ]);
    posts.stop();
  });

  test('an unrelated re-render (same theme) pushes NOTHING', async () => {
    const { rerender, posts } = await mountAndReady('dark');

    // Same theme, a different unrelated prop. The effect's deps are
    // [theme, send] — a re-render must not spam the frame.
    await rerender(<PageBlockHost {...baseProps} theme="dark" appName="Renamed" />);
    await new Promise((r) => setTimeout(r, 150));
    expect(posts.of('THEME_CHANGE')).toHaveLength(0);
    posts.stop();
  });

  test('a pre-ack toggle is not lost — the retried BLOCK_INIT carries the CURRENT theme', async () => {
    // The load-bearing property: a toggle that lands before the block has ACKED
    // cannot strand it. The retry-until-ready controller rebuilds the payload on
    // every tick, so the BLOCK_INIT the block finally receives holds the theme
    // as of that moment — even if the standalone push went out into a frame that
    // was not listening yet.
    //
    // 🔴 Deliberately NOT asserting "no push happened here". `initSentRef` flips
    // on the first BLOCK_INIT *POST*, not on BLOCK_READY, and that post happens
    // as soon as the controller starts — so whether a pre-ack toggle also pushes
    // is a race with the controller's first tick. Pinning either outcome would
    // be pinning the race. What must hold in BOTH orderings is the assertion
    // below.
    const { rerender } = await renderWithProviders(<PageBlockHost {...baseProps} theme="light" />);
    await vi.waitFor(() => {
      if (!iframeEl().contentWindow) throw new Error('not mounted yet');
    });
    const posts = listenForHostPosts();

    await rerender(<PageBlockHost {...baseProps} theme="dark" />);

    await vi.waitFor(() => {
      const init = posts.last('BLOCK_INIT');
      if (!init) throw new Error('no BLOCK_INIT yet');
      expect((init.payload as { theme: string }).theme).toBe('dark');
    });
    posts.stop();
  });

  test('pushes NOTHING before the first BLOCK_INIT — the initSentRef gate', async () => {
    // NEGATIVE CONTROL WITH A REAL INSTRUMENT: the tap is installed before
    // render, so it CAN observe a mount-time post. Without the gate the host
    // pushes THEME_CHANGE on mount and this reads THEME_CHANGE first.
    const tap = tapFramePosts();
    try {
      await renderWithProviders(<PageBlockHost {...baseProps} theme="dark" />);
      // POSITIVE CONTROL: the tap observes real traffic.
      await vi.waitFor(() => {
        if (tap.seen.length === 0) throw new Error('tap saw nothing at all');
      });
      // Settle: give any post-init effect a chance to fire before asserting.
      await new Promise((r) => setTimeout(r, 300));
      expect(tap.seen[0]?.type).toBe('BLOCK_INIT');
      expect(tap.seen.filter((m) => m?.type === 'THEME_CHANGE')).toHaveLength(0);
    } finally {
      tap.restore();
    }
  });
});
