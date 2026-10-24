import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
// Type-only namespace import for the `importOriginal` spread below (the repo's
// local-rules/no-wholesale-module-mock cure).
import type * as TrpcMod from '~/utils/trpc';

/**
 * EVERY `!token` EARLY RETURN ON THE PAGE HOST NOW REPLIES INSTEAD OF DROPPING.
 *
 * 🔴 THE DEFECT, STATED PRECISELY. A page block whose credential has not resolved
 * (or was revoked mid-session) posts a REQUEST-style message; the handler reads
 * `!token` and `return`s. Nothing goes on the wire, so the block's `sendRequest`
 * promise stays pending until the SDK's per-class timeout fires — 120s for the
 * workflow class, 30s for storage, and up to TEN MINUTES for the human-in-the-loop
 * class. `PageBlockHost.tsx` already said so at the balance handler, which alone
 * had been fixed: "DEVIATION from the workflow handlers (which DROP a `!token`
 * request silently)". One handler had the fix; nineteen did not.
 *
 * 🔴 WHY `token={null}` STILL MOUNTS AN IFRAME. `showIframe = status === 'loading'
 * || status === 'ready'`, and a host with no token sits in `loading` until the
 * 15s token-wait timeout escalates it to `no_token`. So the frame — and every
 * `onMessage` registration, which lives in effects with no readiness gate — is
 * live during exactly the window this test drives. That is not a test artifact: it
 * is the real pre-credential window a block boots into.
 *
 * 🔴 THE REPLY SHAPE IS PER-FAMILY AND THE DIFFERENCE IS LOAD-BEARING. A workflow
 * reply must carry a `snapshot` whose `workflowId` is non-empty — `isValidWorkflowReply`
 * has no early-accept on `error`, so a bare `{requestId, error}` is DROPPED by the
 * block's own validator and the block hangs exactly as before, which is the failure
 * `failureSnapshot.ts`'s header records verbatim. Storage/shared replies take the
 * bare `error`, which their validators early-accept and their hooks throw on.
 * Asserting "a reply arrived" without asserting its shape would pass against a
 * reply the SDK throws away.
 */

const mocks = vi.hoisted(() => ({
  submit: vi.fn(),
  estimate: vi.fn(),
  poll: vi.fn(),
  cancel: vi.fn(),
  storageGet: vi.fn(),
  storageSet: vi.fn(),
  sharedAppend: vi.fn(),
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  // Spread the REAL module and override only `trpc` — FeatureFlagsProvider (in
  // PageBlockHost's real render graph) statically imports `setTrpcBatchingEnabled`
  // from here (#2946), and a hand-written factory that omits any export makes the
  // whole FILE fail to load: 0 tests collected, no failing assertion, silently
  // "green".
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: {
    collection: {
      follow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      unfollow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
    },
    generation: { resolveWildcardPack: { useMutation: () => ({ mutateAsync: vi.fn() }) } },
    blocks: {
      submitWorkflow: { useMutation: () => ({ mutateAsync: mocks.submit }) },
      estimateWorkflow: { useMutation: () => ({ mutateAsync: mocks.estimate }) },
      pollWorkflow: { useMutation: () => ({ mutateAsync: mocks.poll }) },
      cancelWorkflow: { useMutation: () => ({ mutateAsync: mocks.cancel }) },
      getMyBuzzBalance: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      getMyBuzzTransactions: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      getMyBuzzAccounts: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      getMyDailyCompensation: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      getMyViewer: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      queryAppWorkflows: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      cancelAppWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      publishGenerationOutputs: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      previewPostFromApp: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      createPostFromApp: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      getImagesByIds: { useMutation: () => ({ mutateAsync: vi.fn() }) },
    },
    apps: {
      shared: {
        append: { useMutation: () => ({ mutateAsync: mocks.sharedAppend }) },
        update: { useMutation: () => ({ mutateAsync: vi.fn() }) },
        vote: { useMutation: () => ({ mutateAsync: vi.fn() }) },
        unvote: { useMutation: () => ({ mutateAsync: vi.fn() }) },
        withdraw: { useMutation: () => ({ mutateAsync: vi.fn() }) },
        report: { useMutation: () => ({ mutateAsync: vi.fn() }) },
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
          get: { fetch: vi.fn() },
        },
        storage: {
          get: { fetch: mocks.storageGet },
          list: { fetch: vi.fn() },
          getQuota: { fetch: vi.fn() },
        },
      },
    }),
  },
}));

