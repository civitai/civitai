import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { DialogProvider } from '~/components/Dialog/DialogProvider';
import AlertDialog from '~/components/Dialog/Common/AlertDialog';
import { dialogStore, useDialogStore } from '~/components/Dialog/dialogStore';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { expectReplyKeys } from '../../../test/expectReplyKeys';
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
            previewQuoteGrant: { mutate: previewMutate },
            consentQuoteGrant: { mutate: consentMutate },
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
const confirmButton = () => page.getByRole('button', { name: CONFIRM });
// The confirm is disabled for ~1s after it appears; give the assertion room past it.
const ARMED = { timeout: 4000 };
/**
 * The confirm button's `disabled` state at the INSTANT it enters the DOM, captured by a
 * MutationObserver armed before the request is posted. Race-free: the initial state
 * clears on its own after the delay, so polling for it afterwards could miss it on a
 * slow machine; this records it in the same task the button is inserted.
 */
function captureConfirmAtInsert(name: string) {
  let disabledAtInsert: boolean | null = null;
  const find = () =>
    Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === name);
  const observer = new MutationObserver(() => {
    if (disabledAtInsert !== null) return;
    const button = find();
    if (button) disabledAtInsert = button.disabled;
  });
  observer.observe(document.body, { childList: true, subtree: true });
  return {
    read: () => disabledAtInsert,
    stop: () => observer.disconnect(),
  };
}

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

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
    expect(previewMutate).toHaveBeenCalledWith({
      kind: 'step',
      blockToken: 'tok_abc',
      quoteId: QUOTE_ID,
    });

    await expect.element(confirmBtn, ARMED).toBeEnabled();
    await confirmBtn.click();

    const succeeded = await reply(replies);
    expect(succeeded).toEqual({ requestId: 'rq_1', snapshot: SNAPSHOT });
    expectReplyKeys('RUN_CONFIRMED_STEP', 'success', ['snapshot'], succeeded);
    expect(consentMutate).toHaveBeenCalledWith({
      kind: 'step',
      blockToken: 'tok_abc',
      quoteId: QUOTE_ID,
    });
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
    const declined = await reply(replies);
    expect(declined).toEqual({ requestId: 'rq_3', error: 'declined' });
    expectReplyKeys('RUN_CONFIRMED_STEP', 'error', ['error'], declined);
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
    await expect.element(confirmButton(), ARMED).toBeEnabled();
    await confirmButton().click();
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

  test('a refused confirmation replies with the error and NEVER submits', async () => {
    consentMutate.mockRejectedValue(new Error('step quote not found or expired'));
    await mount();
    await driveToReady();
    const replies = listenForReply();
    postFromBlock('RUN_CONFIRMED_STEP', { requestId: 'rq_12', body: BODY });
    await expect.element(confirmButton(), ARMED).toBeEnabled();
    await confirmButton().click();
    expect(await reply(replies)).toEqual({
      requestId: 'rq_12',
      error: 'step quote not found or expired',
    });
    expect(submitMutate).not.toHaveBeenCalled();
    replies.stop();
  });

  test('a known shortfall is shown with a Get Buzz action; none without one', async () => {
    previewMutate.mockResolvedValue({ ...PREVIEW, shortfall: 140 });
    await mount();
    await driveToReady();
    postFromBlock('RUN_CONFIRMED_STEP', { requestId: 'rq_13', body: BODY });
    await expect
      .element(page.getByTestId('block-confirmed-step-shortfall'))
      .toHaveTextContent('You need 140 more Buzz to run this job.');
    await expect.element(page.getByRole('button', { name: 'Get Buzz' })).toBeInTheDocument();
    useDialogStore.getState().closeAll();

    previewMutate.mockResolvedValue({ ...PREVIEW, shortfall: 0 });
    postFromBlock('RUN_CONFIRMED_STEP', { requestId: 'rq_14', body: BODY });
    await expect.element(page.getByRole('button', { name: CONFIRM })).toBeInTheDocument();
    expect(page.getByTestId('block-confirmed-step-shortfall').elements()).toHaveLength(0);
  });

  // ── The confirm is not clickable the instant it appears ──────────────────────
  // A button that spends Buzz gives the viewer a moment to read the dialog first, and
  // again whenever they come back to the page.
  test('Confirm is disabled when the dialog appears, then enabled after the delay', async () => {
    await mount();
    await driveToReady();
    const atInsert = captureConfirmAtInsert(CONFIRM);
    postFromBlock('RUN_CONFIRMED_STEP', { requestId: 'rq_g1', body: BODY });
    await expect.element(confirmButton()).toBeInTheDocument();
    atInsert.stop();
    // Disabled in the very task it was inserted — not polled for afterwards.
    expect(atInsert.read()).toBe(true);
    // Cancel is never delayed.
    await expect.element(page.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    await expect.element(confirmButton(), ARMED).toBeEnabled();
    expect(consentMutate).not.toHaveBeenCalled();
    expect(submitMutate).not.toHaveBeenCalled();
  });

  test('Confirm is disabled again when the window loses focus, and re-arms on return', async () => {
    await mount();
    await driveToReady();
    postFromBlock('RUN_CONFIRMED_STEP', { requestId: 'rq_g2', body: BODY });
    await expect.element(confirmButton(), ARMED).toBeEnabled();

    window.dispatchEvent(new Event('blur'));
    await expect.element(confirmButton()).toBeDisabled();
    // Still disabled while away, however long that is.
    await new Promise((r) => setTimeout(r, 1300));
    expect((confirmButton().element() as HTMLButtonElement).disabled).toBe(true);

    window.dispatchEvent(new Event('focus'));
    // Not instantly: the delay starts over.
    expect((confirmButton().element() as HTMLButtonElement).disabled).toBe(true);
    await expect.element(confirmButton(), ARMED).toBeEnabled();
  });

  test('Confirm is disabled again when the tab is hidden, and re-arms when it is visible', async () => {
    await mount();
    await driveToReady();
    postFromBlock('RUN_CONFIRMED_STEP', { requestId: 'rq_g3', body: BODY });
    await expect.element(confirmButton(), ARMED).toBeEnabled();
    try {
      setVisibility('hidden');
      await expect.element(confirmButton()).toBeDisabled();
      setVisibility('visible');
      expect((confirmButton().element() as HTMLButtonElement).disabled).toBe(true);
      await expect.element(confirmButton(), ARMED).toBeEnabled();
    } finally {
      // Hand the real getter back to the document.
      delete (document as unknown as Record<string, unknown>).visibilityState;
    }
  });

  test('two confirms open at once: the one underneath is not armed while covered, and waits the full delay once uncovered', async () => {
    await mount();
    await driveToReady();
    postFromBlock('RUN_CONFIRMED_STEP', { requestId: 'rq_s1', body: BODY });
    await expect.element(confirmButton().first()).toBeInTheDocument();
    postFromBlock('RUN_CONFIRMED_STEP', { requestId: 'rq_s2', body: BODY });
    await vi.waitFor(() => expect(confirmButton().elements()).toHaveLength(2));
    const [under, top] = confirmButton().elements() as HTMLButtonElement[];

    // The one in front arms after its delay; the one underneath never does, however
    // long it stays covered (well past the delay).
    await vi.waitFor(() => expect(top.disabled).toBe(false), ARMED);
    await new Promise((r) => setTimeout(r, 1500));
    expect(under.disabled).toBe(true);

    // Record when the lower dialog is uncovered and when its button becomes enabled.
    let enabledAt: number | null = null;
    const observer = new MutationObserver(() => {
      if (enabledAt === null && !under.disabled) enabledAt = performance.now();
    });
    observer.observe(under, { attributes: true, attributeFilter: ['disabled', 'data-disabled'] });
    useDialogStore.getState().closeLatest();
    const uncoveredAt = performance.now();
    try {
      await vi.waitFor(() => expect(enabledAt).not.toBeNull(), ARMED);
    } finally {
      observer.disconnect();
    }
    // It waited (at least) the whole delay from the moment it was uncovered. A slow
    // machine only makes this larger; 50 ms covers timer rounding.
    expect((enabledAt as unknown as number) - uncoveredAt).toBeGreaterThanOrEqual(950);
    expect(consentMutate).not.toHaveBeenCalled();
  });

  // ── "In front" means the LAST dialog in the stack, not a dialog count ───────
  const openFiller = (id: string) =>
    dialogStore.trigger({
      id,
      component: AlertDialog,
      props: { type: 'info', title: `Filler ${id}`, children: `filler ${id}` },
    });
  /** When `button` next becomes enabled, measured from `since`. */
  async function enabledAfter(button: HTMLButtonElement, since: number) {
    let at: number | null = button.disabled ? null : performance.now();
    const observer = new MutationObserver(() => {
      if (at === null && !button.disabled) at = performance.now();
    });
    observer.observe(button, { attributes: true, attributeFilter: ['disabled', 'data-disabled'] });
    try {
      await vi.waitFor(() => expect(at).not.toBeNull(), ARMED);
    } finally {
      observer.disconnect();
    }
    return (at as unknown as number) - since;
  }

  test('a dialog-store modal carries no stray dialog-id attribute', async () => {
    await mount();
    openFiller('plain');
    await expect.element(page.getByText('filler plain').first()).toBeInTheDocument();
    // Dialogs spread their dialog context into Mantine's Modal, which forwards unknown
    // props to the DOM; the dialog's store id must not be in that context.
    expect(document.querySelectorAll('[dialogid], [dialogId]')).toHaveLength(0);
    // Positive control: the selector does find an attribute when one is there.
    document.body.setAttribute('dialogid', 'probe');
    expect(document.querySelectorAll('[dialogid]')).toHaveLength(1);
    document.body.removeAttribute('dialogid');
  });

  test('a dialog UNDERNEATH closing does not stop the confirm in front from arming', async () => {
    await mount();
    await driveToReady();
    openFiller('under-1');
    postFromBlock('RUN_CONFIRMED_STEP', { requestId: 'rq_t1', body: BODY });
    await expect.element(confirmButton()).toBeInTheDocument();
    // The dialog below goes away while the confirm is still counting down.
    useDialogStore.getState().closeById('under-1');
    await expect.element(confirmButton(), ARMED).toBeEnabled();
    // …and it stays armed: nothing about being in front changed.
    await new Promise((r) => setTimeout(r, 300));
    expect((confirmButton().element() as HTMLButtonElement).disabled).toBe(false);
  });

  test('a confirm in the MIDDLE of three stays disabled, even when the one below it closes', async () => {
    await mount();
    await driveToReady();
    openFiller('under-2');
    postFromBlock('RUN_CONFIRMED_STEP', { requestId: 'rq_t2', body: BODY });
    await expect.element(confirmButton()).toBeInTheDocument();
    openFiller('over-2');
    await vi.waitFor(() => expect(useDialogStore.getState().dialogs).toHaveLength(3));
    const button = confirmButton().element() as HTMLButtonElement;

    // Covered: well past the delay, still disabled.
    await new Promise((r) => setTimeout(r, 1500));
    expect(button.disabled).toBe(true);

    // The dialog BELOW closes. The stack is back to the size it had when the confirm
    // opened, but the confirm is still covered — it must not arm.
    useDialogStore.getState().closeById('under-2');
    await vi.waitFor(() => expect(useDialogStore.getState().dialogs).toHaveLength(2));
    await new Promise((r) => setTimeout(r, 1500));
    expect(button.disabled).toBe(true);

    // The dialog ABOVE closes: now it is in front, and waits the whole delay.
    useDialogStore.getState().closeById('over-2');
    const waited = await enabledAfter(button, performance.now());
    expect(waited).toBeGreaterThanOrEqual(950);
    expect(consentMutate).not.toHaveBeenCalled();
  });

  test('a lost submit RESPONSE replies `submission-unconfirmed` and is never resent', async () => {
    submitMutate.mockRejectedValueOnce(new Error('Failed to fetch'));
    await mount();
    await driveToReady();
    const replies = listenForReply();
    postFromBlock('RUN_CONFIRMED_STEP', { requestId: 'rq_11', body: BODY });
    await expect.element(confirmButton(), ARMED).toBeEnabled();
    await confirmButton().click();
    expect(await reply(replies)).toEqual({ requestId: 'rq_11', error: 'submission-unconfirmed' });
    expect(submitMutate).toHaveBeenCalledTimes(1);
    expect(replies.of('CONFIRMED_STEP_RESULT')).toHaveLength(1);
    // The VIEWER is told in host chrome, not only the block: a retry is a new job.
    await expect
      .element(page.getByTestId('block-confirmed-step-notice'))
      .toHaveTextContent(
        'The job may already be running, and you may have been charged for it. Check your generations before trying again — confirming again starts a new job.'
      );
    replies.stop();
  });

  test('a submit the SERVER could not confirm also shows the host notice', async () => {
    submitMutate.mockResolvedValueOnce({
      snapshot: { workflowId: 'failed', status: 'failed', error: 'could not be confirmed' },
      submissionUnconfirmed: true,
    });
    await mount();
    await driveToReady();
    const replies = listenForReply();
    postFromBlock('RUN_CONFIRMED_STEP', { requestId: 'rq_15', body: BODY });
    await expect.element(confirmButton(), ARMED).toBeEnabled();
    await confirmButton().click();
    expect(await reply(replies)).toEqual({ requestId: 'rq_15', error: 'submission-unconfirmed' });
    await expect.element(page.getByTestId('block-confirmed-step-notice')).toBeInTheDocument();
    replies.stop();
  });

  test('control: an ordinary success shows no notice', async () => {
    await mount();
    await driveToReady();
    const replies = listenForReply();
    postFromBlock('RUN_CONFIRMED_STEP', { requestId: 'rq_16', body: BODY });
    await expect.element(confirmButton(), ARMED).toBeEnabled();
    await confirmButton().click();
    expect(await reply(replies)).toEqual({ requestId: 'rq_16', snapshot: SNAPSHOT });
    // Wait for the dialog stack to SETTLE EMPTY — the confirm closes after the reply,
    // and a notice (which would open after the reply too) would keep it non-empty. An
    // immediate absence check would run before either could happen.
    await vi.waitFor(() => expect(useDialogStore.getState().dialogs).toHaveLength(0));
    expect(page.getByTestId('block-confirmed-step-notice').elements()).toHaveLength(0);
    replies.stop();
  });

  test('🔴 a TRAINING quote id is refused by this dialog — no preview, nothing confirmed', async () => {
    await mount();
    await driveToReady();
    const replies = listenForReply();
    postFromBlock('RUN_CONFIRMED_STEP', {
      requestId: 'rq_17',
      body: { ...BODY, quoteId: `tq_${'a'.repeat(32)}` },
    });
    expect(await reply(replies)).toEqual({
      requestId: 'rq_17',
      error: 'invalid confirmed step request',
    });
    expect(previewMutate).not.toHaveBeenCalled();
    expect(consentMutate).not.toHaveBeenCalled();
    replies.stop();
  });
});
