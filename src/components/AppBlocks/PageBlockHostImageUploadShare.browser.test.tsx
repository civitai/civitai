import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { useDialogStore } from '~/components/Dialog/dialogStore';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { expectReplyKeys } from '../../../test/expectReplyKeys';
import type * as TrpcMod from '~/utils/trpc';
import { makeInertSubRouter, makeTrpcProxy } from '../../../test/trpcProxyStub';

/**
 * PageBlockHost `OPEN_IMAGE_UPLOAD` — `share` is an opt-in PER UPLOAD. Only `share: true`, read
 * strictly off the raw payload, hands the moderated upload modal the block token and the app name
 * (for the "visible to other viewers" notice and the server-side stamp). Anything else opens the
 * same modal with no share: a private upload, as before. A share request with no block token is
 * refused rather than stored private. The modal itself is not rendered here (the dialog store holds
 * it); its notice and persist are covered in BlockImageUploadModal.browser.test.tsx.
 */

const h = vi.hoisted(() => ({
  // The scan gate the host-mounted poller calls after an async accept: never settles, so the
  // poller stays pending and the test measures only the early reply.
  gate: vi.fn(() => new Promise(() => undefined)),
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  setTrpcBatchingEnabled: vi.fn(),
  trpc: makeTrpcProxy({
    'blockImageUpload.gate': { useMutation: () => ({ mutateAsync: h.gate }) },
    'apps.shared': makeInertSubRouter(),
    'apps.storage': makeInertSubRouter(),
  }),
}));

// eslint-disable-next-line import/first
import { PageBlockHost } from '~/components/AppBlocks/PageBlockHost';

const SAME_ORIGIN_SRC = `${window.location.origin}/`;
const baseProps = {
  appBlockId: 'apb_test',
  blockId: 'commons',
  appId: 'app_test',
  blockInstanceId: 'page_apb_test',
  appName: 'Gen App',
  iframeSrc: SAME_ORIGIN_SRC,
  surface: 'page-run' as const,
  bootSkeleton: false,
  sandbox: 'allow-scripts',
  trustTier: 'internal' as const,
  slug: 'commons',
  token: 'tok_abc' as string | null,
  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  declaredScopes: [] as string[],
  missingScopes: [] as string[],
  needsConsent: false,
  tokenError: false,
  viewer: { id: 42, username: 'tester' },
  theme: 'light' as const,
};

function iframe() {
  return page.getByTestId('app-page-iframe').element() as HTMLIFrameElement;
}

function postFromBlock(type: string, payload?: unknown) {
  const cw = iframe().contentWindow;
  if (!cw) throw new Error('iframe contentWindow missing');
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { type, payload },
      origin: window.location.origin,
      source: cw,
    })
  );
}

function listenForReplies() {
  const received: unknown[] = [];
  const cw = iframe().contentWindow;
  if (!cw) throw new Error('iframe contentWindow missing');
  const handler = (e: MessageEvent) => {
    const d = e.data as { type?: string; payload?: unknown } | null;
    if (d?.type === 'IMAGE_UPLOAD_RESULT') received.push(d.payload);
  };
  cw.addEventListener('message', handler);
  return { received, stop: () => cw.removeEventListener('message', handler) };
}

async function driveToReady() {
  await vi.waitFor(() => {
    if (!iframe().contentWindow) throw new Error('not mounted yet');
  });
  await vi.waitFor(() => {
    postFromBlock('BLOCK_READY', {});
    if (iframe().getAttribute('data-block-ready') !== 'true') throw new Error('not ready yet');
  });
}

/** The one dialog the request opened, by id, with its props. */
function openedUpload(requestId: string) {
  const dialogs = useDialogStore.getState().dialogs;
  expect(dialogs.map((d) => d.id)).toEqual([`block-image-upload-${requestId}`]);
  return dialogs[0].props as { share?: unknown };
}

type UploadDialogProps = {
  onResolved: (r: unknown, meta?: { shared: boolean }) => void;
  onAccepted?: (h: { imageId: number; url: string; shared?: boolean }) => void;
};
const dialogProps = () => useDialogStore.getState().dialogs[0].props as UploadDialogProps;
const closeDialog = () => useDialogStore.getState().dialogs[0].options?.onClose?.();

/** Distinct from every other number in this file. */
const MODERATED = {
  imageId: 9_401,
  nsfwLevel: 1,
  contentRating: 'pg',
  url: 'https://image.civitai.com/xG/9401/width=1200/a.jpeg',
};
const PENDING = { imageId: 9_402, url: 'https://image.civitai.com/xG/9402/width=1200/b.jpeg' };

