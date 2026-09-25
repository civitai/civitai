import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup } from 'vitest-browser-react';
import { useDialogStore } from '~/components/Dialog/dialogStore';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
// Type-only namespace imports for the `importOriginal` generics below.
// `@typescript-eslint/consistent-type-imports` rejects an inline
// `typeof import('...')` annotation, so the types have to arrive this way.
import type * as MantineNotifications from '@mantine/notifications';
import type * as Trpc from '~/utils/trpc';

/**
 * MODEL SLOT — THE HOST'S OWN ROUTE BACK TO CONSENT.
 *
 * ── THE GAP, AS MEASURED ────────────────────────────────────────────────────────
 *
 * Two host surfaces render app blocks and only one could recover a missing grant.
 * On `origin/main` at 6ff7aff2ab:
 *
 *   git grep -c needsConsent -- PageBlockHost.tsx   → 7
 *   git grep -c needsConsent -- IframeHost.tsx      → 0
 *   git grep -c CONSENT_UNAVAILABLE -- IframeHost.tsx → 0
 *
 * The mint reports `needsConsent` + `missingScopes` for a signed-in viewer with no
 * grant row (fail-closed: a missing `app_user_scope_grants` row withholds every
 * consent-gated scope). `PageBlockHost` acts on that itself, outside the iframe.
 * `IframeHost` did not act on it at all — its only route to consent was the BLOCK
 * sending REQUEST_CONSENT — and `BlockHost` did not even forward the field, so there
 * was nothing on this surface for a host-side affordance to key on.
 *
 * ── WHAT THAT COST, AND WHAT IT DID NOT ─────────────────────────────────────────
 *
 * 🔴 DEFENCE IN DEPTH, NOT AN OUTAGE — do not read these guards as closing a live
 * break. Two measured absences kept it latent: 0 of 7 fleet app manifests declare
 * `auth: "oauth"`, and the three fleet apps on `@civitai/sdk` pin `^0.3.0`/`^0.2.0`/
 * `^0.2.0`, none of which can resolve 0.4.0 under 0.x caret rules. What these tests
 * pin is that the HOST is recoverable regardless of what the block does or which SDK
 * it runs — including a block that never calls `requestGrants` at all.
 *
 * ── THE TWO TIERS HERE, AND WHY BOTH ────────────────────────────────────────────
 *
 * 1. THE SEAM (`BlockHost` → `useBlockToken` → `IframeHost`), driven from a stubbed
 *    `fetch` returning the REAL no-grant mint body. This is the tier that matters:
 *    the defect lived in a seam nobody owned. A test that set `needsConsent` on
 *    `IframeHost` directly would pass with `BlockHost` STILL dropping the field —
 *    verified-in-isolation green over a broken chain. The hook is NOT mocked.
 * 2. THE SURFACE (`IframeHost` mounted directly), for the per-term negative controls
 *    and the CONSENT_UNAVAILABLE refusal, which need prop states the mint never
 *    produces and so cannot be reached through tier 1 at all.
 *
 * ── WHAT THESE GUARDS CANNOT PROVE ──────────────────────────────────────────────
 *
 * Nothing here has been exercised against a live civitai host. The mint body is a
 * fixture mirroring `src/pages/api/v1/block-tokens/index.ts` (`kind: 'block'`,
 * `needsConsent = missing.length > 0`), not a response captured from production.
 */

// AppBlockChrome calls useCurrentUser() for the platform-nav moderator gate; this
// scaffold mounts no CivitaiSessionProvider.
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

// The REAL useFeatureFlags THROWS without a FeatureFlagsProvider, which this
// scaffold does not mount, so every test that MOUNTS IframeHost would crash.
// 🔴 `useOptionalFeatureFlags` IS LISTED TOO, AND OMITTING IT BREAKS THE WHOLE FILE:
// this factory REPLACES the module, so it must name every export anything in the
// module graph imports (the chrome's breadcrumb reads the non-throwing variant). A
// missing export makes the file fail to IMPORT, which reports as `Test Files N
// failed` with ZERO failing assertions — read the FILE count, not the test count.
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ appBlocks: false, appBlocksPages: false }),
  useOptionalFeatureFlags: () => ({ appBlocks: false, appBlocksPages: false }),
}));

