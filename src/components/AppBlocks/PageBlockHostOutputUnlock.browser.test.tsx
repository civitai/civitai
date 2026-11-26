import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { expectReplyKeys } from '../../../test/expectReplyKeys';
import { useDialogStore } from '~/components/Dialog/dialogStore';
import type * as TrpcMod from '~/utils/trpc';

/**
 * REQUEST_OUTPUT_UNLOCK on the PAGE host: the app names a restricted output; the host asks the
 * server what may be offered, draws its own dialog, and replies OUTPUT_UNLOCK_RESULT { result }.
 * The dialog itself is driven through its props (the store holds them; no DialogProvider is
 * mounted here), so these tests pin what the HOST sends and relays, not the dialog's layout.
 */

const mocks = vi.hoisted(() => ({
  preview: vi.fn(),
  unlock: vi.fn(),
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeInertSubRouter, makeTrpcProxy } = await import('../../../test/trpcProxyStub');
  const baseUtils = (makeTrpcProxy() as { useUtils: () => Record<string, unknown> }).useUtils();
  // The bridge calls the two procedures through the vanilla client, on request.
  const client = {
    blocks: {
      previewOutputUnlock: { mutate: mocks.preview },
      unlockOutput: { mutate: mocks.unlock },
    },
  };
  const utils = new Proxy(baseUtils, {
    get: (target, key) => (key === 'client' ? client : Reflect.get(target, key)),
  });
  return {
    ...(await importOriginal<typeof TrpcMod>()),
    setTrpcBatchingEnabled: vi.fn(),
    trpc: makeTrpcProxy(
      {
        'apps.shared': makeInertSubRouter(),
        'apps.storage': makeInertSubRouter(),
      },
      { useUtils: () => utils }
    ),
  };
});

// eslint-disable-next-line import/first
import { PageBlockHost } from '~/components/AppBlocks/PageBlockHost';

const WF = '42-20261115120000000';
const PAY = { kind: 'pay', position: 1, unlockBuzz: 137 };
const UNLOCKED_SNAPSHOT = {
  workflowId: WF,
  status: 'succeeded',
  outputs: [
    { url: 'https://cdn/pg0.png', nsfwLevel: 'pg' },
    { url: 'https://cdn/r1.png', nsfwLevel: 'r' },
  ],
};

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
  cw.addEventListener('message', (e: MessageEvent) => {
    const d = e.data as { type?: string; payload?: unknown } | null;
    if (d && typeof d.type === 'string') received.push({ type: d.type, payload: d.payload });
  });
  return { of: (type: string) => received.filter((m) => m.type === type) };
}

const baseProps = {
  appBlockId: 'apb_test',
  blockId: 'live-characters',
  appId: 'app_test',
  blockInstanceId: 'page_apb_test',
  appName: 'Live Characters',
  iframeSrc: `${window.location.origin}/`,
  surface: 'page-run' as const,
  bootSkeleton: false,
  sandbox: 'allow-scripts',
  trustTier: 'internal' as const,
  slug: 'live-characters',
  token: 'tok_abc',
  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  declaredScopes: ['ai:write:budgeted'] as string[],
  missingScopes: [] as string[],
  needsConsent: false,
  tokenError: false,
  viewer: { id: 42, username: 'tester' } as { id: number; username: string | null } | null,
  theme: 'light' as const,
};