describe('PageBlockHost OPEN_IMAGE_UPLOAD — share is opt-in per upload', () => {
  beforeEach(() => {
    useDialogStore.getState().closeAll();
  });

  test.each([
    ['blocking display', {}],
    ['async display', { asyncScan: true }],
  ])(
    '🔴 share: true (%s) hands the modal the token and the app name for its notice',
    async (_label, extra) => {
      renderWithProviders(<PageBlockHost {...baseProps} />);
      await driveToReady();
      postFromBlock('OPEN_IMAGE_UPLOAD', { requestId: 'rq_share', share: true, ...extra });
      expect(openedUpload('rq_share').share).toEqual({
        blockToken: 'tok_abc',
        appName: 'Gen App',
      });
    }
  );

  test.each([
    ['absent', {}],
    ['false', { share: false }],
    ['the string "true"', { share: 'true' }],
    ['1', { share: 1 }],
    ['an object', { share: { on: true } }],
  ])('🔴 share %s is a private upload: the modal gets no share', async (_label, extra) => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    postFromBlock('OPEN_IMAGE_UPLOAD', { requestId: 'rq_private', ...extra });
    // The modal opened (positive control) and carries no share.
    expect(openedUpload('rq_private')).not.toHaveProperty('share', expect.anything());
  });

  test('a blank app name falls back to "this app" in the notice', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} appName="   " />);
    await driveToReady();
    postFromBlock('OPEN_IMAGE_UPLOAD', { requestId: 'rq_blank', share: true });
    expect(openedUpload('rq_blank').share).toEqual({
      blockToken: 'tok_abc',
      appName: 'this app',
    });
  });

  test('🔴 share: true with no block token is refused: no modal, an error reply', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} token={null} />);
    await driveToReady();
    const replies = listenForReplies();
    postFromBlock('OPEN_IMAGE_UPLOAD', { requestId: 'rq_notok', share: true });
    await vi.waitFor(() =>
      expect(replies.received).toEqual([
        { requestId: 'rq_notok', error: 'no block token', shared: false },
      ])
    );
    expect(useDialogStore.getState().dialogs).toEqual([]);
    replies.stop();
  });

  describe('the `shared` echo on IMAGE_UPLOAD_RESULT', () => {
    async function ready(props: Partial<typeof baseProps> = {}) {
      renderWithProviders(<PageBlockHost {...baseProps} {...props} />);
      await driveToReady();
      return listenForReplies();
    }

    test.each([
      ['the server stamped the share', true],
      ['the server did not stamp it', false],
    ])('🔴 blocking share request: `shared` echoes the server (%s)', async (_label, shared) => {
      const replies = await ready();
      postFromBlock('OPEN_IMAGE_UPLOAD', { requestId: 'rq_b', share: true });
      dialogProps().onResolved(MODERATED, { shared });
      closeDialog();
      await vi.waitFor(() =>
        expect(replies.received).toEqual([{ requestId: 'rq_b', selected: MODERATED, shared }])
      );
      expectReplyKeys('OPEN_IMAGE_UPLOAD', 'success', ['selected', 'shared'], replies.received[0]);
      replies.stop();
    });

    test('🔴 async share request: the early pending reply carries the persist-time `shared`', async () => {
      const replies = await ready();
      postFromBlock('OPEN_IMAGE_UPLOAD', { requestId: 'rq_a', share: true, asyncScan: true });
      dialogProps().onAccepted?.({ ...PENDING, shared: true });
      closeDialog();
      await vi.waitFor(() =>
        expect(replies.received).toEqual([
          { requestId: 'rq_a', selected: { status: 'pending', ...PENDING }, shared: true },
        ])
      );
      // The poller for the accepted image is running against the stubbed gate.
      await vi.waitFor(() => expect(h.gate).toHaveBeenCalledWith({ imageId: PENDING.imageId }));
      replies.stop();
    });

    test('a cancelled share request replies `shared: false`', async () => {
      const replies = await ready();
      postFromBlock('OPEN_IMAGE_UPLOAD', { requestId: 'rq_c', share: true });
      closeDialog();
      await vi.waitFor(() =>
        expect(replies.received).toEqual([{ requestId: 'rq_c', shared: false }])
      );
      replies.stop();
    });

    test('🔴 a reply to an UNSHARED request omits `shared` (wire unchanged), whatever the modal reports', async () => {
      const replies = await ready();
      postFromBlock('OPEN_IMAGE_UPLOAD', { requestId: 'rq_u' });
      // Even a (wrong) `true` from the modal cannot put `shared` on an unshared reply.
      dialogProps().onResolved(MODERATED, { shared: true });
      closeDialog();
      await vi.waitFor(() =>
        expect(replies.received).toEqual([{ requestId: 'rq_u', selected: MODERATED }])
      );
      replies.stop();
    });

    test('the no-token refusal of a share request carries `shared: false`', async () => {
      const replies = await ready({ token: null });
      postFromBlock('OPEN_IMAGE_UPLOAD', { requestId: 'rq_n', share: true });
      await vi.waitFor(() =>
        expect(replies.received).toEqual([
          { requestId: 'rq_n', error: 'no block token', shared: false },
        ])
      );
      expectReplyKeys('OPEN_IMAGE_UPLOAD', 'error', ['error', 'shared'], replies.received[0]);
      replies.stop();
    });
  });
});
