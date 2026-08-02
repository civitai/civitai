import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup } from 'vitest-browser-react';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import {
  MAX_REFRESH_RETRIES,
  REFRESH_RETRY_BACKOFF_MS,
} from '~/components/AppBlocks/blockTokenRetry';

/**
 * MODEL SLOT — a transient token-refresh failure must NOT erase the block.
 *
 * 🔴 THE DEFECT. `BlockHost` did `if (error) return null`, so ANY mint failure —
 * including a momentary mid-session refresh blip — collapsed the slot. That
 * unmounted `IframeHost`, destroying whatever the user had in progress, and the
 * eventual recovery REMOUNTED it: a fresh BLOCK_INIT and, because the impression
 * beacon's emit-once guard is per IframeHost MOUNT, a SECOND impression beacon
 * for one logical view. PR #3480 fixed the beacon's per-mount semantics on the
 * page host; nothing stopped the model slot from manufacturing extra mounts.
 *
 * 🔴 THIS SUITE EXERCISES THE REAL PATH. It renders the REAL `BlockHost` driving
 * the REAL `useBlockToken` against a stubbed `fetch` — the network boundary, i.e.
 * the failure being injected. The hook is NOT mocked: mocking it as a constant
 * would remove the very state transitions under test (and make the fiber
 * quiescent, the exact blind spot documented in IframeHostReadyTransition).
 *
 * The load-bearing assertion is DOM NODE IDENTITY: React reuses the same <iframe>
 * element iff it never unmounted. A remount is otherwise invisible in a snapshot —
 * the markup looks identical — which is precisely how this shipped.
 */

// AppBlockChrome calls useCurrentUser() for the platform-nav moderator gate.
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

// 🔴 IframeHost calls useFeatureFlags() (added by #3497 for the in-host "open the
// page" affordance) and the REAL hook THROWS without a FeatureFlagsProvider, which
// this scaffold does not mount. Without this the whole subtree crashes at mount:
// `BlockHost` renders NOTHING, `waitForIframe` times out as "iframe never mounted",
// and — worse — the three absence-asserting tests still PASS, because an empty DOM
// trivially satisfies "collapsed to null". Same whole-module-factory shape and the
// same dark-flag defaults as the sibling IframeHost.browser.test.tsx, deliberately
// not an `importOriginal` spread.
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ appBlocks: false, appBlocksPages: false }),
}));

// IframeHost drives two tRPC queries at render plus the SDK bridges. Stub them so
// the host mounts network-free AND the init handshake may start immediately
// (getEffectiveCheckpoint must report isLoading:false so `shouldStartInit` fires).
vi.mock('~/utils/trpc', () => ({
  // FeatureFlagsProvider (in the render graph) statically imports this; a
  // wholesale module mock MUST re-declare it or the ESM link fails.
  setTrpcBatchingEnabled: vi.fn(),
  trpc: {
    blocks: {
      getEffectiveCheckpoint: {
        useQuery: () => ({ data: { checkpoint: null }, isLoading: false }),
      },
      getShowcaseImages: { useQuery: () => ({ data: [], isLoading: false }) },
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
import { BlockHost } from '~/components/AppBlocks/BlockHost';
// eslint-disable-next-line import/first
import type { BlockInstall, ModelSlotContext } from '~/components/AppBlocks/types';

const SAME_ORIGIN_SRC = `${window.location.origin}/`;

const install: BlockInstall = {
  blockInstanceId: 'inst_retry',
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

const context: ModelSlotContext = {
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
  theme: 'light',
};

const TOKEN_TTL_MS = 15 * 60_000;
const REFRESH_AT_MS = TOKEN_TTL_MS - 2 * 60_000;

let mintCount = 0;
let fetchSpy: ReturnType<typeof vi.fn>;

const BEACON_URL = '/api/track/block-render';
const isBeacon = (call: unknown[]) =>
  typeof call[0] === 'string' && (call[0] as string).includes(BEACON_URL);
const beaconCalls = () => fetchSpy.mock.calls.filter(isBeacon);

function mintOk(nth: number) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      token: `tok_${nth}`,
      expiresAt: new Date(Date.now() + TOKEN_TTL_MS).toISOString(),
      needsConsent: false,
      missingScopes: [],
      domain: 'blue',
      maxBrowsingLevel: 3,
    }),
  } as unknown as Response;
}
const mintFail = { ok: false, status: 500, json: async () => ({}) } as unknown as Response;

/** Route mint requests through `next()`; anything else (the beacon) resolves OK. */
function respondWith(next: () => Response) {
  fetchSpy.mockImplementation(async (url: unknown) => {
    if (typeof url === 'string' && url.includes('/api/v1/block-tokens')) return next();
    return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
  });
}

beforeEach(() => {
  mintCount = 0;
  vi.useFakeTimers({ shouldAdvanceTime: true });
  fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
  respondWith(() => mintOk(++mintCount));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(0);
}

const iframeQuery = () => page.getByTestId('block-iframe').query() as HTMLIFrameElement | null;
const fallbackQuery = () => document.querySelector('[data-block-fallback]') as HTMLElement | null;

async function waitForIframe(): Promise<HTMLIFrameElement> {
  for (let i = 0; i < 200; i++) {
    const el = iframeQuery();
    if (el) return el;
    await advance(1);
  }
  throw new Error('iframe never mounted');
}

/** Ack BLOCK_READY so the host commits `ready` and fires its ONE `ok` beacon. */
async function driveToReady(el: HTMLIFrameElement) {
  for (let i = 0; i < 200; i++) {
    const cw = el.contentWindow;
    if (cw) {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'BLOCK_READY', payload: {} },
          origin: window.location.origin,
          source: cw,
        })
      );
    }
    if (el.getAttribute('data-block-ready') === 'true') return;
    await advance(5);
  }
  throw new Error('block never became ready');
}

