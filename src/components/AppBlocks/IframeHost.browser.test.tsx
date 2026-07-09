import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

// Per-test-controllable balance mutation impl. `vi.mock` is hoisted, so the fn
// must live in a hoisted block the factory can close over (mirrors
// PageBlockHostWorkflow's `mocks.balance`). The other bridges stay inert
// throwaway fns — only GET_BUZZ_BALANCE is behaviorally exercised here.
const mocks = vi.hoisted(() => ({
  balance: vi.fn(),
}));

// IframeHost drives two tRPC queries at render (getEffectiveCheckpoint +
// getShowcaseImages) and reads the debounced browsing level. None of that is
// relevant to the block-render beacon under test, so stub them so the component
// mounts network-free and the init handshake is ALLOWED to start immediately:
//   - getEffectiveCheckpoint must report `isLoading: false` so `shouldStartInit`
//     fires (the controller posts BLOCK_INIT and arms the readiness timeout).
//   - getShowcaseImages returns no data (carousel is irrelevant here).
vi.mock('~/utils/trpc', () => ({
  trpc: {
    blocks: {
      getEffectiveCheckpoint: {
        useQuery: () => ({ data: { checkpoint: null }, isLoading: false }),
      },
      getShowcaseImages: {
        useQuery: () => ({ data: [], isLoading: false }),
      },
      // The SDK workflow + user-settings bridges wire these at render (inert
      // here — the block never sends SUBMIT/ESTIMATE/POLL/SET_USER_SETTINGS in
      // these beacon tests).
      submitWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      estimateWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      pollWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      cancelWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      updateUserSettings: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      getMyBuzzBalance: { useMutation: () => ({ mutateAsync: mocks.balance }) },
    },
    apps: {
      shared: {
        append: { useMutation: () => ({ mutateAsync: vi.fn() }) },
        vote: { useMutation: () => ({ mutateAsync: vi.fn() }) },
        unvote: { useMutation: () => ({ mutateAsync: vi.fn() }) },
        withdraw: { useMutation: () => ({ mutateAsync: vi.fn() }) },
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

// useBrowsingLevelDebounced reads a context the network-free scaffold doesn't
// provide; the value only feeds the (mocked) showcase query, so stub a constant.
vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', () => ({
  useBrowsingLevelDebounced: () => 1,
}));

// eslint-disable-next-line import/first
import { IframeHost } from '~/components/AppBlocks/IframeHost';
// eslint-disable-next-line import/first
import type { BlockInstall, ModelSlotContext } from '~/components/AppBlocks/types';

/**
 * Analytics Phase 2 — block render/impression beacon on the MODEL slot host.
 *
 * `IframeHost` is the ACTUAL production slot (`model.sidebar_top`), while
 * `PageBlockHost` (covered in PageBlockHost.browser.test.tsx) is the `app.page`
 * surface. Both emit the once-per-mount beacon at the BLOCK_READY transition
 * with identical logic + the same per-host `useRef` emit-once flag; this file
 * pins the model-slot path so a regression there can't slip past the page-only
 * coverage.
 *
 * We mount the REAL IframeHost and drive the real postMessage bridge to
 * BLOCK_READY, mirroring PageBlockHost.browser.test.tsx's harness:
 *   - manifest.iframe.src is same-origin and trustTier='internal' so the
 *     transport runs in PINNED mode (allow-same-origin is auto-injected for
 *     trusted tiers → real origin === expectedOrigin), exactly like a verified/
 *     internal block. We post FROM the iframe's contentWindow so the
 *     `event.source === iframe.contentWindow` authenticating pin holds.
 *   - We spy on global fetch and assert the beacon (`/api/track/block-render`)
 *     fires exactly once at BLOCK_READY and never on a late/duplicate ack.
 */

// Same-origin so trustTier='internal' yields a pinned (non-opaque) transport
// whose expectedOrigin equals this frame's origin.
const SAME_ORIGIN_SRC = `${window.location.origin}/`;

// Simulate a message FROM the host iframe by dispatching a MessageEvent whose
// `source` is the iframe's contentWindow and whose `origin` matches the host's
// expectedOrigin (same-origin iframeSrc). This satisfies BOTH authenticating
// pins usePostMessage enforces — event.source === iframe.contentWindow and the
// origin pin — without depending on a real cross-document load racing the test.
function postFromBlock(type: string, payload?: unknown) {
  const iframeEl = page.getByTestId('block-iframe').element() as HTMLIFrameElement;
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

// Capture host→block replies. `send` posts onto the iframe's contentWindow, so
// we listen there. Mirrors PageBlockHostWorkflow's helper, adapted to the model-
// slot iframe testid.
function listenForReply() {
  const received: Array<{ type: string; payload: unknown }> = [];
  const iframeEl = page.getByTestId('block-iframe').element() as HTMLIFrameElement;
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

// model.sidebar_top is the live production slot. modelId/modelVersionId present
// so the (mocked) queries are "enabled" and the BLOCK_INIT context is realistic.
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

const baseProps = {
  install,
  context,
  token: 'tok_abc',
  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
};

// Drive the handshake to BLOCK_READY (status='ready') — the same transition a
// real block hits once it acks the host's BLOCK_INIT.
async function driveToReady() {
  // Wait until the iframe is mounted + its contentWindow is reachable.
  await vi.waitFor(() => {
    const el = page.getByTestId('block-iframe').element() as HTMLIFrameElement;
    if (!el.contentWindow) throw new Error('not mounted yet');
  });
  // The host posts BLOCK_INIT on a retry interval; we just ack READY until the
  // host commits the 'ready' state (data-block-ready flips true).
  await vi.waitFor(() => {
    postFromBlock('BLOCK_READY', {});
    const el = page.getByTestId('block-iframe').element() as HTMLIFrameElement;
    if (el.getAttribute('data-block-ready') !== 'true') throw new Error('not ready yet');
  });
}

describe('IframeHost block render/impression (Analytics Phase 2, model.sidebar_top)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  // Only the block-render beacon goes through fetch in this test; resolve OK.
  function isBeacon(call: unknown[]) {
    return typeof call[0] === 'string' && (call[0] as string).includes('/api/track/block-render');
  }
  function beaconCalls() {
    return fetchSpy.mock.calls.filter(isBeacon);
  }

  beforeEach(() => {
    // vi.spyOn dedupes to the same mock when fetch is already spied, so its
    // .mock.calls would accumulate across tests — clear it each time.
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }));
    fetchSpy.mockClear();
  });

  test('emits the block-render beacon exactly once at BLOCK_READY with the model-slot identifiers', async () => {
    renderWithProviders(<IframeHost {...baseProps} />);

    // Not emitted before the handshake completes.
    expect(beaconCalls()).toHaveLength(0);

    await driveToReady();

    await vi.waitFor(() => {
      expect(beaconCalls()).toHaveLength(1);
    });

    const [url, init] = beaconCalls()[0];
    expect(url).toBe('/api/track/block-render');
    expect((init as RequestInit | undefined)?.method).toBe('POST');
    // keepalive so the beacon survives a page unload/navigation.
    expect((init as RequestInit | undefined)?.keepalive).toBe(true);
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body).toEqual({
      appBlockId: 'apb_test',
      blockInstanceId: 'inst_test',
      // The production model slot — sourced from modelCtx.slotId.
      slotId: 'model.sidebar_top',
    });
    // No isAnon/userId from the client — those are server-derived in the route.
    expect(body).not.toHaveProperty('isAnon');
    expect(body).not.toHaveProperty('userId');
  });

  test('does NOT re-emit on a late/duplicate BLOCK_READY (status no longer loading)', async () => {
    renderWithProviders(<IframeHost {...baseProps} />);

    await driveToReady();
    await vi.waitFor(() => expect(beaconCalls()).toHaveLength(1));

    // A second/third BLOCK_READY (block re-ack, or a re-render re-running
    // listeners) finds status === 'ready', so `appliedReady` stays false AND
    // the emit-once ref is already set → no re-emit.
    postFromBlock('BLOCK_READY', {});
    postFromBlock('BLOCK_READY', {});
    await new Promise((r) => setTimeout(r, 150));

    expect(beaconCalls()).toHaveLength(1);
  });
});

