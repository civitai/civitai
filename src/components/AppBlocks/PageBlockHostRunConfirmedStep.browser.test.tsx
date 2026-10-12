import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { DialogProvider } from '~/components/Dialog/DialogProvider';
import { useDialogStore } from '~/components/Dialog/dialogStore';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';
import { makeInertSubRouter, makeTrpcProxy } from '../../../test/trpcProxyStub';

/**
 * RUN_CONFIRMED_STEP → CONFIRMED_STEP_RESULT on the PAGE host, through a REAL Modal.
 *
 * The behavioural pins for the confirmed pass-through step bridge, mirroring
 * `PageBlockHostRunTraining.browser.test.tsx`: the dialog shows the SERVER'S price
 * (never a number from the block), a dismissal replies `declined` with nothing
 * confirmed or submitted, a confirmation records consent through the session-only
 * procedure BEFORE the submit, and a job over the viewer's own daily limit is refused
 * with an explanation and a link to raise it — with no confirm to click.
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
  trpc: makeTrpcProxy(
    {
      'blocks.submitWorkflow': { useMutation: () => ({ mutateAsync: submitMutate }) },
      'apps.shared': makeInertSubRouter(),
      'apps.storage': makeInertSubRouter(),
    },
    {
      useUtils: () => ({
        client: {
          blocks: {
            previewStepQuote: { mutate: previewMutate },
            consentStepQuote: { mutate: consentMutate },
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
  blockId: 'mesh-app',
  appId: 'app_test',
  blockInstanceId: 'page_apb_test',
  appName: 'Mesh Maker',
  iframeSrc: SAME_ORIGIN_SRC,
  surface: 'page-run' as const,
  bootSkeleton: false,
  sandbox: 'allow-scripts',
  trustTier: 'internal' as const,
  slug: 'mesh-app',
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

async function reply(replies: ReturnType<typeof listenForReply>) {
  let payload: unknown;
  await vi.waitFor(() => {
    const r = replies.last('CONFIRMED_STEP_RESULT');
    if (!r) throw new Error('no reply yet');
    payload = r.payload;
  });
  return payload;
}

const QUOTE_ID = `sq_${'a'.repeat(32)}`;
// The block's own body. `displayPrice` is a block-chosen number the host must never
// render — the strict wire schema would also reject it at the server.
const BODY = {
  kind: 'step',
  $type: 'polyGen',
  input: { engine: 'meshy', prompt: 'a teapot' },
  maxBuzz: 200,
  quoteId: QUOTE_ID,
  displayPrice: 7,
};
const PREVIEW = {
  quoteId: QUOTE_ID,
  total: 1040,
  stepType: 'polyGen',
  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  shortfall: 0,
  dailyLimit: null,
  exceedsDailyLimit: false,
};
const SNAPSHOT = { workflowId: '42-1', status: 'pending' };
const CONFIRM = 'Run for 1,040 Buzz';

describe('PageBlockHost RUN_CONFIRMED_STEP (consent-gated over-budget step)', () => {
  beforeEach(() => {
    useDialogStore.getState().closeAll();
    previewMutate.mockReset();
    consentMutate.mockReset();
    submitMutate.mockReset();
    previewMutate.mockResolvedValue(PREVIEW);
    consentMutate.mockResolvedValue({ quoteId: QUOTE_ID, total: 1040, consented: true });
    submitMutate.mockResolvedValue({ snapshot: SNAPSHOT });
  });

  test('shows the SERVER’S price; confirm records consent and THEN submits', async () => {
    await mount();
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('RUN_CONFIRMED_STEP', { requestId: 'rq_1', body: BODY });

    const confirmBtn = page.getByRole('button', { name: CONFIRM });
    await expect.element(confirmBtn).toBeInTheDocument();
    await expect
      .element(page.getByTestId('block-confirmed-step-price'))
      .toHaveTextContent('This job costs 1,040 Buzz, charged when it starts.');
    expect(consentMutate).not.toHaveBeenCalled();
    expect(submitMutate).not.toHaveBeenCalled();
    expect(previewMutate).toHaveBeenCalledWith({ blockToken: 'tok_abc', quoteId: QUOTE_ID });

    await confirmBtn.click();

    expect(await reply(replies)).toEqual({ requestId: 'rq_1', snapshot: SNAPSHOT });
    expect(consentMutate).toHaveBeenCalledWith({ blockToken: 'tok_abc', quoteId: QUOTE_ID });
    expect(submitMutate).toHaveBeenCalledWith({ blockToken: 'tok_abc', body: BODY });
    expect(consentMutate.mock.invocationCallOrder[0]).toBeLessThan(
      submitMutate.mock.invocationCallOrder[0]
    );
    expect(replies.of('CONFIRMED_STEP_RESULT')).toHaveLength(1);
    replies.stop();
  });

  test('the block’s own number is never on the consent surface; the daily limit is shown', async () => {
    previewMutate.mockResolvedValue({
      ...PREVIEW,
      dailyLimit: { limit: 3000, spentToday: 500, remaining: 2500 },
    });
    await mount();
    await driveToReady();
    postFromBlock('RUN_CONFIRMED_STEP', {
      requestId: 'rq_2',
      body: { ...BODY, displayPrice: 999 },
    });
    await expect.element(page.getByTestId('block-confirmed-step-consent')).toBeInTheDocument();
    const text = page.getByTestId('block-confirmed-step-consent').element().textContent ?? '';
    expect(text).toContain('1,040');
    expect(text).not.toContain('999');
    await expect
      .element(page.getByTestId('block-confirmed-step-daily-limit'))
      .toHaveTextContent('Your daily limit for this app is 3,000 Buzz (2,500 left today).');
  });

  test('🔴 cancel replies `declined` and NOTHING is confirmed or submitted', async () => {
    await mount();
    await driveToReady();
    const replies = listenForReply();
    postFromBlock('RUN_CONFIRMED_STEP', { requestId: 'rq_3', body: BODY });
    await expect.element(page.getByRole('button', { name: CONFIRM })).toBeInTheDocument();
    await page.getByRole('button', { name: 'Cancel' }).click();
    expect(await reply(replies)).toEqual({ requestId: 'rq_3', error: 'declined' });
    expect(consentMutate).not.toHaveBeenCalled();
    expect(submitMutate).not.toHaveBeenCalled();
    replies.stop();
  });

  test('positive control: ESC before confirming also declines through the real Modal', async () => {
    await mount();
    await driveToReady();
    const replies = listenForReply();
    postFromBlock('RUN_CONFIRMED_STEP', { requestId: 'rq_4', body: BODY });
    await expect.element(page.getByRole('button', { name: CONFIRM })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(await reply(replies)).toEqual({ requestId: 'rq_4', error: 'declined' });
    expect(submitMutate).not.toHaveBeenCalled();
    replies.stop();
  });

  test('🔴 over the daily limit: explained, linked, refused — no confirm exists', async () => {
    previewMutate.mockResolvedValue({
      ...PREVIEW,
      dailyLimit: { limit: 1500, spentToday: 600, remaining: 900 },
      exceedsDailyLimit: true,
    });
    await mount();
    await driveToReady();
    const replies = listenForReply();
    postFromBlock('RUN_CONFIRMED_STEP', { requestId: 'rq_5', body: BODY });

    expect(await reply(replies)).toEqual({ requestId: 'rq_5', error: 'daily-limit-exceeded' });
    const refusal = page.getByTestId('block-confirmed-step-daily-limit-refusal');
    await expect.element(refusal).toBeInTheDocument();
    await expect
      .element(refusal)
      .toHaveTextContent(
        'This job costs 1,040 Buzz, which exceeds your daily limit of 1,500 Buzz for Mesh Maker (900 left today).'
      );
    const link = page.getByRole('link', { name: 'Change your daily limit' });
    await expect.element(link).toHaveAttribute('href', '/apps/activity');
    // There is nothing to click that would run the job.
    expect(page.getByRole('button', { name: CONFIRM }).elements()).toHaveLength(0);
    expect(consentMutate).not.toHaveBeenCalled();
    expect(submitMutate).not.toHaveBeenCalled();
    replies.stop();
  });

  test('a daily-limit refusal AT SUBMIT (the day moved) replies the same code', async () => {
    submitMutate.mockResolvedValueOnce({
      snapshot: {
        workflowId: 'failed',
        status: 'failed',
        error: 'this job costs 1040 Buzz, which exceeds …',
        errorCode: 'daily-limit-exceeded',
      },
    });
    await mount();
    await driveToReady();
    const replies = listenForReply();
    postFromBlock('RUN_CONFIRMED_STEP', { requestId: 'rq_6', body: BODY });
    await page.getByRole('button', { name: CONFIRM }).click();
    expect(await reply(replies)).toEqual({ requestId: 'rq_6', error: 'daily-limit-exceeded' });
    await expect
      .element(page.getByTestId('block-confirmed-step-daily-limit-refusal'))
      .toBeInTheDocument();
    replies.stop();
  });

  test('a block that is not ready is refused — no preview, no dialog', async () => {
    await mount();
    const replies = listenForReply();
    postFromBlock('RUN_CONFIRMED_STEP', { requestId: 'rq_7', body: BODY });
    expect(await reply(replies)).toEqual({ requestId: 'rq_7', error: 'block is not ready' });
    expect(previewMutate).not.toHaveBeenCalled();
    expect(useDialogStore.getState().dialogs).toHaveLength(0);
    replies.stop();
  });

  test('an anonymous viewer is refused — no preview, no dialog', async () => {
    await mount({ viewer: null });
    await driveToReady();
    const replies = listenForReply();
    postFromBlock('RUN_CONFIRMED_STEP', { requestId: 'rq_8', body: BODY });
    expect(await reply(replies)).toEqual({ requestId: 'rq_8', error: 'sign in to run' });
    expect(previewMutate).not.toHaveBeenCalled();
    replies.stop();
  });

  test('a body naming no quote is refused without a preview', async () => {
    await mount();
    await driveToReady();
    const replies = listenForReply();
    const { quoteId: _q, ...unquoted } = BODY;
    postFromBlock('RUN_CONFIRMED_STEP', { requestId: 'rq_9', body: unquoted });
    expect(await reply(replies)).toEqual({
      requestId: 'rq_9',
      error: 'invalid confirmed step request',
    });
    expect(previewMutate).not.toHaveBeenCalled();
    replies.stop();
  });

  test('a refused preview replies with the server error and opens nothing', async () => {
    previewMutate.mockRejectedValue(new Error('step quote not found or expired'));
    await mount();
    await driveToReady();
    const replies = listenForReply();
    postFromBlock('RUN_CONFIRMED_STEP', { requestId: 'rq_10', body: BODY });
    expect(await reply(replies)).toEqual({
      requestId: 'rq_10',
      error: 'step quote not found or expired',
    });
    expect(useDialogStore.getState().dialogs).toHaveLength(0);
    expect(submitMutate).not.toHaveBeenCalled();
    replies.stop();
  });

  test('a lost submit RESPONSE replies `submission-unconfirmed` and is never resent', async () => {
    submitMutate.mockRejectedValueOnce(new Error('Failed to fetch'));
    await mount();
    await driveToReady();
    const replies = listenForReply();
    postFromBlock('RUN_CONFIRMED_STEP', { requestId: 'rq_11', body: BODY });
    await page.getByRole('button', { name: CONFIRM }).click();
    expect(await reply(replies)).toEqual({ requestId: 'rq_11', error: 'submission-unconfirmed' });
    expect(submitMutate).toHaveBeenCalledTimes(1);
    expect(replies.of('CONFIRMED_STEP_RESULT')).toHaveLength(1);
    replies.stop();
  });
});
