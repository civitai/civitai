import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
import { useDialogStore } from '~/components/Dialog/dialogStore';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * MOD REVIEW SANDBOX (#2831) — PageBlockHost `reviewMode` read-only gate.
 *
 * The review preview runs UNAPPROVED, untrusted code with the mod's session. This
 * suite drives the REAL postMessage bridge and proves, for each class of handler:
 *   - reviewMode: every side-effecting / money / private / cross-user message
 *     replies with a KNOWN-SHAPE, fail-fast NACK (never a hang) AND never reaches
 *     the underlying tRPC mutation;
 *   - reviewMode: a render-safe read (GET_VIEWER) still works (mutation reached);
 *   - the NON-reviewMode (prod) path is UNCHANGED — the same message reaches the
 *     mutation;
 *   - the opaque-origin handshake: at trustTier='unverified' the iframe sandbox
 *     drops allow-same-origin and BLOCK_INIT (carrying the review token) still
 *     reaches BLOCK_READY (the path unverified prod blocks already use).
 */

const mocks = vi.hoisted(() => ({
  submit: vi.fn(async () => ({ snapshot: { workflowId: 'w', status: 'ok' } })),
  buzzBalance: vi.fn(async () => ({ balance: 5 })),
  viewer: vi.fn(async () => ({ id: 42, username: 'mod' })),
  storageSet: vi.fn(async () => ({ sizeBytes: 1 })),
  sharedAppend: vi.fn(async () => ({ key: 'k' })),
}));

// AppBlockChrome (in the host frame) calls useCurrentUser() for the platform-nav
// moderator gate; render the real host without a CivitaiSessionProvider.
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

vi.mock('~/utils/trpc', () => ({
  setTrpcBatchingEnabled: vi.fn(),
  trpc: {
    generation: { resolveWildcardPack: { useMutation: () => ({ mutateAsync: vi.fn() }) } },
    blocks: {
      submitWorkflow: { useMutation: () => ({ mutateAsync: mocks.submit }) },
      getMyBuzzBalance: { useMutation: () => ({ mutateAsync: mocks.buzzBalance }) },
      getMyViewer: { useMutation: () => ({ mutateAsync: mocks.viewer }) },
      getMyBuzzTransactions: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      getMyBuzzAccounts: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      getMyDailyCompensation: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      estimateWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      pollWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      cancelWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      queryAppWorkflows: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      cancelAppWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
    },
    apps: {
      shared: {
        append: { useMutation: () => ({ mutateAsync: mocks.sharedAppend }) },
        update: { useMutation: () => ({ mutateAsync: vi.fn() }) },
        vote: { useMutation: () => ({ mutateAsync: vi.fn() }) },
        unvote: { useMutation: () => ({ mutateAsync: vi.fn() }) },
        withdraw: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      },
      storage: {
        set: { useMutation: () => ({ mutateAsync: mocks.storageSet }) },
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
import { PageBlockHost } from '~/components/AppBlocks/PageBlockHost';

function postFromBlock(type: string, payload?: unknown, origin: string = window.location.origin) {
  const iframeEl = page.getByTestId('app-page-iframe').element() as HTMLIFrameElement;
  const cw = iframeEl.contentWindow;
  if (!cw) throw new Error('iframe contentWindow missing');
  // NB: we pass `cw` as `source` but never READ its properties — safe even when the
  // frame is cross-origin (opaque). `origin` selects the pinned vs opaque path.
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { type, payload },
      origin,
      source: cw,
    })
  );
}

function listenForReply() {
  const received: Array<{ type: string; payload: unknown }> = [];
  const iframeEl = page.getByTestId('app-page-iframe').element() as HTMLIFrameElement;
  const cw = iframeEl.contentWindow;
  if (!cw) throw new Error('iframe contentWindow missing');
  const handler = (e: MessageEvent) => {
    const d = e.data as { type?: string; payload?: unknown } | null;
    if (d && typeof d.type === 'string') received.push({ type: d.type, payload: d.payload });
  };
  cw.addEventListener('message', handler);
  return {
    received,
    last: (type: string) => [...received].reverse().find((m) => m.type === type),
    stop: () => cw.removeEventListener('message', handler),
  };
}

const SAME_ORIGIN_SRC = `${window.location.origin}/`;
const REVIEW_TOKEN = 'review.jwt.self-bound';

const baseProps = {
  appBlockId: 'pubreq_TEST',
  blockId: 'my-page-app',
  appId: 'pending-pubreq_TEST',
  blockInstanceId: 'page_pubreq_TEST',
  appName: 'Reviewed App',
  iframeSrc: SAME_ORIGIN_SRC,
  sandbox: 'allow-scripts',
  // Pinned transport (internal) for deterministic delivery — reviewMode is
  // independent of trust tier. The opaque-origin path has its own test below.
  trustTier: 'internal' as const,
  slug: 'my-page-app',
  token: REVIEW_TOKEN,
  expiresAt: new Date(Date.now() + 4 * 3_600_000).toISOString(),
  declaredScopes: ['models:read:self', 'user:read:self'],
  missingScopes: [] as string[],
  needsConsent: false,
  tokenError: false,
  viewer: { id: 42, username: 'mod' },
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

beforeEach(() => {
  useDialogStore.getState().closeAll();
  mocks.submit.mockClear();
  mocks.buzzBalance.mockClear();
  mocks.viewer.mockClear();
  mocks.storageSet.mockClear();
  mocks.sharedAppend.mockClear();
});

describe('PageBlockHost reviewMode — side-effecting handlers fail-fast NACK, never reach the mutation', () => {
  test('SUBMIT_WORKFLOW → failed snapshot, submitWorkflow NOT called', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} reviewMode onConsentGranted={vi.fn()} />);
    await driveToReady();
    const l = listenForReply();

    postFromBlock('SUBMIT_WORKFLOW', { requestId: 'r1', body: { anything: true } });

    await vi.waitFor(() => expect(l.last('WORKFLOW_SUBMITTED')).toBeTruthy());
    const reply = l.last('WORKFLOW_SUBMITTED')!.payload as {
      requestId: string;
      snapshot: { status: string; error: string; workflowId: string };
    };
    expect(reply.requestId).toBe('r1');
    expect(reply.snapshot.status).toBe('failed');
    expect(reply.snapshot.error).toBe('not available in review preview');
    expect(mocks.submit).not.toHaveBeenCalled();
    l.stop();
  });

  test('GET_BUZZ_BALANCE → error reply, getMyBuzzBalance NOT called', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} reviewMode onConsentGranted={vi.fn()} />);
    await driveToReady();
    const l = listenForReply();

    postFromBlock('GET_BUZZ_BALANCE', { requestId: 'b1' });

    await vi.waitFor(() => expect(l.last('BUZZ_BALANCE_RESULT')).toBeTruthy());
    const reply = l.last('BUZZ_BALANCE_RESULT')!.payload as { requestId: string; error: string };
    expect(reply.requestId).toBe('b1');
    expect(reply.error).toBe('not available in review preview');
    expect(mocks.buzzBalance).not.toHaveBeenCalled();
    l.stop();
  });

  test('APP_STORAGE_SET → ok:false error reply, storage.set NOT called', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} reviewMode onConsentGranted={vi.fn()} />);
    await driveToReady();
    const l = listenForReply();

    postFromBlock('APP_STORAGE_SET', { requestId: 's1', key: 'k', value: 'v' });

    await vi.waitFor(() => expect(l.last('APP_STORAGE_SET_RESULT')).toBeTruthy());
    const reply = l.last('APP_STORAGE_SET_RESULT')!.payload as {
      requestId: string;
      ok: boolean;
      error: string;
    };
    expect(reply.requestId).toBe('s1');
    expect(reply.ok).toBe(false);
    expect(reply.error).toBe('not available in review preview');
    expect(mocks.storageSet).not.toHaveBeenCalled();
    l.stop();
  });

  test('SHARED_APPEND (cross-user write) → error reply, shared.append NOT called', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} reviewMode onConsentGranted={vi.fn()} />);
    await driveToReady();
    const l = listenForReply();

    postFromBlock('SHARED_APPEND', { requestId: 'sa1', value: { title: 'x' } });

    await vi.waitFor(() => expect(l.last('SHARED_APPEND_RESULT')).toBeTruthy());
    const reply = l.last('SHARED_APPEND_RESULT')!.payload as { requestId: string; error: string };
    expect(reply.requestId).toBe('sa1');
    expect(reply.error).toBe('not available in review preview');
    expect(mocks.sharedAppend).not.toHaveBeenCalled();
    l.stop();
  });

  test('OPEN_BUZZ_PURCHASE → purchased:false, never opens the Buy-Buzz dialog', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} reviewMode onConsentGranted={vi.fn()} />);
    await driveToReady();
    const l = listenForReply();
    expect(useDialogStore.getState().dialogs).toHaveLength(0);

    postFromBlock('OPEN_BUZZ_PURCHASE', { requestId: 'p1', suggestedAmount: 500 });

    await vi.waitFor(() => expect(l.last('BUZZ_PURCHASE_RESULT')).toBeTruthy());
    const reply = l.last('BUZZ_PURCHASE_RESULT')!.payload as {
      requestId: string;
      purchased: boolean;
    };
    expect(reply.purchased).toBe(false);
    // No spend modal ever opened at the mod.
    expect(useDialogStore.getState().dialogs).toHaveLength(0);
    l.stop();
  });

  test('render-safe GET_VIEWER STILL works in reviewMode (mutation reached)', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} reviewMode onConsentGranted={vi.fn()} />);
    await driveToReady();
    const l = listenForReply();

    postFromBlock('GET_VIEWER', { requestId: 'v1' });

    await vi.waitFor(() => expect(mocks.viewer).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(l.last('VIEWER_RESULT')).toBeTruthy());
    l.stop();
  });
});

