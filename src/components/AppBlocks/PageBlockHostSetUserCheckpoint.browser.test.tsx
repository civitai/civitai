import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
import { useDialogStore } from '~/components/Dialog/dialogStore';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * PageBlockHost SET_USER_CHECKPOINT — fail-fast NACK parity (gotcha-#73).
 *
 * `useCheckpointPicker().persist(versionId)` posts SET_USER_CHECKPOINT and
 * AWAITS USER_CHECKPOINT_SET (it's a `sendTypedRequest`, not fire-and-forget —
 * it throws the returned `error` when `ok:false`). The model-slot host
 * (IframeHost) handles it by writing `checkpoint_version_id` into
 * `block_user_settings`, and the dev:live SDK host serves it — so a block author
 * who calls `persist()` sees it resolve locally, then (before this handler) had
 * the SAME call hit NO page-host handler in prod: the persist promise hung to
 * the SDK's request timeout (the "spins forever, no network call, no console
 * error" class).
 *
 * A page CANNOT persist a checkpoint override the way the model slot can: the
 * server proc `blocks.updateUserSettings` HARD-REQUIRES `modelId` in the block
 * token ctx, and a page token (entityType:'none') has none. So rather than
 * invent a persistence target, the page host replies with the EXACT known-shape
 * reply the SDK awaits — USER_CHECKPOINT_SET { ok:false, error } — so persist()
 * REJECTS FAST with a clear message instead of hanging.
 *
 * These tests mount the REAL PageBlockHost and drive the actual postMessage
 * bridge, asserting:
 *   1. SET_USER_CHECKPOINT (valid requestId) posts back USER_CHECKPOINT_SET with
 *      the SAME requestId and ok:false + a non-empty error (the fail-fast NACK);
 *   2. NO checkpoint persistence side-effect / network call is made;
 *   3. a request with a missing / non-string requestId is DROPPED (no reply) —
 *      it can't be correlated, mirroring IframeHost's drop rule.
 */

vi.mock('~/utils/trpc', () => ({
  // FeatureFlagsProvider (in PageBlockHost's real render graph) statically imports
  // `setTrpcBatchingEnabled` from this module (#2946). vi.mock replaces the module
  // wholesale, so the factory must re-declare it or the ESM link fails and the whole
  // test file fails to import.
  setTrpcBatchingEnabled: vi.fn(),
  trpc: {
    // PageBlockHost wires the workflow + storage bridges at render; stub so it
    // mounts network-free. SET_USER_CHECKPOINT makes NO tRPC call on a page (it
    // NACKs in-host), so none of these are exercised here.
    blocks: {
      submitWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      getMyBuzzBalance: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      estimateWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      pollWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      cancelWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
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

// eslint-disable-next-line import/first
import { PageBlockHost } from '~/components/AppBlocks/PageBlockHost';

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

const baseProps = {
  appBlockId: 'apb_test',
  blockId: 'my-page-app',
  appId: 'app_test',
  blockInstanceId: 'page_apb_test',
  appName: 'Gen Matrix',
  iframeSrc: SAME_ORIGIN_SRC,
  sandbox: 'allow-scripts',
  trustTier: 'internal' as const,
  slug: 'my-page-app',
  token: 'tok_abc',
  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  declaredScopes: ['ai:write:budgeted'],
  missingScopes: [] as string[],
  needsConsent: false,
  tokenError: false,
  viewer: { id: 42, username: 'tester' },
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

describe('PageBlockHost SET_USER_CHECKPOINT (fail-fast NACK — no silent hang)', () => {
  beforeEach(() => {
    useDialogStore.getState().closeAll();
  });

  test('a valid request gets an explicit ok:false NACK with the same requestId (not a hang)', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('SET_USER_CHECKPOINT', { requestId: 'rq_persist', versionId: 9001 });

    await vi.waitFor(() => {
      const r = replies.last('USER_CHECKPOINT_SET');
      if (!r) throw new Error('no reply yet');
      const payload = r.payload as { requestId: string; ok: boolean; error?: string };
      expect(payload.requestId).toBe('rq_persist');
      expect(payload.ok).toBe(false);
      // The error must be a non-empty string — `persist()` THROWS it, so an
      // empty/undefined error would surface a useless message to the user.
      expect(typeof payload.error).toBe('string');
      expect((payload.error ?? '').length).toBeGreaterThan(0);
    });
    replies.stop();
  });

  test('clearing the override (versionId:null) also NACKs (no model-bound row to clear)', async () => {
    // The SDK allows `persist(null)` to clear an override. On a page there is no
    // override to clear either, so it NACKs the same way — the block fails fast
    // rather than believing it cleared a setting that never existed.
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('SET_USER_CHECKPOINT', { requestId: 'rq_clear', versionId: null });

    await vi.waitFor(() => {
      const r = replies.last('USER_CHECKPOINT_SET');
      if (!r) throw new Error('no reply yet');
      const payload = r.payload as { requestId: string; ok: boolean };
      expect(payload.requestId).toBe('rq_clear');
      expect(payload.ok).toBe(false);
    });
    replies.stop();
  });

  test('a request with no requestId is dropped (no reply — cannot correlate)', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('SET_USER_CHECKPOINT', { versionId: 9001 });

    await new Promise((r) => setTimeout(r, 150));
    expect(replies.last('USER_CHECKPOINT_SET')).toBeUndefined();
    replies.stop();
  });

  test('a request with a non-string requestId is dropped (no reply)', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('SET_USER_CHECKPOINT', { requestId: 42, versionId: 9001 });

    await new Promise((r) => setTimeout(r, 150));
    expect(replies.last('USER_CHECKPOINT_SET')).toBeUndefined();
    replies.stop();
  });

  test('the NACK opens NO modal and makes no checkpoint-persistence side effect', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('SET_USER_CHECKPOINT', { requestId: 'rq_noside', versionId: 5 });

    await vi.waitFor(() => {
      if (!replies.last('USER_CHECKPOINT_SET')) throw new Error('no reply yet');
    });
    // No dialog/modal should be opened by a persist NACK (unlike the picker).
    expect(useDialogStore.getState().dialogs).toHaveLength(0);
    replies.stop();
  });
});