async function mount() {
  renderWithProviders(<PageBlockHost {...baseProps} />);
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

async function resultFor(replies: ReturnType<typeof listenForReply>, requestId: string) {
  await vi.waitFor(() => {
    const got = replies
      .of('OUTPUT_UNLOCK_RESULT')
      .some((m) => (m.payload as { requestId?: string }).requestId === requestId);
    if (!got) throw new Error(`no OUTPUT_UNLOCK_RESULT for ${requestId}`);
  });
  return replies
    .of('OUTPUT_UNLOCK_RESULT')
    .find((m) => (m.payload as { requestId?: string }).requestId === requestId)!.payload as {
    requestId: string;
    result: Record<string, unknown>;
  };
}

type UnlockDialog = {
  props: {
    offer: Record<string, unknown>;
    unlock: (expectedTotal: number) => Promise<Record<string, unknown>>;
    onResult: (r: unknown) => void;
    onLinkedOut: () => void;
    linkOut?: { slug: string; subPath: string } | null;
  };
  options?: { onClose?: () => void };
};

function unlockDialogs() {
  return useDialogStore
    .getState()
    .dialogs.filter((d) =>
      String(d.id).startsWith('block-output-unlock-')
    ) as unknown as UnlockDialog[];
}

async function openDialog() {
  await vi.waitFor(() => expect(unlockDialogs()).toHaveLength(1));
  return unlockDialogs()[0];
}

describe('PageBlockHost REQUEST_OUTPUT_UNLOCK', () => {
  beforeEach(() => {
    mocks.preview.mockReset();
    mocks.unlock.mockReset();
    useDialogStore.getState().closeAll();
  });

  test('pay: the server preview is offered, the confirmed unlock runs at its total, the snapshot is relayed', async () => {
    mocks.preview.mockResolvedValue(PAY);
    mocks.unlock.mockResolvedValue({
      outcome: 'unlocked',
      snapshot: UNLOCKED_SNAPSHOT,
      charged: { unlockBuzz: 137 },
    });
    const replies = await mount();
    postFromBlock('REQUEST_OUTPUT_UNLOCK', { requestId: 'rq_pay', workflowId: WF, position: 1 });
    const dialog = await openDialog();
    expect(mocks.preview).toHaveBeenCalledWith({
      blockToken: 'tok_abc',
      workflowId: WF,
      position: 1,
    });
    expect(dialog.props.offer).toEqual(PAY);
    // Nothing is spent until the viewer confirms in the host's dialog.
    expect(mocks.unlock).not.toHaveBeenCalled();

    dialog.props.onResult(await dialog.props.unlock(137));
    expect(mocks.unlock).toHaveBeenCalledWith({
      blockToken: 'tok_abc',
      workflowId: WF,
      position: 1,
      expectedTotal: 137,
    });
    dialog.options?.onClose?.();

    const payload = await resultFor(replies, 'rq_pay');
    expect(payload.result).toEqual({ outcome: 'unlocked', snapshot: UNLOCKED_SNAPSHOT });
    expectReplyKeys('REQUEST_OUTPUT_UNLOCK', 'success', ['result'], payload);
  });

  test("not-released: the reply carries the server's message about why it stays hidden", async () => {
    const message =
      'The unlock went through, but this output is rated above your browsing level, so it stays hidden.';
    const stillRestricted = {
      workflowId: WF,
      status: 'succeeded',
      outputs: [
        { url: 'https://cdn/pg0.png', nsfwLevel: 'pg' },
        { restricted: true, reason: 'ceiling' },
      ],
    };
    mocks.preview.mockResolvedValue(PAY);
    mocks.unlock.mockResolvedValue({
      outcome: 'not-released',
      snapshot: stillRestricted,
      charged: { unlockBuzz: 0 },
      message,
    });
    const replies = await mount();
    postFromBlock('REQUEST_OUTPUT_UNLOCK', { requestId: 'rq_nr', workflowId: WF, position: 1 });
    const dialog = await openDialog();
    dialog.props.onResult(await dialog.props.unlock(137));
    dialog.options?.onClose?.();
    expect((await resultFor(replies, 'rq_nr')).result).toEqual({
      outcome: 'not-released',
      snapshot: stillRestricted,
      message,
    });
  });

  test('link-out: never charged; the reply says the viewer went to civitai.red', async () => {
    mocks.preview.mockResolvedValue({
      kind: 'link-out',
      position: 0,
      message: 'This output is mature content. Open it on civitai.red to view it.',
    });
    const replies = await mount();
    postFromBlock('REQUEST_OUTPUT_UNLOCK', { requestId: 'rq_red', workflowId: WF, position: 0 });
    const dialog = await openDialog();
    // The dialog links to the SAME app on red, from the host's own slug and route (never from
    // the app); `outputUnlockRedHref` builds the URL from these.
    expect(dialog.props.linkOut).toEqual({ slug: 'live-characters', subPath: '' });
    dialog.props.onLinkedOut();
    dialog.options?.onClose?.();
    expect((await resultFor(replies, 'rq_red')).result).toEqual({ outcome: 'linked-out' });
    expect(mocks.unlock).not.toHaveBeenCalled();
  });

  test('a dismissed dialog replies dismissed and spends nothing', async () => {
    mocks.preview.mockResolvedValue(PAY);
    const replies = await mount();
    postFromBlock('REQUEST_OUTPUT_UNLOCK', { requestId: 'rq_no', workflowId: WF, position: 1 });
    (await openDialog()).options?.onClose?.();
    expect((await resultFor(replies, 'rq_no')).result).toEqual({ outcome: 'dismissed' });
    expect(mocks.unlock).not.toHaveBeenCalled();
  });

  test('an output that already has a url opens no dialog', async () => {
    mocks.preview.mockResolvedValue({ kind: 'not-restricted', position: 0 });
    const replies = await mount();
    postFromBlock('REQUEST_OUTPUT_UNLOCK', { requestId: 'rq_ok', workflowId: WF, position: 0 });
    expect((await resultFor(replies, 'rq_ok')).result).toEqual({
      outcome: 'not-restricted',
    });
    expect(unlockDialogs()).toHaveLength(0);
  });

  test('a malformed request is answered unavailable without asking the server', async () => {
    const replies = await mount();
    postFromBlock('REQUEST_OUTPUT_UNLOCK', { requestId: 'rq_bad', workflowId: WF, position: -1 });
    expect((await resultFor(replies, 'rq_bad')).result).toMatchObject({ outcome: 'unavailable' });
    expect(mocks.preview).not.toHaveBeenCalled();
  });

  test('a preview the server refuses (not this viewer, not this app) is relayed as unavailable', async () => {
    mocks.preview.mockRejectedValue(new Error('workflow does not belong to this viewer'));
    const replies = await mount();
    postFromBlock('REQUEST_OUTPUT_UNLOCK', { requestId: 'rq_own', workflowId: '7-1', position: 0 });
    expect((await resultFor(replies, 'rq_own')).result).toEqual({
      outcome: 'unavailable',
      message: 'workflow does not belong to this viewer',
    });
    expect(unlockDialogs()).toHaveLength(0);
  });
});
