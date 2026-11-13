import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { useDialogStore } from '~/components/Dialog/dialogStore';
import type { BlockPickedImageInfo } from '~/components/AppBlocks/imagePickerLogic';
import type * as TrpcMod from '~/utils/trpc';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { expectReplyKeys } from '../../../test/expectReplyKeys';
import { makeInertSubRouter, makeTrpcProxy } from '../../../test/trpcProxyStub';

/**
 * OPEN_IMAGE_PICKER → IMAGE_PICKER_RESULT on the page host.
 *
 * Mounts the real PageBlockHost and drives the postMessage bridge. The modal is a lazy import that
 * is not rendered here: each test reads what the host handed the dialog store and calls the
 * captured `onResolved` / `onClose` to play the viewer. The modal itself is covered in
 * BlockImagePickerModal.browser.test.tsx.
 */

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  setTrpcBatchingEnabled: vi.fn(),
  trpc: makeTrpcProxy({
    'apps.shared': makeInertSubRouter(),
    'apps.storage': makeInertSubRouter(),
  }),
}));

// eslint-disable-next-line import/first
import { PageBlockHost } from '~/components/AppBlocks/PageBlockHost';

function iframeWindow() {
  const el = page.getByTestId('app-page-iframe').element() as HTMLIFrameElement;
  if (!el.contentWindow) throw new Error('iframe contentWindow missing');
  return el.contentWindow;
}

function postFromBlock(type: string, payload?: unknown) {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { type, payload },
      origin: window.location.origin,
      source: iframeWindow(),
    })
  );
}

function listenForReply() {
  const received: Array<{ type: string; payload: unknown }> = [];
  const cw = iframeWindow();
  const handler = (e: MessageEvent) => {
    const d = e.data as { type?: string; payload?: unknown } | null;
    if (d && typeof d.type === 'string') received.push({ type: d.type, payload: d.payload });
  };
  cw.addEventListener('message', handler);
  return {
    results: () => received.filter((m) => m.type === 'IMAGE_PICKER_RESULT').map((m) => m.payload),
    stop: () => cw.removeEventListener('message', handler),
  };
}

type PickerProps = {
  sources: string[];
  max: number | null;
  publicOnly: boolean;
  onResolved: (picked: BlockPickedImageInfo[]) => void;
};

function lastDialog() {
  const dialogs = useDialogStore.getState().dialogs;
  if (dialogs.length === 0) throw new Error('no modal opened');
  return dialogs[dialogs.length - 1];
}
const pickerProps = () => lastDialog().props as PickerProps;

const baseProps = {
  appBlockId: 'apb_test',
  blockId: 'my-page-app',
  appId: 'app_test',
  blockInstanceId: 'page_apb_test',
  appName: 'Remix App',
  iframeSrc: `${window.location.origin}/`,
  surface: 'page-run' as const,
  bootSkeleton: false,
  sandbox: 'allow-scripts',
  trustTier: 'internal' as const,
  slug: 'my-page-app',
  token: 'tok_abc',
  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  declaredScopes: [] as string[],
  missingScopes: [] as string[],
  needsConsent: false,
  tokenError: false,
  viewer: { id: 42, username: 'tester' },
  theme: 'light' as const,
};

async function mount(over: { reviewMode?: boolean } = {}) {
  renderWithProviders(<PageBlockHost {...baseProps} {...over} />);
  await vi.waitFor(() => iframeWindow());
}

async function mountReady(over: { reviewMode?: boolean } = {}) {
  await mount(over);
  await vi.waitFor(() => {
    postFromBlock('BLOCK_READY', {});
    const el = page.getByTestId('app-page-iframe').element();
    if (el.getAttribute('data-block-ready') !== 'true') throw new Error('not ready yet');
  });
}

