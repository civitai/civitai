import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { expectReplyKeys } from '../../../test/expectReplyKeys';
import { useDialogStore } from '~/components/Dialog/dialogStore';
import {
  openDailyLimitRaise,
  resetDailyLimitRaiseSuppression,
} from '~/components/AppBlocks/openDailyLimitRaise';
import type * as TrpcMod from '~/utils/trpc';
import type * as FeatureFlagsMod from '~/providers/FeatureFlagsProvider';

/**
 * The in-app raise of the viewer's per-app daily Buzz limit, on the PAGE host: a relayed submit
 * refused at the limit opens the host's raise dialog, the viewer raises it, and the next submit
 * goes through; and the app's own REQUEST_DAILY_LIMIT_RAISE opens the dialog only after a refusal
 * the host saw or the server recorded.
 */

const mocks = vi.hoisted(() => ({
  submit: vi.fn(),
  readLimit: vi.fn(),
  raiseFlagOn: true,
}));

vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => {
  const real = await importOriginal<typeof FeatureFlagsMod>();
  return {
    ...real,
    useOptionalFeatureFlags: () => ({
      ...(real.useOptionalFeatureFlags() ?? {}),
      appDailyLimitRaise: mocks.raiseFlagOn,
    }),
  };
});

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeInertSubRouter, makeTrpcProxy } = await import('../../../test/trpcProxyStub');
  const baseUtils = (makeTrpcProxy() as { useUtils: () => Record<string, unknown> }).useUtils();
  const blocksUtils = {
    getMyAppDailyLimit: { fetch: mocks.readLimit, invalidate: vi.fn(async () => undefined) },
    listMyScopeGrants: { invalidate: vi.fn(async () => undefined) },
  };
  const utils = new Proxy(baseUtils, {
    get: (target, key) =>
      key === 'blocks'
        ? new Proxy(Reflect.get(target, key) as object, {
            get: (t, k) => (k in blocksUtils ? blocksUtils[k as never] : Reflect.get(t, k)),
          })
        : Reflect.get(target, key),
  });
  return {
    ...(await importOriginal<typeof TrpcMod>()),
    setTrpcBatchingEnabled: vi.fn(),
    trpc: makeTrpcProxy(
      {
        'apps.shared': makeInertSubRouter(),
        'apps.storage': makeInertSubRouter(),
        'blocks.submitWorkflow': { useMutation: () => ({ mutateAsync: mocks.submit }) },
      },
      { useUtils: () => utils }
    ),
  };
});

// eslint-disable-next-line import/first
import { PageBlockHost } from '~/components/AppBlocks/PageBlockHost';

const REFUSED = {
  workflowId: 'failed',
  status: 'failed',
  error: 'app Buzz limit reached: 980 already spent today by this app on your behalf',
  errorCode: 'daily-limit-exceeded',
};
const OK = { workflowId: 'wf_ok', status: 'unassigned' };
const LIMIT = { limit: 1000, spentToday: 980, refusedRecently: false };

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
  return { of: (type: string) => received.filter((m) => m.type === type) };
}

const SAME_ORIGIN_SRC = `${window.location.origin}/`;
const baseProps = {
  appBlockId: 'apb_test',
  blockId: 'gen-app',
  appId: 'app_test',
  blockInstanceId: 'page_apb_test',
  appName: 'Live Gen',
  iframeSrc: SAME_ORIGIN_SRC,
  surface: 'page-run' as const,
  bootSkeleton: false,
  sandbox: 'allow-scripts',
  trustTier: 'internal' as const,
  slug: 'gen-app',
  token: 'tok_abc',
  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  declaredScopes: ['ai:write:budgeted'] as string[],
  missingScopes: [] as string[],
  needsConsent: false,
  tokenError: false,
  viewer: { id: 42, username: 'tester' } as { id: number; username: string | null } | null,
  theme: 'light' as const,
};

async function mount(over: { reviewMode?: boolean } = {}) {
  renderWithProviders(
    <PageBlockHost
      {...baseProps}
      {...over}
      {...(over.reviewMode ? { onConsentGranted: vi.fn() } : {})}
    />
  );
  await vi.waitFor(() => {
    if (!iframeEl().contentWindow) throw new Error('not mounted yet');
  });
  const replies = listenForReply();
  await vi.waitFor(() => {
    postFromBlock('BLOCK_READY', {});
    if (iframeEl().getAttribute('data-block-ready') !== 'true') throw new Error('not ready');
  });
  return replies;
}

async function submit(replies: ReturnType<typeof listenForReply>, requestId: string) {
  postFromBlock('SUBMIT_WORKFLOW', { requestId, body: {} });
  await vi.waitFor(() => {
    const got = replies
      .of('WORKFLOW_SUBMITTED')
      .some((m) => (m.payload as { requestId?: string }).requestId === requestId);
    if (!got) throw new Error(`no reply for ${requestId}`);
  });
}

