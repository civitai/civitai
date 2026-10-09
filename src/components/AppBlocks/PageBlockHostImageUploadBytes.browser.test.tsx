import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { useDialogStore } from '~/components/Dialog/dialogStore';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';
import type * as CfUploadMod from '~/hooks/useCFImageUpload';
import { makeInertSubRouter, makeTrpcProxy } from '../../../test/trpcProxyStub';
import { UPLOAD_BYTES_MAX_PER_WINDOW } from '~/components/AppBlocks/imageUploadBytes';

/**
 * `OPEN_IMAGE_UPLOAD { bytes }` on the REAL PageBlockHost: an image the block made in its tab is
 * authorized, uploaded with NO picker through the same store upload a picked image uses,
 * persisted by `blocks.persistAppUploadImage`, and gated by the same scan poll — replying exactly
 * once, with the moderated shape a picked `display` upload returns or `{ requestId, error }`.
 *
 * The store upload (`useCFImageUpload`) and the four server calls are the only stubs; the request
 * parse, limits, uploader, poller and reply mapping all run for real.
 */

const h = vi.hoisted(() => ({
  uploadToCF: vi.fn(),
  authorize: vi.fn(),
  persist: vi.fn(),
  gate: vi.fn(),
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

vi.mock('~/hooks/useCFImageUpload', async (importOriginal) => ({
  ...(await importOriginal<typeof CfUploadMod>()),
  useCFImageUpload: () => ({
    uploadToCF: h.uploadToCF,
    files: [],
    removeImage: vi.fn(),
    resetFiles: vi.fn(),
  }),
}));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  setTrpcBatchingEnabled: vi.fn(),
  trpc: makeTrpcProxy({
    'blocks.authorizeAppUploadImage': { useMutation: () => ({ mutateAsync: h.authorize }) },
    'blocks.persistAppUploadImage': { useMutation: () => ({ mutateAsync: h.persist }) },
    'blockImageUpload.gate': { useMutation: () => ({ mutateAsync: h.gate }) },
    'apps.shared': makeInertSubRouter(),
    'apps.storage': makeInertSubRouter(),
  }),
}));

// eslint-disable-next-line import/first
import { PageBlockHost } from '~/components/AppBlocks/PageBlockHost';

const KEY = '33333333-3333-4333-8333-333333333333';
const OBJECT_URL = 'blob:host/preview-of-upload';
/** Distinct from every other number in this file, so a mixed-up id cannot pass. */
const PERSISTED_ID = 78;
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48];
const GIF = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00];
const pngBytes = () => new Uint8Array(PNG).buffer;

const SELECTED = {
  imageId: PERSISTED_ID,
  nsfwLevel: 1,
  contentRating: 'pg',
  url: 'https://image.civitai.com/xG/78/width=1200/original.jpeg',
};
const READY = { status: 'ready' as const, ...SELECTED };