/** Post a request the host must accept, failing loudly if it opened nothing. */
function openPicker(requestId: string, payload: Record<string, unknown> = {}) {
  postFromBlock('OPEN_IMAGE_PICKER', { requestId, ...payload });
  if (useDialogStore.getState().dialogs.length !== 1) {
    throw new Error('OPEN_IMAGE_PICKER opened no modal');
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

const postedPick = (n: number): BlockPickedImageInfo => ({
  source: 'posted',
  url: `https://image.civitai.com/acct/key-${n}/width=1200/key-${n}.jpeg`,
  width: 1200,
  height: 700 + n,
  nsfwLevel: 8,
  imageId: 9000 + n,
});

const generatedPick: BlockPickedImageInfo = {
  source: 'generated',
  url: 'https://orchestration.civitai.com/v2/consumer/blobs/ABC123.jpeg?sig=x',
  width: 832,
  height: 1216,
  nsfwLevel: 2,
};

describe('PageBlockHost OPEN_IMAGE_PICKER', () => {
  beforeEach(() => {
    useDialogStore.getState().closeAll();
  });

  test('opens the picker over both sources as a single pick by default', async () => {
    await mountReady();

    openPicker('rq_open');

    expect(lastDialog().id).toBe('block-image-picker-rq_open');
    expect(pickerProps().sources).toEqual(['posted', 'generated']);
    expect(pickerProps().max).toBeNull();
    expect(pickerProps().publicOnly).toBe(false);
  });

  test('passes publicOnly to the picker only when the app asked for it', async () => {
    await mountReady();

    openPicker('rq_public', { sources: ['posted'], publicOnly: true });
    expect(pickerProps().publicOnly).toBe(true);

    useDialogStore.getState().closeAll();
    openPicker('rq_public_off', { sources: ['posted'], publicOnly: false });
    expect(pickerProps().publicOnly).toBe(false);
  });

  test('passes the requested sources and the clamped cap to the picker', async () => {
    await mountReady();

    openPicker('rq_args', { sources: ['generated'], multiple: { max: 99 } });

    expect(pickerProps().sources).toEqual(['generated']);
    expect(pickerProps().max).toBe(20);
  });

  test('single pick replies { requestId, selected }', async () => {
    await mountReady();
    const replies = listenForReply();

    openPicker('rq_single');
    pickerProps().onResolved([postedPick(1)]);
    lastDialog().options?.onClose?.();

    await vi.waitFor(() => expect(replies.results()).toHaveLength(1));
    expect(replies.results()[0]).toEqual({ requestId: 'rq_single', selected: postedPick(1) });
    expectReplyKeys('OPEN_IMAGE_PICKER', 'success', ['selected'], replies.results()[0]);
    // The pick is the only reply: closing after it does not add a dismissal.
    await settle();
    expect(replies.results()).toHaveLength(1);
    replies.stop();
  });

  test('a generated pick is replied without an imageId', async () => {
    await mountReady();
    const replies = listenForReply();

    openPicker('rq_gen', { sources: ['generated'] });
    pickerProps().onResolved([generatedPick]);
    lastDialog().options?.onClose?.();

    await vi.waitFor(() => expect(replies.results()).toHaveLength(1));
    expect(replies.results()[0]).toEqual({ requestId: 'rq_gen', selected: generatedPick });
    expect((replies.results()[0] as { selected: object }).selected).not.toHaveProperty('imageId');
    replies.stop();
  });

  test('single dismiss replies a bare { requestId }', async () => {
    await mountReady();
    const replies = listenForReply();

    openPicker('rq_dismiss');
    lastDialog().options?.onClose?.();

    await vi.waitFor(() => expect(replies.results()).toHaveLength(1));
    expect(replies.results()[0]).toEqual({ requestId: 'rq_dismiss' });
    expectReplyKeys('OPEN_IMAGE_PICKER', 'success', [], replies.results()[0]);
    replies.stop();
  });

  test('multi pick replies selectedImages in pick order, capped at max', async () => {
    await mountReady();
    const replies = listenForReply();

    openPicker('rq_multi', { multiple: { max: 2 } });
    expect(pickerProps().max).toBe(2);
    // One more than the cap, as a modal that failed to enforce it would hand back.
    pickerProps().onResolved([postedPick(3), generatedPick, postedPick(1)]);
    lastDialog().options?.onClose?.();

    await vi.waitFor(() => expect(replies.results()).toHaveLength(1));
    expect(replies.results()[0]).toEqual({
      requestId: 'rq_multi',
      selectedImages: [postedPick(3), generatedPick],
    });
    expect(replies.results()[0]).not.toHaveProperty('selected');
    expectReplyKeys('OPEN_IMAGE_PICKER', 'success', ['selectedImages'], replies.results()[0]);
    replies.stop();
  });

  test('multi dismiss replies an empty list', async () => {
    await mountReady();
    const replies = listenForReply();

    openPicker('rq_multi_dismiss', { multiple: { max: 4 } });
    lastDialog().options?.onClose?.();

    await vi.waitFor(() => expect(replies.results()).toHaveLength(1));
    expect(replies.results()[0]).toEqual({ requestId: 'rq_multi_dismiss', selectedImages: [] });
    replies.stop();
  });

  test.each([
    ['an empty sources list', { sources: [] }, /sources must be/],
    ['an unknown source', { sources: ['posted', 'liked'] }, /sources must be/],
    ['sources that is not a list', { sources: 'posted' }, /sources must be/],
    ['a zero max', { multiple: { max: 0 } }, /multiple\.max must be/],
    ['a fractional max', { multiple: { max: 1.5 } }, /multiple\.max must be/],
    ['a publicOnly that is not a boolean', { publicOnly: 'true' }, /publicOnly must be a boolean/],
  ])('%s is refused with an error and opens nothing', async (_name, payload, error) => {
    await mountReady();
    const replies = listenForReply();

    postFromBlock('OPEN_IMAGE_PICKER', { requestId: 'rq_refused', ...payload });

    await vi.waitFor(() => expect(replies.results()).toHaveLength(1));
    const reply = replies.results()[0] as { requestId: string; error: string };
    expect(Object.keys(reply).sort()).toEqual(['error', 'requestId']);
    expectReplyKeys('OPEN_IMAGE_PICKER', 'error', ['error'], reply);
    expect(reply.requestId).toBe('rq_refused');
    expect(reply.error).toMatch(error);
    expect(useDialogStore.getState().dialogs).toHaveLength(0);
    replies.stop();
  });

  test('review mode opens nothing and replies as a dismissal, in the shape asked for', async () => {
    await mountReady({ reviewMode: true });
    const replies = listenForReply();

    postFromBlock('OPEN_IMAGE_PICKER', { requestId: 'rq_review_one' });
    postFromBlock('OPEN_IMAGE_PICKER', { requestId: 'rq_review_many', multiple: { max: 3 } });

    await vi.waitFor(() => expect(replies.results()).toHaveLength(2));
    expect(replies.results()).toEqual([
      { requestId: 'rq_review_one' },
      { requestId: 'rq_review_many', selectedImages: [] },
    ]);
    expect(useDialogStore.getState().dialogs).toHaveLength(0);
    replies.stop();
  });

  test('a block that is not ready opens nothing and replies as a dismissal', async () => {
    await mount();
    const replies = listenForReply();

    postFromBlock('OPEN_IMAGE_PICKER', { requestId: 'rq_early_one' });
    postFromBlock('OPEN_IMAGE_PICKER', { requestId: 'rq_early_many', multiple: { max: 3 } });

    await vi.waitFor(() => expect(replies.results()).toHaveLength(2));
    expect(replies.results()).toEqual([
      { requestId: 'rq_early_one' },
      { requestId: 'rq_early_many', selectedImages: [] },
    ]);
    expect(useDialogStore.getState().dialogs).toHaveLength(0);
    replies.stop();
  });

  test('a request with no requestId is dropped: no modal, no reply', async () => {
    await mountReady();
    const replies = listenForReply();

    // Positive control: the listener is live and accepts a well-formed request, so the silence
    // asserted below is the missing requestId and not a host that never heard the message.
    openPicker('rq_control');
    useDialogStore.getState().closeAll();
    expect(replies.results()).toEqual([]);

    postFromBlock('OPEN_IMAGE_PICKER', { sources: ['posted'] });
    postFromBlock('OPEN_IMAGE_PICKER', { requestId: '' });

    await settle();
    expect(useDialogStore.getState().dialogs).toHaveLength(0);
    expect(replies.results()).toEqual([]);
    replies.stop();
  });
});