describe('PageBlockHost reviewMode — the NON-reviewMode (prod) path is unchanged', () => {
  test('without reviewMode, SUBMIT_WORKFLOW reaches submitWorkflow', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} onConsentGranted={vi.fn()} />);
    await driveToReady();

    postFromBlock('SUBMIT_WORKFLOW', { requestId: 'r2', body: { ok: true } });

    // The prod path forwards to the mutation exactly as before (no NACK).
    await vi.waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1));
  });
});

describe('PageBlockHost review preview handshake', () => {
  // BLOCK_INIT carries the review token — asserted in the pinned (same-origin)
  // transport so the test can read the frame's message channel. The token plumbing
  // is trust-tier-independent, so this pins "posts BLOCK_INIT with the review token
  // and the block reaches ready" (mirrors the dev host test).
  test('posts BLOCK_INIT carrying the review token and reaches BLOCK_READY', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} reviewMode onConsentGranted={vi.fn()} />);
    await vi.waitFor(() => {
      const el = page.getByTestId('app-page-iframe').element() as HTMLIFrameElement;
      if (!el.contentWindow) throw new Error('not mounted yet');
    });
    const l = listenForReply();
    // The controller re-posts BLOCK_INIT every 400ms until BLOCK_READY — wait for a
    // re-post to land on our listener, then assert it carries the review token.
    await vi.waitFor(
      () => {
        expect(l.last('BLOCK_INIT')).toBeTruthy();
      },
      { timeout: 3_000, interval: 100 }
    );
    const initPayload = l.last('BLOCK_INIT')!.payload as { token: { raw: string } };
    expect(initPayload.token.raw).toBe(REVIEW_TOKEN);

    // Completing the handshake still works (data-block-ready flips).
    await driveToReady();
    l.stop();
  });

  // The C1 opaque-origin defense: at trustTier='unverified' the iframe drops
  // allow-same-origin (runs at an opaque origin), and the host's postMessage
  // transport ACCEPTS an inbound `origin:'null'` BLOCK_READY (the OriginMatcher
  // opaque path unverified prod blocks already use) — completing the handshake.
  // The frame is genuinely cross-origin here, so we drive it via a synthetic
  // origin:'null' message rather than its contentWindow's listener.
  test('at trustTier=unverified the sandbox is opaque and an origin:null BLOCK_READY completes the handshake', async () => {
    renderWithProviders(
      <PageBlockHost {...baseProps} trustTier="unverified" reviewMode onConsentGranted={vi.fn()} />
    );
    await vi.waitFor(() => {
      const el = page.getByTestId('app-page-iframe').element() as HTMLIFrameElement;
      if (!el.contentWindow) throw new Error('not mounted yet');
    });

    // Opaque origin: allow-same-origin is dropped, allow-scripts remains.
    const iframeEl = page.getByTestId('app-page-iframe').element() as HTMLIFrameElement;
    const sandboxAttr = (iframeEl.getAttribute('sandbox') ?? '').split(/\s+/);
    expect(sandboxAttr).not.toContain('allow-same-origin');
    expect(sandboxAttr).toContain('allow-scripts');

    // An opaque-origin (origin:'null') BLOCK_READY is accepted → handshake done.
    await vi.waitFor(() => {
      postFromBlock('BLOCK_READY', {}, 'null');
      const el = page.getByTestId('app-page-iframe').element() as HTMLIFrameElement;
      if (el.getAttribute('data-block-ready') !== 'true') throw new Error('not ready yet');
    });
  });
});