const SAME_ORIGIN_SRC = `${window.location.origin}/`;
const baseProps = {
  appBlockId: 'apb_test',
  blockId: 'meta-fixer',
  appId: 'app_test',
  blockInstanceId: 'page_apb_test',
  appName: 'Meta Fixer',
  iframeSrc: SAME_ORIGIN_SRC,
  surface: 'page-run' as const,
  bootSkeleton: false,
  sandbox: 'allow-scripts',
  trustTier: 'internal' as const,
  slug: 'meta-fixer',
  token: 'tok_abc' as string | null,
  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  declaredScopes: ['posts:write:self'],
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

function listenForReply() {
  const received: Array<{ type: string; payload: unknown }> = [];
  const cw = iframe().contentWindow;
  if (!cw) throw new Error('iframe contentWindow missing');
  const handler = (e: MessageEvent) => {
    const d = e.data as { type?: string; payload?: unknown } | null;
    if (d && typeof d.type === 'string') received.push({ type: d.type, payload: d.payload });
  };
  cw.addEventListener('message', handler);
  return {
    of: (type: string) => received.filter((m) => m.type === type).map((m) => m.payload),
    stop: () => cw.removeEventListener('message', handler),
  };
}

/** EVERY IMAGE_UPLOAD_RESULT for one requestId — a list, so a second reply cannot hide. */
function repliesFor(replies: ReturnType<typeof listenForReply>, requestId: string) {
  return replies
    .of('IMAGE_UPLOAD_RESULT')
    .filter((p) => (p as { requestId: string }).requestId === requestId);
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

/** Lets any reply that WOULD follow a settled request arrive before asserting there is none. */
const settle = () => new Promise((r) => setTimeout(r, 150));

beforeEach(() => {
  useDialogStore.getState().closeAll();
  h.uploadToCF
    .mockReset()
    .mockResolvedValue({ id: KEY, url: 'u', objectUrl: OBJECT_URL, type: 'image' });
  h.authorize.mockReset().mockResolvedValue({ ok: true });
  h.persist.mockReset().mockResolvedValue({ imageId: PERSISTED_ID });
  h.gate.mockReset().mockResolvedValue(READY);
});

describe('PageBlockHost OPEN_IMAGE_UPLOAD { bytes }', () => {
  test('CROSS-FRAME: an ArrayBuffer from the opaque sandbox is uploaded with no picker and replies the moderated image once; a Uint8Array is refused', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    renderWithProviders(<PageBlockHost {...baseProps} trustTier="unverified" />);
    await vi.waitFor(() => {
      if (!iframe().contentWindow) throw new Error('not mounted yet');
    });
    const el = iframe();
    expect(el.getAttribute('sandbox')?.split(' ')).not.toContain('allow-same-origin');
    const cw = el.contentWindow;

    const echoes: Array<{ origin: string; data: { type?: string; payload?: unknown } }> = [];
    const onEcho = (e: MessageEvent) => {
      const d = e.data as { __xfEcho?: { type?: string; payload?: unknown } } | null;
      if (e.source === cw && d && d.__xfEcho) echoes.push({ origin: e.origin, data: d.__xfEcho });
    };
    window.addEventListener('message', onEcho);
    try {
      // The `blockToken` in the first payload is a decoy: the host must use its own.
      el.srcdoc =
        `<script>
        var sent = false;
        function go() {
          if (sent) return;
          sent = true;
          var png = new Uint8Array([${PNG.join(',')}]);
          parent.postMessage({ type: 'OPEN_IMAGE_UPLOAD', payload: { requestId: 'rq_xf_ab', bytes: png.buffer.slice(0), filename: 'fixed meta.png', blockToken: 'tok_evil' } }, '*');
          parent.postMessage({ type: 'OPEN_IMAGE_UPLOAD', payload: { requestId: 'rq_xf_u8', bytes: new Uint8Array(png) } }, '*');
        }
        window.addEventListener('message', function (e) {
          if (e.source !== parent) return;
          parent.postMessage({ __xfEcho: e.data }, '*');
          if (e.data && e.data.type === 'BLOCK_INIT') go();
        });
        parent.postMessage({ type: 'BLOCK_READY', payload: {} }, '*');
        setTimeout(go, 300);
      </` + `script>`;

      const uploadReplies = () =>
        echoes.filter((m) => m.data.type === 'IMAGE_UPLOAD_RESULT').map((m) => m.data.payload);
      await vi.waitFor(() => expect(uploadReplies()).toHaveLength(2));
      await settle();
      expect(uploadReplies()).toEqual(
        expect.arrayContaining([
          { requestId: 'rq_xf_ab', selected: SELECTED },
          { requestId: 'rq_xf_u8', error: 'invalid image-upload request' },
        ])
      );
      expect(uploadReplies()).toHaveLength(2);
      expect(echoes.filter((m) => m.data.type === 'IMAGE_SCAN_RESOLVED')).toEqual([]);
      // Positive control that the messages really crossed realms: an opaque sandbox posts as 'null'.
      expect(new Set(echoes.map((m) => m.origin))).toEqual(new Set(['null']));
    } finally {
      window.removeEventListener('message', onEcho);
    }

    expect(useDialogStore.getState().dialogs).toHaveLength(0);
    // Authorized with the HOST's token before anything was uploaded.
    expect(h.authorize).toHaveBeenCalledWith({ blockToken: 'tok_abc' });
    expect(h.authorize.mock.invocationCallOrder[0]).toBeLessThan(
      h.uploadToCF.mock.invocationCallOrder[0]
    );
    // The bytes reached the store upload unchanged, typed from their content.
    expect(h.uploadToCF).toHaveBeenCalledTimes(1);
    const file = h.uploadToCF.mock.calls[0][0] as File;
    expect([file.name, file.type]).toEqual(['fixed meta.png', 'image/png']);
    expect(Array.from(new Uint8Array(await file.arrayBuffer()))).toEqual(PNG);
    expect(h.persist).toHaveBeenCalledWith({
      blockToken: 'tok_abc',
      url: KEY,
      name: 'fixed meta.png',
    });
    // Gated on the PERSISTED id.
    expect(h.gate).toHaveBeenCalledWith({ imageId: PERSISTED_ID });
    // The upload hook's preview object URL is released rather than pinning the file in memory.
    expect(revoke).toHaveBeenCalledWith(OBJECT_URL);
    revoke.mockRestore();
  });

  test('asyncScan is ignored: one moderated reply, no pending handle, no push', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();
    postFromBlock('OPEN_IMAGE_UPLOAD', {
      requestId: 'rq_async',
      bytes: pngBytes(),
      asyncScan: true,
    });

    await vi.waitFor(() => expect(repliesFor(replies, 'rq_async')).toHaveLength(1));
    await settle();
    expect(repliesFor(replies, 'rq_async')).toEqual([
      { requestId: 'rq_async', selected: SELECTED },
    ]);
    expect(replies.of('IMAGE_SCAN_RESOLVED')).toEqual([]);
    replies.stop();
  });

  test('a refused authorization uploads NOTHING to the store', async () => {
    h.authorize.mockRejectedValueOnce(new Error('block lacks posts:write:self scope'));
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();
    postFromBlock('OPEN_IMAGE_UPLOAD', { requestId: 'rq_scope', bytes: pngBytes() });
    await vi.waitFor(() =>
      expect(repliesFor(replies, 'rq_scope')).toEqual([
        { requestId: 'rq_scope', error: 'block lacks posts:write:self scope' },
      ])
    );
    expect(h.uploadToCF).not.toHaveBeenCalled();
    expect(h.persist).not.toHaveBeenCalled();
    replies.stop();
  });

  test('every refusal and failure replies `{ requestId, error }` exactly once — never the bare cancelled shape', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('OPEN_IMAGE_UPLOAD', { requestId: 'rq_gif', bytes: new Uint8Array(GIF).buffer });
    postFromBlock('OPEN_IMAGE_UPLOAD', {
      requestId: 'rq_src',
      bytes: pngBytes(),
      purpose: 'generationSource',
    });
    h.persist.mockRejectedValueOnce(new Error('posting from apps is not enabled'));
    postFromBlock('OPEN_IMAGE_UPLOAD', { requestId: 'rq_persist', bytes: pngBytes() });

    await vi.waitFor(() => {
      expect(repliesFor(replies, 'rq_gif')).toHaveLength(1);
      expect(repliesFor(replies, 'rq_src')).toHaveLength(1);
      expect(repliesFor(replies, 'rq_persist')).toHaveLength(1);
    });

    // The scan refusing the image (a thrown BAD_REQUEST from the gate).
    h.gate.mockRejectedValueOnce(
      Object.assign(new Error('that image was flagged during review — choose a different image'), {
        data: { code: 'BAD_REQUEST' },
      })
    );
    postFromBlock('OPEN_IMAGE_UPLOAD', { requestId: 'rq_flag', bytes: pngBytes() });
    await vi.waitFor(() => expect(repliesFor(replies, 'rq_flag')).toHaveLength(1));
    await settle();

    expect(
      ['rq_gif', 'rq_src', 'rq_persist', 'rq_flag'].map((id) => repliesFor(replies, id))
    ).toEqual([
      [{ requestId: 'rq_gif', error: 'file type is not allowed' }],
      [{ requestId: 'rq_src', error: 'invalid image-upload request' }],
      [{ requestId: 'rq_persist', error: 'posting from apps is not enabled' }],
      [
        {
          requestId: 'rq_flag',
          error: 'that image was flagged during review — choose a different image',
        },
      ],
    ]);
    expect(replies.of('IMAGE_SCAN_RESOLVED')).toEqual([]);
    expect(useDialogStore.getState().dialogs).toHaveLength(0);
    replies.stop();
  });

  test('a requestId reused while its upload is in flight is refused, and does not spend the window', async () => {
    // The bridge itself drops a repeated requestId for 5 s (usePostMessage's replay dedup), so the
    // reuse that reaches the host is a later one: move the clock past that, inside the 60 s window.
    let offset = 0;
    const realNow = Date.now.bind(Date);
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
    try {
      h.gate.mockResolvedValue({ status: 'pending' });
      renderWithProviders(<PageBlockHost {...baseProps} />);
      await driveToReady();
      const replies = listenForReply();
      postFromBlock('OPEN_IMAGE_UPLOAD', { requestId: 'rq_dup', bytes: pngBytes() });
      await vi.waitFor(() => expect(h.uploadToCF).toHaveBeenCalledTimes(1));
      offset = 6_000;
      postFromBlock('OPEN_IMAGE_UPLOAD', { requestId: 'rq_dup', bytes: pngBytes() });
      await vi.waitFor(() =>
        expect(repliesFor(replies, 'rq_dup')).toEqual([
          { requestId: 'rq_dup', error: 'invalid image-upload request' },
        ])
      );
      // The window still has room for the rest of its budget after the refused duplicate.
      for (let i = 1; i < UPLOAD_BYTES_MAX_PER_WINDOW; i++) {
        postFromBlock('OPEN_IMAGE_UPLOAD', { requestId: `rq_more_${i}`, bytes: pngBytes() });
      }
      await vi.waitFor(() =>
        expect(h.uploadToCF).toHaveBeenCalledTimes(UPLOAD_BYTES_MAX_PER_WINDOW)
      );
      expect(repliesFor(replies, `rq_more_${UPLOAD_BYTES_MAX_PER_WINDOW - 1}`)).toEqual([]);
      replies.stop();
    } finally {
      nowSpy.mockRestore();
    }
  });

  test(`the ${
    UPLOAD_BYTES_MAX_PER_WINDOW + 1
  }th upload inside the window is busy and never uploads`, async () => {
    h.gate.mockResolvedValue({ status: 'pending' });
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();
    for (let i = 0; i <= UPLOAD_BYTES_MAX_PER_WINDOW; i++) {
      postFromBlock('OPEN_IMAGE_UPLOAD', { requestId: `rq_${i}`, bytes: pngBytes() });
    }
    await vi.waitFor(() =>
      expect(repliesFor(replies, `rq_${UPLOAD_BYTES_MAX_PER_WINDOW}`)).toEqual([
        { requestId: `rq_${UPLOAD_BYTES_MAX_PER_WINDOW}`, error: 'busy' },
      ])
    );
    await vi.waitFor(() => expect(h.uploadToCF).toHaveBeenCalledTimes(UPLOAD_BYTES_MAX_PER_WINDOW));
    replies.stop();
  });

  test('no block token: replies an error and uploads nothing', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} token={null} />);
    await driveToReady();
    const replies = listenForReply();
    postFromBlock('OPEN_IMAGE_UPLOAD', { requestId: 'rq_tok', bytes: pngBytes() });
    await vi.waitFor(() =>
      expect(repliesFor(replies, 'rq_tok')).toEqual([
        { requestId: 'rq_tok', error: 'no block token' },
      ])
    );
    expect(h.uploadToCF).not.toHaveBeenCalled();
    expect(h.authorize).not.toHaveBeenCalled();
    replies.stop();
  });
});