// The un-grantable REQUEST_CONSENT path shows a host toast. Nothing mounts Mantine's
// `Notifications` here, so spy on the module rather than render it — and the spy is
// also the assertion that the toast fires ALONGSIDE the bridge push, not instead of it.
const showNotificationSpy = vi.fn();
vi.mock('@mantine/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof MantineNotifications>()),
  showNotification: (args: unknown) => showNotificationSpy(args),
}));

// IframeHost drives two tRPC queries at render plus the SDK/storage bridges. Stub it
// all so the host mounts network-free AND the init handshake may start immediately
// (`getEffectiveCheckpoint` must report `isLoading: false` so `shouldStartInit` fires).
// 🔴 SPREAD THE REAL MODULE, DO NOT REPLACE IT. A wholesale factory here would make
// every export it forgets `undefined` for this test's whole module graph, so the day
// `~/utils/trpc` gains one the FILE fails to load: 0 tests collected, no failing
// assertion, silently "green". Only `trpc` itself is overridden.
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: {
    collection: {
      follow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      unfollow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
    },
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
      grantScopes: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
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
        storage: { get: { fetch: vi.fn() }, list: { fetch: vi.fn() }, getQuota: { fetch: vi.fn() } },
      },
    }),
  },
}));

// Reads a context the network-free scaffold does not provide; the value only feeds
// the (mocked) showcase query.
vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', () => ({
  useBrowsingLevelDebounced: () => 1,
}));

// eslint-disable-next-line import/first
import { BlockHost } from '~/components/AppBlocks/BlockHost';
// eslint-disable-next-line import/first
import { IframeHost } from '~/components/AppBlocks/IframeHost';
// eslint-disable-next-line import/first
import type { BlockInstall, ModelSlotContext } from '~/components/AppBlocks/types';

// Same-origin so trustTier='internal' yields a pinned (non-opaque) transport whose
// expectedOrigin equals this frame's origin — both authenticating pins usePostMessage
// enforces are then satisfiable from this frame.
const SAME_ORIGIN_SRC = `${window.location.origin}/`;

const APP_BLOCK_ID = 'apb_test';
const APP_NAME = 'Background Remover';
// The manifest declares TWO consent-gated scopes and the fixtures below withhold
// exactly one of them, so "the notice opened on the right set" is a real reading
// rather than "it echoed the only value in play".
const WITHHELD = 'ai:write:budgeted';
const HELD = 'models:read:self';
// Neither granted NOR withheld, so it is un-grantable-via-consent: the only shape
// that can produce a CONSENT_UNAVAILABLE.
const UNGRANTABLE = 'apps:storage:read';

const install: BlockInstall = {
  blockInstanceId: 'inst_consent',
  blockId: 'my-model-app',
  appId: 'app_test',
  appBlockId: APP_BLOCK_ID,
  manifest: {
    name: APP_NAME,
    scopes: [WITHHELD, HELD],
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

// model.sidebar_top is the live production slot — and `viewerUserId` is set, because
// the whole case is a SIGNED-IN viewer with no grant row. An anon viewer gets the
// anon-safe scope strip instead and `needsConsent` stays false at the mint.
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

const noticeQuery = () => page.getByTestId('block-consent-notice').query();

// ===========================================================================
// TIER 1 — THE SEAM: the real no-grant mint body, through the real hook.
// ===========================================================================

const TOKEN_TTL_MS = 15 * 60_000;

/**
 * The mint's response for a SIGNED-IN viewer with no grant row, mirroring
 * `src/pages/api/v1/block-tokens/index.ts`: the token is signed with the GRANTED
 * subset (so the block still loads — consent is not terminal), `kind` is `'block'`
 * because the OAuth exchange did not mint, and `needsConsent = missing.length > 0`.
 */
function noGrantMint() {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      token: 'tok_no_grant',
      expiresAt: new Date(Date.now() + TOKEN_TTL_MS).toISOString(),
      kind: 'block',
      scopes: [HELD],
      needsConsent: true,
      missingScopes: [WITHHELD],
      domain: 'blue',
      maxBrowsingLevel: 3,
    }),
  } as unknown as Response;
}

/** The SAME viewer once they have consented — the discriminating control. */
function fullyGrantedMint() {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      token: 'tok_granted',
      expiresAt: new Date(Date.now() + TOKEN_TTL_MS).toISOString(),
      kind: 'block',
      scopes: [WITHHELD, HELD],
      needsConsent: false,
      missingScopes: [],
      domain: 'blue',
      maxBrowsingLevel: 3,
    }),
  } as unknown as Response;
}