// eslint-disable-next-line import/first
import { PageBlockHost } from '~/components/AppBlocks/PageBlockHost';
// eslint-disable-next-line import/first
import { _internalsForTests as beacon } from '~/components/AppBlocks/bridgeMessageBeacon';

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

function listenForReply() {
  const received: Array<{ type: string; payload: unknown }> = [];
  const cw = iframeEl().contentWindow;
  if (!cw) throw new Error('iframe contentWindow missing');
  const handler = (e: MessageEvent) => {
    const d = e.data as { type?: string; payload?: unknown } | null;
    if (d && typeof d.type === 'string') received.push({ type: d.type, payload: d.payload });
  };
  cw.addEventListener('message', handler);
  return {
    last: (type: string) => [...received].reverse().find((m) => m.type === type),
    all: () => [...received],
    stop: () => cw.removeEventListener('message', handler),
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
  viewer: { id: 42, username: 'tester' },
  theme: 'light' as const,
};

async function mountWithoutToken() {
  renderWithProviders(<PageBlockHost {...baseProps} token={null} />);
  await vi.waitFor(() => {
    if (!iframeEl().contentWindow) throw new Error('not mounted yet');
  });
  return listenForReply();
}

const FAILED_SNAPSHOT = {
  workflowId: 'failed',
  status: 'failed',
  error: 'block credential unavailable',
};

describe('PageBlockHost refuses a credential-less request with a reply, never silence', () => {
  test.each([
    ['SUBMIT_WORKFLOW', { requestId: 'rq_s' }, 'WORKFLOW_SUBMITTED'],
    ['ESTIMATE_WORKFLOW', { requestId: 'rq_e' }, 'ESTIMATE_RESULT'],
    ['POLL_WORKFLOW', { requestId: 'rq_p', workflowId: 'wf_1' }, 'WORKFLOW_STATUS'],
    ['CANCEL_WORKFLOW', { requestId: 'rq_c', workflowId: 'wf_1' }, 'WORKFLOW_CANCELED'],
  ] as const)(
    '%s replies %s carrying a FAILURE SNAPSHOT (a bare error would be dropped by the SDK validator)',
    async (type, payload, replyType) => {
      const replies = await mountWithoutToken();
      postFromBlock(type, payload);
      await vi.waitFor(
        () => {
          if (!replies.last(replyType)) throw new Error('no reply yet');
        },
        { timeout: 1000, interval: 5 }
      );
      expect(replies.last(replyType)!.payload).toEqual({
        requestId: payload.requestId,
        snapshot: FAILED_SNAPSHOT,
      });
      // 🔴 The refusal is still a refusal: no money call may be attempted.
      expect(mocks.submit).not.toHaveBeenCalled();
      expect(mocks.estimate).not.toHaveBeenCalled();
      expect(mocks.poll).not.toHaveBeenCalled();
      expect(mocks.cancel).not.toHaveBeenCalled();
      replies.stop();
    }
  );

  test.each([
    ['APP_STORAGE_GET', { requestId: 'rq_g', key: 'k' }, 'APP_STORAGE_GET_RESULT'],
    [
      'APP_STORAGE_SET',
      { requestId: 'rq_st', key: 'k', value: { a: 1 } },
      'APP_STORAGE_SET_RESULT',
    ],
    ['APP_STORAGE_DELETE', { requestId: 'rq_d', key: 'k' }, 'APP_STORAGE_DELETE_RESULT'],
    ['APP_STORAGE_LIST', { requestId: 'rq_l' }, 'APP_STORAGE_LIST_RESULT'],
    ['APP_STORAGE_QUOTA', { requestId: 'rq_q' }, 'APP_STORAGE_QUOTA_RESULT'],
    ['SHARED_LIST', { requestId: 'rq_sl' }, 'SHARED_LIST_RESULT'],
    ['SHARED_APPEND', { requestId: 'rq_sa', value: { title: 't' } }, 'SHARED_APPEND_RESULT'],
    ['SHARED_GET', { requestId: 'rq_sg', key: 'k' }, 'SHARED_GET_RESULT'],
  ] as const)(
    '%s replies %s carrying a bare `error` (its validator early-accepts one; the hook throws on it)',
    async (type, payload, replyType) => {
      const replies = await mountWithoutToken();
      postFromBlock(type, payload);
      await vi.waitFor(
        () => {
          if (!replies.last(replyType)) throw new Error('no reply yet');
        },
        { timeout: 1000, interval: 5 }
      );
      expect(replies.last(replyType)!.payload).toEqual({
        requestId: payload.requestId,
        error: 'block credential unavailable',
      });
      expect(mocks.storageGet).not.toHaveBeenCalled();
      expect(mocks.storageSet).not.toHaveBeenCalled();
      expect(mocks.sharedAppend).not.toHaveBeenCalled();
      replies.stop();
    }
  );

  test('a credential-less request with NO requestId is still silent — nothing to correlate to', async () => {
    // 🔴 NOT AN INVARIANT GUARD, despite passing at `origin/main` (where nothing
    // is answered at all). It discriminates a real mutation of the new code:
    // widen the `typeof raw.requestId !== 'string'` guard above the `nack` call
    // and this goes red. Filed as regression coverage for that, not as evidence
    // about the base.
    const replies = await mountWithoutToken();
    postFromBlock('SUBMIT_WORKFLOW', {});
    await new Promise((r) => setTimeout(r, 150));
    expect(replies.last('WORKFLOW_SUBMITTED')).toBeUndefined();
    replies.stop();
  });

  test("THE SEAM: a real mount reaches the real beacon buffer with `no_token` and this host's labels", async () => {
    // 🔴 EVERY OTHER TEST IN THIS FILE ASSERTS THE REPLY, NOT THE COUNT — and the
    // two are produced by different lines. `nack` both reports and replies; delete
    // its `report(type, 'no_token')` and all 12 reply assertions stay green while
    // the `no_token` series, the entire deliverable of the 19 new call sites, goes
    // permanently flat. This is the one assertion that spans
    // handler -> hook -> real default sink -> buffer.
    beacon.reset();
    const replies = await mountWithoutToken();
    postFromBlock('APP_STORAGE_GET', { requestId: 'rq_seam', key: 'k' });
    await vi.waitFor(() => {
      if (!replies.last('APP_STORAGE_GET_RESULT')) throw new Error('no reply yet');
    });
    expect(beacon.buffered()).toContainEqual(
      expect.objectContaining({
        appBlockId: 'apb_test',
        host: 'PageBlockHost',
        type: 'APP_STORAGE_GET',
        outcome: 'no_token',
      })
    );
    replies.stop();
    beacon.reset();
  });

  test('THE SEAM, second arm: a handler that keeps its OWN reply shape still COUNTS', async () => {
    // The 12 sites that already answered a credential-less request in a bespoke
    // shape (`GET_VIEWER` among them) were left replying as they were and given
    // `reportNoToken`. Without this arm the `no_token` series would cover 18 of 30
    // refusal sites while the counter's help text claims all of them — a
    // description wider than its implementation, on exactly the money-adjacent
    // paths.
    beacon.reset();
    const replies = await mountWithoutToken();
    postFromBlock('GET_VIEWER', { requestId: 'rq_viewer_seam' });
    await vi.waitFor(() => {
      if (!replies.last('VIEWER_RESULT')) throw new Error('no reply yet');
    });
    expect(beacon.buffered()).toContainEqual(
      expect.objectContaining({
        appBlockId: 'apb_test',
        host: 'PageBlockHost',
        type: 'GET_VIEWER',
        outcome: 'no_token',
      })
    );
    replies.stop();
    beacon.reset();
  });
});