describe('a TRANSIENT refresh failure', () => {
  test('🔴 does NOT unmount the block — same <iframe> node, no second beacon', async () => {
    renderWithProviders(<BlockHost blockInstall={install} slotContext={context} />);
    const first = await waitForIframe();
    await driveToReady(first);
    expect(beaconCalls()).toHaveLength(1);

    // The scheduled refresh (T-2min) fails — twice, so we are demonstrably deep
    // into the bounded retry sequence and not merely observing a single tick.
    respondWith(() => mintFail);
    await advance(REFRESH_AT_MS);
    await advance(REFRESH_RETRY_BACKOFF_MS[0] + 5);

    const after = iframeQuery();
    // 🔴 IDENTITY, not presence: a remount would also yield a non-null iframe.
    expect(after).not.toBeNull();
    expect(after).toBe(first);
    // Still ready — the block kept its live token and never re-handshook.
    expect(after?.getAttribute('data-block-ready')).toBe('true');
    // The slot never fell back to a skeleton/error card.
    expect(fallbackQuery()).toBeNull();
    // 🔴 ONE beacon for the whole episode. A vanish-and-remount emitted two.
    expect(beaconCalls()).toHaveLength(1);
  });

  test('survives recovery too: the token rotates with the block still mounted', async () => {
    renderWithProviders(<BlockHost blockInstall={install} slotContext={context} />);
    const first = await waitForIframe();
    await driveToReady(first);

    respondWith(() => mintFail);
    await advance(REFRESH_AT_MS);

    respondWith(() => mintOk(++mintCount));
    await advance(REFRESH_RETRY_BACKOFF_MS[0] + 5);

    expect(iframeQuery()).toBe(first);
    expect(beaconCalls()).toHaveLength(1);
  });
});

describe('a TERMINAL failure', () => {
  test('🔴 still collapses to null once recovery has SETTLED with no token left', async () => {
    renderWithProviders(<BlockHost blockInstall={install} slotContext={context} />);
    const first = await waitForIframe();
    await driveToReady(first);

    respondWith(() => mintFail);
    await advance(REFRESH_AT_MS);
    for (let i = 0; i < MAX_REFRESH_RETRIES; i++) {
      await advance(REFRESH_RETRY_BACKOFF_MS[i] + 5);
    }
    // Settled but the held token is still live → the block keeps working.
    expect(iframeQuery()).toBe(first);

    // Past its real expiry the credential is swept and nothing is recoverable.
    await advance(TOKEN_TTL_MS);

    // The documented model-slot contract (hostRenderDecision): COLLAPSE, never a
    // visible error card — an error for a block the viewer never asked for, on
    // someone else's model page, is worse than silence.
    expect(iframeQuery()).toBeNull();
    expect(fallbackQuery()).toBeNull();
    expect(document.querySelector('[data-block-fallback-retry="true"]')).toBeNull();
  });

  test('an initial-load failure collapses only after the budget is spent', async () => {
    respondWith(() => mintFail);
    renderWithProviders(<BlockHost blockInstall={install} slotContext={context} />);

    // While recovery is pending the slot holds its (non-destructive) skeleton
    // rather than collapsing — the user is not shown a blank hole mid-recovery.
    await advance(50);
    expect(fallbackQuery()?.getAttribute('data-block-fallback')).toBe('loading');

    for (let i = 0; i < MAX_REFRESH_RETRIES; i++) {
      await advance(REFRESH_RETRY_BACKOFF_MS[i] + 5);
    }
    await advance(50);

    expect(fallbackQuery()).toBeNull();
    expect(iframeQuery()).toBeNull();
  });
});

describe('reduced motion', () => {
  test('🔴 the retry-window skeleton drops its shimmer under prefers-reduced-motion', async () => {
    // Stub the MEDIA QUERY, not the hook — `useReducedMotion` still runs for real.
    const original = window.matchMedia;
    window.matchMedia = ((query: string) =>
      ({
        matches: query.includes('prefers-reduced-motion'),
        media: query,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
      } as unknown as MediaQueryList)) as typeof window.matchMedia;

    try {
      respondWith(() => mintFail);
      renderWithProviders(<BlockHost blockInstall={install} slotContext={context} />);
      await advance(50);

      const skeleton = fallbackQuery();
      expect(skeleton?.getAttribute('data-block-fallback')).toBe('loading');
      // 🔴 Assert Mantine's OWN `data-animate` — the attribute it renders FROM the
      // `animate` prop — not a mirror attribute recomputed from `reduceMotion`.
      // The first version of this test did the latter and SURVIVED a mutation that
      // hardcoded `animate` to true: the assertion restated the intent instead of
      // observing the effect. The skeleton now covers the whole bounded retry
      // window (tens of seconds), not a sub-second flash, so a looping shimmer is
      // exactly what `prefers-reduced-motion: reduce` exists to suppress.
      expect(skeleton?.hasAttribute('data-animate')).toBe(false);
    } finally {
      window.matchMedia = original;
    }
  });

  test('keeps the shimmer when reduced motion is NOT requested', async () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
      } as unknown as MediaQueryList)) as typeof window.matchMedia;

    try {
      respondWith(() => mintFail);
      renderWithProviders(<BlockHost blockInstall={install} slotContext={context} />);
      await advance(50);
      expect(fallbackQuery()?.hasAttribute('data-animate')).toBe(true);
    } finally {
      window.matchMedia = original;
    }
  });
});
