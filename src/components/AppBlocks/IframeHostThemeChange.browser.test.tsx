import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
// Type-only namespace import for the `importOriginal` spread below (the repo's
// local-rules/no-wholesale-module-mock cure). NOT `typeof import(...)`, which
// @typescript-eslint/consistent-type-imports rejects.
import type * as TrpcMod from '~/utils/trpc';

/**
 * THEME_CHANGE on the MODEL-SLOT host (`model.sidebar_top`).
 *
 * THE GAP: the host handed a block its theme exactly once — in `BLOCK_INIT`, and
 * (where the gate is on) in the iframe URL fragment. Neither can move afterwards:
 * the SDK DEDUPES `BLOCK_INIT` (only the first is honored), and
 * `useBlockIframeSrc` deliberately FREEZES the fragment at mount so a toggle
 * can't re-navigate a third-party frame. So a viewer flipping dark mode left
 * every mounted block rendering its mount-time theme until reloaded.
 *
 * 🔴 THIS SUITE IS HALF THE COVERAGE. `PageBlockHost` is a SEPARATE surface with
 * its OWN postMessage bridge — the two share no code path — so it has its own
 * mirror of this file, and `__tests__/hostThemeChangeParity.test.ts` pins that
 * BOTH exist. Wiring one host and not the other is the classic miss here, and no
 * single-surface suite can see it.
 *
 * Mocks mirror `IframeHost.browser.test.tsx` (the model-slot scaffold): the two
 * tRPC queries IframeHost drives at render must report `isLoading: false` so the
 * init handshake is allowed to start.
 */
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

// 🔴 `useOptionalFeatureFlags` IS LISTED TOO, AND OMITTING IT BREAKS THE WHOLE FILE.
// This factory REPLACES the module (deliberately — see the note above), so it must
// name every export anything in this file's module graph imports. The app-block
// chrome's breadcrumb crumb reads `useOptionalFeatureFlags` for its store gate (the
// non-throwing variant, because the chrome renders outside a provider), and the day
// it started doing so this factory stopped satisfying the link:
//   SyntaxError: The requested module '/src/providers/FeatureFlagsProvider.tsx'
//   does not provide an export named 'useOptionalFeatureFlags'
//
// 🔴 THE FILE THEN FAILS TO IMPORT, WHICH IS NOT THE SAME AS FAILING. Nothing is
// collected, so the run reported `Test Files 6 failed` alongside `Tests 374 passed`
// — zero failing ASSERTIONS. Anything reading a failure count, or a per-test
// summary, sees success. Read the FILE count, not the test count.
//
// Both hooks return the SAME flags: the gate must be decided by this fixture, not
// by which of the two a component happens to call.
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ appBlocks: false, appBlocksPages: false }),
  useOptionalFeatureFlags: () => ({ appBlocks: false, appBlocksPages: false }),
}));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: {
    // Collection follow/unfollow host bridge (SET_COLLECTION_FOLLOW). Both
    // hosts register the handler, so every host-rendering suite needs these
    // two session-authed mutations present on the mocked client.
    collection: {
      follow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      unfollow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
    },
    blocks: {
      getEffectiveCheckpoint: {
        useQuery: () => ({ data: { checkpoint: null }, isLoading: false }),
      },
      getShowcaseImages: {
        useQuery: () => ({ data: [], isLoading: false }),
      },
      submitWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      estimateWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      pollWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      cancelWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      updateUserSettings: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      getMyBuzzBalance: { useMutation: () => ({ mutateAsync: vi.fn() }) },
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

vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', () => ({
  useBrowsingLevelDebounced: () => 1,
}));

// eslint-disable-next-line import/first
import { IframeHost } from '~/components/AppBlocks/IframeHost';
// eslint-disable-next-line import/first
import type { BlockInstall, ModelSlotContext } from '~/components/AppBlocks/types';

const SAME_ORIGIN_SRC = `${window.location.origin}/`;

function iframeEl() {
  return page.getByTestId('block-iframe').element() as HTMLIFrameElement;
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

const install: BlockInstall = {
  blockInstanceId: 'inst_test',
  blockId: 'my-model-app',
  appId: 'app_test',
  appBlockId: 'apb_test',
  manifest: {
    name: 'Background Remover',
    scopes: ['ai:write:budgeted'],
    iframe: {
      src: SAME_ORIGIN_SRC,
      minHeight: 200,
      maxHeight: 800,
      resizable: true,
      sandbox: 'allow-scripts',
    },
  },
  publisherSettings: {},
  enabled: true,
  renderMode: 'iframe',
  trustTier: 'internal',
};

function contextWithTheme(theme: 'light' | 'dark'): ModelSlotContext {
  return {
    slotId: 'model.sidebar_top',
    entityType: 'model',
    modelId: 123,
    modelVersionId: 456,
    modelName: 'Some Model',
    modelType: 'Checkpoint',
    modelNsfwLevel: 1,
    creatorUserId: 7,
    viewerUserId: 42,
    viewerNsfwEnabled: false,
    viewerUsername: 'tester',
    theme,
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
  install,
  token: 'tok_abc',
  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
};

describe('IframeHost THEME_CHANGE (model.sidebar_top)', () => {
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
    const { rerender } = await renderWithProviders(
      <IframeHost {...baseProps} context={contextWithTheme(theme)} />
    );
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

    // The viewer toggles dark mode: ModelVersionDetails re-renders the slot with
    // a new `context.theme` (it threads a live useComputedColorScheme down).
    await rerender(<IframeHost {...baseProps} context={contextWithTheme('dark')} />);

    await vi.waitFor(() => {
      const m = posts.last('THEME_CHANGE');
      if (!m) throw new Error('no THEME_CHANGE yet');
      expect(m.payload).toEqual({ theme: 'dark' });
    });
    posts.stop();
  });

  test('toggling back pushes again — not a one-shot latch', async () => {
    const { rerender, posts } = await mountAndReady('light');

    await rerender(<IframeHost {...baseProps} context={contextWithTheme('dark')} />);
    await vi.waitFor(() => expect(posts.of('THEME_CHANGE')).toHaveLength(1));

    await rerender(<IframeHost {...baseProps} context={contextWithTheme('light')} />);
    await vi.waitFor(() => expect(posts.of('THEME_CHANGE')).toHaveLength(2));
    expect(posts.of('THEME_CHANGE').map((m) => m.payload)).toEqual([
      { theme: 'dark' },
      { theme: 'light' },
    ]);
    posts.stop();
  });

  test('an unrelated re-render (same theme) pushes NOTHING', async () => {
    const { rerender, posts } = await mountAndReady('dark');

    // Same theme, a different unrelated context field. The effect's deps are
    // [activeTheme, send] — a re-render must not spam the frame.
    await rerender(
      <IframeHost {...baseProps} context={{ ...contextWithTheme('dark'), modelName: 'Renamed' }} />
    );
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
    const { rerender } = await renderWithProviders(
      <IframeHost {...baseProps} context={contextWithTheme('light')} />
    );
    await vi.waitFor(() => {
      if (!iframeEl().contentWindow) throw new Error('not mounted yet');
    });
    const posts = listenForHostPosts();

    await rerender(<IframeHost {...baseProps} context={contextWithTheme('dark')} />);

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
      await renderWithProviders(<IframeHost {...baseProps} context={contextWithTheme('dark')} />);
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