describe('IframeHost consent backstop — the BlockHost → useBlockToken → IframeHost seam', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  function respondWith(next: () => Response) {
    fetchSpy.mockImplementation(async (url: unknown) => {
      if (typeof url === 'string' && url.includes('/api/v1/block-tokens')) return next();
      // Everything else here is the block-render beacon.
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    });
  }

  beforeEach(() => {
    useDialogStore.getState().closeAll();
    showNotificationSpy.mockClear();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    respondWith(noGrantMint);
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

  async function waitForIframe(): Promise<HTMLIFrameElement> {
    for (let i = 0; i < 200; i++) {
      const el = page.getByTestId('block-iframe').query() as HTMLIFrameElement | null;
      if (el) return el;
      await advance(1);
    }
    throw new Error('iframe never mounted');
  }

  /** Collect host→block posts on the iframe's own window (where `send` delivers). */
  function listenForPosts(el: HTMLIFrameElement) {
    const received: Array<{ type: string; payload: unknown }> = [];
    const cw = el.contentWindow;
    if (!cw) throw new Error('iframe contentWindow missing');
    const handler = (e: MessageEvent) => {
      const d = e.data as { type?: string; payload?: unknown } | null;
      if (d && typeof d.type === 'string') received.push({ type: d.type, payload: d.payload });
    };
    cw.addEventListener('message', handler);
    return {
      of: (type: string) => received.filter((m) => m.type === type),
      stop: () => cw.removeEventListener('message', handler),
    };
  }

  /** Ack BLOCK_READY until the host commits `ready`, as a real block does. */
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

  test('🔴 the no-grant mint reaches BLOCK_INIT and the host offers consent ITSELF — the block posts nothing', async () => {
    renderWithProviders(<BlockHost blockInstall={install} slotContext={context} />);
    const el = await waitForIframe();
    const posts = listenForPosts(el);
    try {
      // 🔴 THE BLOCK-INIT LEG, captured BEFORE acking ready: it proves the mint's
      // no-grant body actually travelled the production projection rather than the
      // notice appearing off some other state. Captured from one of the init
      // controller's RETRIES rather than its first post — the listener necessarily
      // attaches after mount, and the first BLOCK_INIT can already have gone out.
      // The controller re-posts until BLOCK_READY, which is exactly why acking is
      // deferred to the next line: ack first and the retries stop, leaving this an
      // unobservable zero.
      for (let i = 0; i < 200 && posts.of('BLOCK_INIT').length === 0; i++) await advance(5);
      const init = posts.of('BLOCK_INIT');
      expect(init.length).toBeGreaterThan(0);
      // The wrapped token advertises the GRANTED subset only — the withheld scope
      // must not be claimed to the block, or its own "do I have this capability?"
      // check is a lie. `[HELD]`, not the manifest's `[WITHHELD, HELD]`.
      const tokenScopes = (init[0].payload as { token?: { scopes?: string[] } }).token?.scopes;
      expect(tokenScopes).toEqual([HELD]);

      await driveToReady(el);

      // 🔴 THE HOST LEG — the actual regression. Nothing was posted FROM the block
      // but BLOCK_READY: no REQUEST_CONSENT, no `requestGrants`. On pre-change code
      // `BlockHost` dropped `needsConsent` and `IframeHost` had no notice at all, so
      // this query returned null forever.
      await vi.waitFor(() => expect(noticeQuery()).not.toBeNull());

      // It OFFERS, it does not interrupt: no modal until the viewer asks for one.
      expect(useDialogStore.getState().dialogs).toHaveLength(0);
      // And no toast — the notice is the whole affordance on this path.
      expect(showNotificationSpy).not.toHaveBeenCalled();
    } finally {
      posts.stop();
    }
  });

  test('DISCRIMINATING CONTROL — the same seam with a fully-granted mint shows nothing', async () => {
    // Everything about this render is identical except the mint's verdict, so a pass
    // above cannot be "the notice renders unconditionally once ready".
    respondWith(fullyGrantedMint);
    renderWithProviders(<BlockHost blockInstall={install} slotContext={context} />);
    const el = await waitForIframe();
    await driveToReady(el);
    // The positive case proves the notice CAN render after ready, so this zero is a
    // reading rather than a silence.
    await advance(200);
    expect(noticeQuery()).toBeNull();
  });
});

// ===========================================================================
// TIER 2 — THE SURFACE: IframeHost mounted directly, real timers.
//
// Prop states the mint never produces (`needsConsent` disagreeing with
// `missingScopes`) are unreachable through tier 1 by construction, and they are
// exactly what makes each term of the predicate individually killable.
// ===========================================================================

const baseProps = {
  install,
  context,
  token: 'tok_abc',
  expiresAt: new Date(Date.now() + TOKEN_TTL_MS).toISOString(),
  tokenKind: 'block' as const,
  missingScopes: [WITHHELD],
  needsConsent: true,
};

describe('IframeHost consent backstop — the surface', () => {
  beforeEach(() => {
    useDialogStore.getState().closeAll();
    showNotificationSpy.mockClear();
  });

  afterEach(() => cleanup());

  function postFromBlock(type: string, payload?: unknown) {
    const el = page.getByTestId('block-iframe').element() as HTMLIFrameElement;
    const cw = el.contentWindow;
    if (!cw) throw new Error('iframe contentWindow missing');
    window.dispatchEvent(
      new MessageEvent('message', { data: { type, payload }, origin: window.location.origin, source: cw })
    );
  }

  function listenForPosts() {
    const received: Array<{ type: string; payload: unknown }> = [];
    const el = page.getByTestId('block-iframe').element() as HTMLIFrameElement;
    const cw = el.contentWindow;
    if (!cw) throw new Error('iframe contentWindow missing');
    const handler = (e: MessageEvent) => {
      const d = e.data as { type?: string; payload?: unknown } | null;
      if (d && typeof d.type === 'string') received.push({ type: d.type, payload: d.payload });
    };
    cw.addEventListener('message', handler);
    return {
      of: (type: string) => received.filter((m) => m.type === type),
      stop: () => cw.removeEventListener('message', handler),
    };
  }

  async function driveToReady() {
    await vi.waitFor(() => {
      const el = page.getByTestId('block-iframe').element() as HTMLIFrameElement;
      if (!el.contentWindow) throw new Error('not mounted yet');
    });
    await vi.waitFor(() => {
      postFromBlock('BLOCK_READY', {});
      const el = page.getByTestId('block-iframe').element() as HTMLIFrameElement;
      if (el.getAttribute('data-block-ready') !== 'true') throw new Error('not ready yet');
    });
  }

  test('🔴 the notice renders OUTSIDE the iframe, inside the host trust frame', async () => {
    renderWithProviders(<IframeHost {...baseProps} onConsentGranted={vi.fn()} />);
    await driveToReady();
    await vi.waitFor(() => expect(noticeQuery()).not.toBeNull());

    // 🔴 POSITION, not just presence. A backstop the block can restyle or hide is
    // not a backstop, and one rendered INSIDE the iframe could not exist for a block
    // that never asks. Assert the containment relationship both ways rather than
    // trusting that the JSX reads correctly: inside the host frame, and NOT inside
    // (or after) the iframe element.
    const notice = noticeQuery() as HTMLElement;
    const frame = page.getByTestId('app-block-frame').element() as HTMLElement;
    const iframeEl = page.getByTestId('block-iframe').element() as HTMLIFrameElement;
    expect(frame.contains(notice)).toBe(true);
    expect(iframeEl.contains(notice)).toBe(false);
    // Above the iframe in document order — the same slot PageBlockHost uses.
    expect(notice.compareDocumentPosition(iframeEl) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test('Review opens the consent dialog with the SERVER-KNOWN missing set', async () => {
    const onConsentGranted = vi.fn();
    renderWithProviders(<IframeHost {...baseProps} onConsentGranted={onConsentGranted} />);
    await driveToReady();
    await vi.waitFor(() => expect(noticeQuery()).not.toBeNull());

    await page.getByTestId('block-consent-notice-review').click();

    expect(useDialogStore.getState().dialogs).toHaveLength(1);
    const props = useDialogStore.getState().dialogs[0].props as {
      appBlockId: string;
      blockName?: string;
      missingScopes: string[];
      onGranted: () => void;
    };
    // The WITHHELD scope only — never the held one, and never the manifest set.
    expect(props.missingScopes).toEqual([WITHHELD]);
    expect(props.appBlockId).toBe(APP_BLOCK_ID);
    expect(props.blockName).toBe(APP_NAME);
    // The re-mint is wired, and is NOT fired by merely opening the dialog.
    expect(onConsentGranted).not.toHaveBeenCalled();
    props.onGranted();
    expect(onConsentGranted).toHaveBeenCalledTimes(1);
  });

  test('🔴 two Review clicks open ONE dialog — the dedupe id this surface never had', async () => {
    // `dialogStore.trigger` dedupes on `id` and nothing else, falling back to
    // `Date.now()`. IframeHost's own trigger passed NO id, which was latent only
    // while every caller was a message handler; a human-clickable notice is what
    // makes it reachable. Centralising the opener is what fixes it, so this is the
    // guard that the centralisation actually took effect HERE.
    renderWithProviders(<IframeHost {...baseProps} onConsentGranted={vi.fn()} />);
    await driveToReady();
    await vi.waitFor(() => expect(noticeQuery()).not.toBeNull());

    await page.getByTestId('block-consent-notice-review').click();
    await page.getByTestId('block-consent-notice-review').click();

    expect(useDialogStore.getState().dialogs).toHaveLength(1);
  });

  test('Dismiss removes it, and it does not come back on its own', async () => {
    renderWithProviders(<IframeHost {...baseProps} onConsentGranted={vi.fn()} />);
    await driveToReady();
    await vi.waitFor(() => expect(noticeQuery()).not.toBeNull());

    await page.getByTestId('block-consent-notice-dismiss').click();

    await vi.waitFor(() => expect(noticeQuery()).toBeNull());
    // Nothing re-renders it: give the host a beat to prove it stays gone.
    await new Promise((r) => setTimeout(r, 150));
    expect(noticeQuery()).toBeNull();
    // Dismissing is not consenting.
    expect(useDialogStore.getState().dialogs).toHaveLength(0);
  });

  // 🔴 ONE VARIABLE EACH. A fixture that moves `missingScopes` AND `needsConsent`
  // together cannot attribute the absence to either term, which is how the page
  // host's `needsConsent &&` once sat in a render condition with no killing
  // mutation. ⚠️ BOTH halves pin a state the mint never produces — it sets
  // `needsConsent = missing.length > 0`, so the two always agree in production.
  // That is the price of attributing each term separately, and it is said on BOTH so
  // a reader does not take the unflagged one for a reachable case.
  test('NEGATIVE CONTROL — nothing missing (needsConsent still true), no notice', async () => {
    renderWithProviders(
      <IframeHost {...baseProps} missingScopes={[]} onConsentGranted={vi.fn()} />
    );
    await driveToReady();
    await new Promise((r) => setTimeout(r, 150));
    expect(noticeQuery()).toBeNull();
  });

  test('NEGATIVE CONTROL — needsConsent false alone suppresses it, even with a missing set', async () => {
    renderWithProviders(
      <IframeHost {...baseProps} needsConsent={false} onConsentGranted={vi.fn()} />
    );
    await driveToReady();
    await new Promise((r) => setTimeout(r, 150));
    expect(noticeQuery()).toBeNull();
  });

  test('NEGATIVE CONTROL — needsConsent absent (a legacy mint response) suppresses it', async () => {
    // This one IS reachable: a mint deployed before A6 returns no such field, and
    // `undefined` must read as "nothing to prompt for" rather than "prompt".
    const { needsConsent: _omitted, ...legacy } = baseProps;
    renderWithProviders(<IframeHost {...legacy} onConsentGranted={vi.fn()} />);
    await driveToReady();
    await new Promise((r) => setTimeout(r, 150));
    expect(noticeQuery()).toBeNull();
  });

  test('NEGATIVE CONTROL — no notice before BLOCK_READY', async () => {
    renderWithProviders(<IframeHost {...baseProps} onConsentGranted={vi.fn()} />);
    await vi.waitFor(() => {
      const el = page.getByTestId('block-iframe').element() as HTMLIFrameElement;
      if (!el.contentWindow) throw new Error('not mounted yet');
    });
    // Deliberately never acked. A notice over a still-loading block is the thing the
    // shared status term exists to prevent.
    await new Promise((r) => setTimeout(r, 150));
    expect(noticeQuery()).toBeNull();
  });

  // =========================================================================
  // CONSENT_UNAVAILABLE — the refusal this surface could not express.
  // =========================================================================

  test('🔴 an UN-GRANTABLE REQUEST_CONSENT now posts CONSENT_UNAVAILABLE — requestGrants can resolve FALSE', async () => {
    // 🔴 THE SHARPER HALF OF THE DEFECT. `CONSENT_UNAVAILABLE` was sent by
    // PageBlockHost only (0 occurrences in IframeHost.tsx on origin/main), so on the
    // model slot a block that DID ask got nothing back over the bridge at all: the
    // SDK's `requestGrants` promise could resolve `true` or hang, but had NO route to
    // `false`. A promise that cannot resolve false is a hang dressed as an API.
    //
    // `missingScopes: []` so nothing is grantable-via-consent, and the hint names a
    // scope that is neither granted (the manifest's granted subset) nor withheld — a
    // mint clamp. That is the only shape that can reach the refusal.
    renderWithProviders(
      <IframeHost
        {...baseProps}
        missingScopes={[]}
        needsConsent={false}
        onConsentGranted={vi.fn()}
      />
    );
    await driveToReady();
    const posts = listenForPosts();
    try {
      postFromBlock('REQUEST_CONSENT', { scopes: [UNGRANTABLE] });

      await vi.waitFor(() => expect(posts.of('CONSENT_UNAVAILABLE')).toHaveLength(1));
      expect(posts.of('CONSENT_UNAVAILABLE')[0].payload).toEqual({
        reason: 'ungrantable',
        scopes: [UNGRANTABLE],
      });
      // The toast is an ADDITIONAL channel, not a replacement — the host frame tells
      // the viewer while the bridge tells the block.
      expect(showNotificationSpy).toHaveBeenCalledTimes(1);
      const toast = showNotificationSpy.mock.calls[0][0] as { title: string; message: string };
      expect(toast.title).toBe('Permission unavailable');
      // 🔴 NO "preview" CLAIM. The un-grantable state is reachable from an ordinary
      // mint clamp on a live model page, so the old page-host wording was false here.
      expect(toast.message).toBe('This app requested a permission that isn’t available here.');
      // No modal: there is nothing consent can add.
      expect(useDialogStore.getState().dialogs).toHaveLength(0);
    } finally {
      posts.stop();
    }
  });

  test('the BENIGN already-granted REQUEST_CONSENT stays silent in BOTH channels', async () => {
    // A block re-requesting a scope its token already carries is not a refusal. The
    // positive case above proves the push CAN fire on this mount, so this zero is a
    // reading rather than a wire that was never connected.
    renderWithProviders(
      <IframeHost
        {...baseProps}
        missingScopes={[]}
        needsConsent={false}
        onConsentGranted={vi.fn()}
      />
    );
    await driveToReady();
    const posts = listenForPosts();
    try {
      // Positive control FIRST, on this very mount: watch the count move.
      postFromBlock('REQUEST_CONSENT', { scopes: [UNGRANTABLE] });
      await vi.waitFor(() => expect(posts.of('CONSENT_UNAVAILABLE')).toHaveLength(1));
      showNotificationSpy.mockClear();

      // Now the benign one — `HELD` is in the manifest and not withheld, so the
      // token carries it.
      postFromBlock('REQUEST_CONSENT', { scopes: [HELD] });
      await new Promise((r) => setTimeout(r, 150));
      expect(posts.of('CONSENT_UNAVAILABLE')).toHaveLength(1); // still just the control's
      expect(showNotificationSpy).not.toHaveBeenCalled();
    } finally {
      posts.stop();
    }
  });

  test('a GRANTABLE REQUEST_CONSENT opens the modal and sends NO refusal', async () => {
    // The two halves of the handler are mutually exclusive: when consent CAN help,
    // the block must not also be told the permission is unavailable.
    renderWithProviders(<IframeHost {...baseProps} onConsentGranted={vi.fn()} />);
    await driveToReady();
    const posts = listenForPosts();
    try {
      postFromBlock('REQUEST_CONSENT', { scopes: [WITHHELD] });
      await vi.waitFor(() => expect(useDialogStore.getState().dialogs).toHaveLength(1));
      await new Promise((r) => setTimeout(r, 100));
      expect(posts.of('CONSENT_UNAVAILABLE')).toHaveLength(0);
      expect(showNotificationSpy).not.toHaveBeenCalled();
    } finally {
      posts.stop();
    }
  });
});