async function raiseRequest(replies: ReturnType<typeof listenForReply>, requestId: string) {
  postFromBlock('REQUEST_DAILY_LIMIT_RAISE', { requestId });
  await vi.waitFor(() => {
    if (!replies.of('DAILY_LIMIT_RAISE_ACK').some((m) => hasId(m.payload, requestId)))
      throw new Error('no ack yet');
  });
  return replies.of('DAILY_LIMIT_RAISE_ACK').find((m) => hasId(m.payload, requestId))!.payload as {
    requestId: string;
    opened: boolean;
  };
}

function hasId(payload: unknown, requestId: string) {
  return (payload as { requestId?: string }).requestId === requestId;
}

async function resultOf(replies: ReturnType<typeof listenForReply>, requestId: string) {
  await vi.waitFor(() => {
    if (!replies.of('DAILY_LIMIT_RAISE_RESULT').some((m) => hasId(m.payload, requestId)))
      throw new Error('no result yet');
  });
  return replies.of('DAILY_LIMIT_RAISE_RESULT').find((m) => hasId(m.payload, requestId))!.payload;
}

type RaiseDialog = {
  props: { appBlockId: string; limit: number; spentToday: number; onRaised?: () => void };
  options?: { onClose?: () => void };
};

/** The host opens the dialog through the shared store (the harness does not render dialogs). */
function openRaiseDialogs(): RaiseDialog[] {
  return useDialogStore
    .getState()
    .dialogs.filter((d) =>
      String(d.id).startsWith('block-daily-limit-')
    ) as unknown as RaiseDialog[];
}

async function raiseDialog(): Promise<RaiseDialog> {
  await vi.waitFor(() => expect(openRaiseDialogs()).toHaveLength(1));
  return openRaiseDialogs()[0];
}

/** What the dialog does on a confirmed raise, then on its own close. */
function viewerRaises(d: RaiseDialog) {
  d.props.onRaised?.();
  d.options?.onClose?.();
  useDialogStore.getState().closeAll();
}

function viewerDeclines(d: RaiseDialog) {
  d.options?.onClose?.();
  useDialogStore.getState().closeAll();
}

