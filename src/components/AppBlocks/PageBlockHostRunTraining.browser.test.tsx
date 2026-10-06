import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { DialogProvider } from '~/components/Dialog/DialogProvider';
import { useDialogStore } from '~/components/Dialog/dialogStore';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';
import { makeInertSubRouter, makeTrpcProxy } from '../../../test/trpcProxyStub';

/**
 * RUN_TRAINING → TRAINING_RESULT on the PAGE host, through a REAL Modal.
 *
 * The behavioural pins for the `kind:'training'` consent bridge: the dialog shows
 * the SERVER'S price (never a number from the block), a dismissal replies
 * `declined` with nothing confirmed or submitted, a confirmation records consent
 * through the session-only procedure BEFORE the submit, and a block that is not
 * ready is refused without a dialog.
 */

const { previewMutate, consentMutate, submitMutate } = vi.hoisted(() => ({
  previewMutate: vi.fn(),
  consentMutate: vi.fn(),
  submitMutate: vi.fn(),
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  setTrpcBatchingEnabled: vi.fn(),
  // Proxy-shaped: every procedure this file does not measure answers with an inert
  // hook. The training preview/confirm are reached through the vanilla client.
  trpc: makeTrpcProxy(
    {
      'blocks.submitWorkflow': { useMutation: () => ({ mutateAsync: submitMutate }) },
      // PageBlockHost also reads two NESTED sub-routers (`apps.shared.*`,
      // `apps.storage.*`), one level deeper than the proxy answers on its own.
      'apps.shared': makeInertSubRouter(),
      'apps.storage': makeInertSubRouter(),
    },
    {
      useUtils: () => ({
        client: {
          blocks: {
            previewTrainingQuote: { mutate: previewMutate },
            consentTrainingQuote: { mutate: consentMutate },
          },
        },
      }),
    }
  ),
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
    of: (type: string) => received.filter((m) => m.type === type),
    last: (type: string) => [...received].reverse().find((m) => m.type === type),
    stop: () => cw.removeEventListener('message', handler),
  };
}

const SAME_ORIGIN_SRC = `${window.location.origin}/`;
const baseProps = {
  appBlockId: 'apb_test',
  blockId: 'trainer-app',
  appId: 'app_test',
  blockInstanceId: 'page_apb_test',
  appName: 'LoRA Trainer',
  iframeSrc: SAME_ORIGIN_SRC,
  surface: 'page-run' as const,
  bootSkeleton: false,
  sandbox: 'allow-scripts',
  trustTier: 'internal' as const,
  slug: 'trainer-app',
  token: 'tok_abc',
  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  declaredScopes: [] as string[],
  missingScopes: [] as string[],
  needsConsent: false,
  tokenError: false,
  viewer: { id: 42, username: 'tester' } as { id: number; username: string | null } | null,
  theme: 'light' as const,
};

async function mount(over: Partial<typeof baseProps> = {}) {
  renderWithProviders(
    <>
      <PageBlockHost {...baseProps} {...over} />
      <DialogProvider />
    </>
  );
  await vi.waitFor(() => {
    const el = page.getByTestId('app-page-iframe').element() as HTMLIFrameElement;
    if (!el.contentWindow) throw new Error('not mounted yet');
  });
}

async function driveToReady() {
  await vi.waitFor(() => {
    postFromBlock('BLOCK_READY', {});
    const el = page.getByTestId('app-page-iframe').element() as HTMLIFrameElement;
    if (el.getAttribute('data-block-ready') !== 'true') throw new Error('not ready yet');
  });
}

const QUOTE_ID = `tq_${'a'.repeat(32)}`;
// The block's own body. `displayPrice` is a block-chosen number the host must
// never render — the strict wire schema would also reject it at the server.
const BODY = {
  kind: 'training',
  datasetId: `tds_${'b'.repeat(32)}`,
  quoteId: QUOTE_ID,
  displayPrice: 7,
};
const PREVIEW = {
  quoteId: QUOTE_ID,
  total: 1234,
  imageCount: 3,
  modelName: 'SDXL',
  epochs: 5,
  steps: null,
  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  thumbnails: [],
  shortfall: 0,
};
const SNAPSHOT = { workflowId: '42-1', status: 'pending' };

describe('PageBlockHost RUN_TRAINING (consent-gated training run)', () => {
  beforeEach(() => {
    useDialogStore.getState().closeAll();
    previewMutate.mockReset();
    consentMutate.mockReset();
    submitMutate.mockReset();
    previewMutate.mockResolvedValue(PREVIEW);
    consentMutate.mockResolvedValue({ quoteId: QUOTE_ID, total: 1234, consented: true });
    submitMutate.mockResolvedValue({ snapshot: SNAPSHOT });
  });

  test('shows the SERVER’S price; confirm records consent and THEN submits', async () => {
    await mount();
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('RUN_TRAINING', { requestId: 'rq_1', body: BODY });

    const confirmBtn = page.getByRole('button', { name: 'Train for 1,234 Buzz' });
    await expect.element(confirmBtn).toBeInTheDocument();
    await expect
      .element(page.getByTestId('block-training-price'))
      .toHaveTextContent('This run costs 1,234 Buzz, charged when it starts.');
    // Nothing confirmed or submitted while the viewer is still deciding.
    expect(consentMutate).not.toHaveBeenCalled();
    expect(submitMutate).not.toHaveBeenCalled();
    expect(previewMutate).toHaveBeenCalledWith({ blockToken: 'tok_abc', quoteId: QUOTE_ID });

    await confirmBtn.click();

    await vi.waitFor(() => {
      const r = replies.last('TRAINING_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_1', snapshot: SNAPSHOT });
    });
    expect(consentMutate).toHaveBeenCalledWith({ blockToken: 'tok_abc', quoteId: QUOTE_ID });
    expect(submitMutate).toHaveBeenCalledWith({ blockToken: 'tok_abc', body: BODY });
    expect(consentMutate.mock.invocationCallOrder[0]).toBeLessThan(
      submitMutate.mock.invocationCallOrder[0]
    );
    expect(replies.of('TRAINING_RESULT')).toHaveLength(1);
    replies.stop();
  });

  test('the block’s own number is never on the consent surface', async () => {
    await mount();
    await driveToReady();
    postFromBlock('RUN_TRAINING', { requestId: 'rq_2', body: { ...BODY, displayPrice: 999 } });
    await expect.element(page.getByTestId('block-training-consent')).toBeInTheDocument();
    const text = page.getByTestId('block-training-consent').element().textContent ?? '';
    expect(text).toContain('1,234');
    expect(text).not.toContain('999');
  });

  test('🔴 cancel replies `declined` and NOTHING is confirmed or submitted', async () => {
    await mount();
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('RUN_TRAINING', { requestId: 'rq_3', body: BODY });
    await expect
      .element(page.getByRole('button', { name: 'Train for 1,234 Buzz' }))
      .toBeInTheDocument();
    await page.getByRole('button', { name: 'Cancel' }).click();

    await vi.waitFor(() => {
      const r = replies.last('TRAINING_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_3', error: 'declined' });
    });
    expect(consentMutate).not.toHaveBeenCalled();
    expect(submitMutate).not.toHaveBeenCalled();
    replies.stop();
  });

  test('positive control: ESC before confirming also declines through the real Modal', async () => {
    await mount();
    await driveToReady();
    const replies = listenForReply();
    postFromBlock('RUN_TRAINING', { requestId: 'rq_4', body: BODY });
    await expect
      .element(page.getByRole('button', { name: 'Train for 1,234 Buzz' }))
      .toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await vi.waitFor(() => {
      const r = replies.last('TRAINING_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_4', error: 'declined' });
    });
    expect(submitMutate).not.toHaveBeenCalled();
    replies.stop();
  });

  test('a block that is not ready is refused — no preview, no dialog', async () => {
    await mount();
    const replies = listenForReply();
    postFromBlock('RUN_TRAINING', { requestId: 'rq_5', body: BODY });
    await vi.waitFor(() => {
      const r = replies.last('TRAINING_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_5', error: 'block is not ready' });
    });
    expect(previewMutate).not.toHaveBeenCalled();
    expect(useDialogStore.getState().dialogs).toHaveLength(0);
    replies.stop();
  });

  test('a refused preview (e.g. expired quote) replies with the server error and opens nothing', async () => {
    previewMutate.mockRejectedValue(new Error('training quote not found or expired'));
    await mount();
    await driveToReady();
    const replies = listenForReply();
    postFromBlock('RUN_TRAINING', { requestId: 'rq_6', body: BODY });
    await vi.waitFor(() => {
      const r = replies.last('TRAINING_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({
        requestId: 'rq_6',
        error: 'training quote not found or expired',
      });
    });
    expect(useDialogStore.getState().dialogs).toHaveLength(0);
    expect(submitMutate).not.toHaveBeenCalled();
    replies.stop();
  });

  test('a refused confirmation replies with the error and NEVER submits', async () => {
    consentMutate.mockRejectedValue(new Error('training quote not found or expired'));
    await mount();
    await driveToReady();
    const replies = listenForReply();
    postFromBlock('RUN_TRAINING', { requestId: 'rq_7', body: BODY });
    const confirmBtn = page.getByRole('button', { name: 'Train for 1,234 Buzz' });
    await expect.element(confirmBtn).toBeInTheDocument();
    await confirmBtn.click();
    await vi.waitFor(() => {
      const r = replies.last('TRAINING_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({
        requestId: 'rq_7',
        error: 'training quote not found or expired',
      });
    });
    expect(submitMutate).not.toHaveBeenCalled();
    replies.stop();
  });

  test('an anonymous viewer is refused — no preview, no dialog', async () => {
    await mount({ viewer: null });
    await driveToReady();
    const replies = listenForReply();
    postFromBlock('RUN_TRAINING', { requestId: 'rq_8', body: BODY });
    await vi.waitFor(() => {
      const r = replies.last('TRAINING_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_8', error: 'sign in to train' });
    });
    expect(previewMutate).not.toHaveBeenCalled();
    replies.stop();
  });

  test('a lost submit RESPONSE replies `submission-unconfirmed` at once and is never resent', async () => {
    submitMutate.mockRejectedValueOnce(new Error('Failed to fetch'));
    await mount();
    await driveToReady();
    const replies = listenForReply();
    postFromBlock('RUN_TRAINING', { requestId: 'rq_9', body: BODY });
    const confirmBtn = page.getByRole('button', { name: 'Train for 1,234 Buzz' });
    await expect.element(confirmBtn).toBeInTheDocument();
    await confirmBtn.click();
    await vi.waitFor(() => {
      const r = replies.last('TRAINING_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_9', error: 'submission-unconfirmed' });
    });
    expect(submitMutate).toHaveBeenCalledTimes(1);
    expect(consentMutate).toHaveBeenCalledTimes(1);
    expect(replies.of('TRAINING_RESULT')).toHaveLength(1);
    replies.stop();
  });

  test('a submit the SERVER could not confirm replies `submission-unconfirmed`, not its failed snapshot', async () => {
    submitMutate.mockResolvedValueOnce({
      snapshot: { workflowId: 'failed', status: 'failed', error: 'could not be confirmed' },
      submissionUnconfirmed: true,
    });
    await mount();
    await driveToReady();
    const replies = listenForReply();
    postFromBlock('RUN_TRAINING', { requestId: 'rq_11', body: BODY });
    const confirmBtn = page.getByRole('button', { name: 'Train for 1,234 Buzz' });
    await expect.element(confirmBtn).toBeInTheDocument();
    await confirmBtn.click();
    await vi.waitFor(() => {
      const r = replies.last('TRAINING_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_11', error: 'submission-unconfirmed' });
    });
    expect(submitMutate).toHaveBeenCalledTimes(1);
    replies.stop();
  });

  test('a server REFUSAL of the submit is not resent', async () => {
    submitMutate.mockRejectedValueOnce(
      Object.assign(new Error('this training run has not been confirmed'), {
        data: { code: 'FORBIDDEN' },
      })
    );
    await mount();
    await driveToReady();
    const replies = listenForReply();
    postFromBlock('RUN_TRAINING', { requestId: 'rq_10', body: BODY });
    const confirmBtn = page.getByRole('button', { name: 'Train for 1,234 Buzz' });
    await expect.element(confirmBtn).toBeInTheDocument();
    await confirmBtn.click();
    await vi.waitFor(() => {
      const r = replies.last('TRAINING_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({
        requestId: 'rq_10',
        error: 'this training run has not been confirmed',
      });
    });
    expect(submitMutate).toHaveBeenCalledTimes(1);
    replies.stop();
  });
});