// ── Phase 3: per-account buzz — GET_BUZZ_BALANCE on the model-slot host ───────
//
// The model-slot IframeHost is the live production surface; its GET_BUZZ_BALANCE
// handler is a COPY of PageBlockHost's but WITHOUT the explicit null-token guard,
// because IframeHost's `token` is a non-null `string` (an empty token falls
// through to the router's `z.string().min(1)` reject → the `catch` → error reply,
// never a hang). This block pins that divergent branch — the PageBlockHost tests
// don't cover it. We drive the same real postMessage bridge to BLOCK_READY, then
// post GET_BUZZ_BALANCE and read the BUZZ_BALANCE_RESULT reply off the iframe.
describe('IframeHost GET_BUZZ_BALANCE handler (Phase 3, model.sidebar_top)', () => {
  beforeEach(() => {
    mocks.balance.mockReset();
  });

  test('GET_BUZZ_BALANCE forwards the IframeHost token to getMyBuzzBalance and posts BUZZ_BALANCE_RESULT', async () => {
    const balance = { blue: 1200, green: 300, yellow: 50 };
    mocks.balance.mockResolvedValue(balance);
    renderWithProviders(<IframeHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('GET_BUZZ_BALANCE', { requestId: 'rq_bal' });

    await vi.waitFor(() => {
      // Forwarded the IframeHost `token` PROP as blockToken (the SELF-BOUND
      // credential); the handler never trusts a client-supplied userId.
      expect(mocks.balance).toHaveBeenCalledWith({ blockToken: 'tok_abc' });
    });
    await vi.waitFor(() => {
      const r = replies.last('BUZZ_BALANCE_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_bal', balance });
    });
    replies.stop();
  });

  test('GET_BUZZ_BALANCE error path posts an error-variant BUZZ_BALANCE_RESULT (no hang)', async () => {
    mocks.balance.mockRejectedValue(new Error('invalid block token'));
    renderWithProviders(<IframeHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('GET_BUZZ_BALANCE', { requestId: 'rq_bal_err' });

    await vi.waitFor(() => {
      const r = replies.last('BUZZ_BALANCE_RESULT');
      if (!r) throw new Error('no reply yet');
      // error-carrying variant (no balance) so useBuzzBalance rejects instead of
      // spinning to its timeout. This is the branch a `z.string().min(1)` router
      // reject would land in for an empty token — proving no hang.
      expect(r.payload).toEqual({ requestId: 'rq_bal_err', error: 'invalid block token' });
      expect(r.payload).not.toHaveProperty('balance');
    });
    replies.stop();
  });

  test('GET_BUZZ_BALANCE with NO requestId is dropped (no mutation, no reply)', async () => {
    renderWithProviders(<IframeHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('GET_BUZZ_BALANCE', {}); // missing requestId

    await new Promise((r) => setTimeout(r, 150));
    expect(mocks.balance).not.toHaveBeenCalled();
    expect(replies.last('BUZZ_BALANCE_RESULT')).toBeUndefined();
    replies.stop();
  });
});