describe('PageBlockHost in-app daily-limit raise', () => {
  beforeEach(() => {
    mocks.submit.mockReset();
    mocks.readLimit.mockReset();
    mocks.raiseFlagOn = true;
    useDialogStore.getState().closeAll();
    resetDailyLimitRaiseSuppression();
  });

  test('a refused submit opens the raise dialog with the server numbers', async () => {
    mocks.submit.mockResolvedValue({ snapshot: REFUSED });
    mocks.readLimit.mockResolvedValue(LIMIT);
    const replies = await mount();

    await submit(replies, 'rq_1');
    const d = await raiseDialog();
    expect(d.props).toMatchObject({ appBlockId: 'apb_test', limit: 1000, spentToday: 980 });
    expect(mocks.readLimit).toHaveBeenCalledWith({ appBlockId: 'apb_test' }, expect.anything());
  });

  test('repeated refusals open one dialog, and "Not now" keeps it shut for this app', async () => {
    mocks.submit.mockResolvedValue({ snapshot: REFUSED });
    mocks.readLimit.mockResolvedValue(LIMIT);
    const replies = await mount();
    await submit(replies, 'rq_a');
    await submit(replies, 'rq_b');
    const d = await raiseDialog();
    viewerDeclines(d);
    const readsBefore = mocks.readLimit.mock.calls.length;
    await submit(replies, 'rq_c');
    // Suppression is checked before the read, so a suppressed refusal reads nothing.
    expect(mocks.readLimit).toHaveBeenCalledTimes(readsBefore);
    expect(openRaiseDialogs()).toHaveLength(0);
  });

  test('a second offer while the dialog is open says so, so no fallback prompt stacks on it', async () => {
    const utils = {
      blocks: { getMyAppDailyLimit: { fetch: async () => LIMIT } },
    } as unknown as Parameters<typeof openDailyLimitRaise>[0]['utils'];
    void openDailyLimitRaise({ utils, appBlockId: 'apb_test' });
    await raiseDialog();
    expect(await openDailyLimitRaise({ utils, appBlockId: 'apb_test' })).toBe('already-open');
  });

  test('a refused submit opens nothing when the server has no limit to raise', async () => {
    mocks.submit.mockResolvedValue({ snapshot: REFUSED });
    mocks.readLimit.mockResolvedValue(null);
    const replies = await mount();
    await submit(replies, 'rq_none');
    await vi.waitFor(() => expect(mocks.readLimit).toHaveBeenCalled());
    // The app's own request reads after the refusal's read has settled, so its ack is the end state.
    const ack = await raiseRequest(replies, 'rq_none_ask');
    expect(ack.opened).toBe(false);
    expect(mocks.readLimit).toHaveBeenCalledTimes(2);
    expect(openRaiseDialogs()).toHaveLength(0);
  });

  test('flag off: a refused submit reads nothing and opens nothing, and the request says opened:false', async () => {
    mocks.raiseFlagOn = false;
    mocks.submit.mockResolvedValue({ snapshot: REFUSED });
    mocks.readLimit.mockResolvedValue(LIMIT);
    const replies = await mount();
    await submit(replies, 'rq_off');
    const ack = await raiseRequest(replies, 'rq_off_ask');
    expect(ack.opened).toBe(false);
    expect(mocks.readLimit).not.toHaveBeenCalled();
    expect(openRaiseDialogs()).toHaveLength(0);
  });

  test('an ordinary submit reads nothing and opens nothing', async () => {
    mocks.submit.mockResolvedValue({ snapshot: OK });
    const replies = await mount();
    await submit(replies, 'rq_ok');
    expect(mocks.readLimit).not.toHaveBeenCalled();
    expect(openRaiseDialogs()).toHaveLength(0);
  });

  test("the app's request alone opens nothing: ack opened:false, result raised:false", async () => {
    mocks.readLimit.mockResolvedValue(LIMIT);
    const replies = await mount();
    const ack = await raiseRequest(replies, 'rq_ask');
    expect(ack.opened).toBe(false);
    const result = await resultOf(replies, 'rq_ask');
    expectReplyKeys('REQUEST_DAILY_LIMIT_RAISE', 'success', ['raised'], result);
    expect(result).toMatchObject({ raised: false });
    expect(openRaiseDialogs()).toHaveLength(0);
  });

  test('after a refusal the host relayed, the request opens the dialog and reports the raise', async () => {
    mocks.submit.mockResolvedValue({ snapshot: REFUSED });
    mocks.readLimit.mockResolvedValue(LIMIT);
    const replies = await mount();
    await submit(replies, 'rq_ref');
    viewerDeclines(await raiseDialog());
    // "Not now" suppresses the offer for this app, so reset it to measure the request alone.
    resetDailyLimitRaiseSuppression();

    const ack = await raiseRequest(replies, 'rq_raise');
    expect(ack.opened).toBe(true);
    viewerRaises(await raiseDialog());
    const result = await resultOf(replies, 'rq_raise');
    expectReplyKeys('REQUEST_DAILY_LIMIT_RAISE', 'success', ['raised'], result);
    expect(result).toMatchObject({ raised: true });

    // The refusal was at the old limit: asking again needs a new one.
    expect((await raiseRequest(replies, 'rq_again')).opened).toBe(false);
  });

  test('a refusal the server recorded opens the dialog for a REST submitter', async () => {
    mocks.readLimit.mockResolvedValue({ ...LIMIT, refusedRecently: true });
    const replies = await mount();
    expect((await raiseRequest(replies, 'rq_rest')).opened).toBe(true);
    viewerDeclines(await raiseDialog());
    expect(await resultOf(replies, 'rq_rest')).toMatchObject({ raised: false });
  });

  test('after "Not now" a repeated request opens nothing and reads nothing', async () => {
    mocks.readLimit.mockResolvedValue({ ...LIMIT, refusedRecently: true });
    const replies = await mount();
    expect((await raiseRequest(replies, 'rq_a')).opened).toBe(true);
    viewerDeclines(await raiseDialog());
    await resultOf(replies, 'rq_a');
    mocks.readLimit.mockClear();
    expect((await raiseRequest(replies, 'rq_b')).opened).toBe(false);
    expect(mocks.readLimit).not.toHaveBeenCalled();
  });

  test('a failed read opens nothing and still answers', async () => {
    mocks.readLimit.mockRejectedValue(new Error('redis down'));
    const replies = await mount();
    expect((await raiseRequest(replies, 'rq_err')).opened).toBe(false);
    expect(await resultOf(replies, 'rq_err')).toMatchObject({ raised: false });
  });

  test('in review mode the request never opens the dialog', async () => {
    mocks.readLimit.mockResolvedValue({ ...LIMIT, refusedRecently: true });
    const replies = await mount({ reviewMode: true });
    expect((await raiseRequest(replies, 'rq_rev')).opened).toBe(false);
    expect(await resultOf(replies, 'rq_rev')).toMatchObject({ raised: false });
    expect(mocks.readLimit).not.toHaveBeenCalled();
  });
});
