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
 * uploaded with NO picker, through the same store upload a picked image uses, persisted by
 * `blocks.persistAppUploadImage`, and gated by the same scan poll — replying the same shapes a
 * picked `display` upload does, or `{ requestId, error }`.
 *
 * The store upload (`useCFImageUpload`) and the three server calls are the only stubs; the
 * request parse, limits, uploader, poller and reply mapping all run for real.
 */

const h = vi.hoisted(() => ({
  uploadToCF: vi.fn(),
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
    'blocks.persistAppUploadImage': { useMutation: () => ({ mutateAsync: h.persist }) },
    'blockImageUpload.gate': { useMutation: () => ({ mutateAsync: h.gate }) },
    'apps.shared': makeInertSubRouter(),
    'apps.storage': makeInertSubRouter(),
  }),
}));

// eslint-disable-next-line import/first
import { PageBlockHost } from '~/components/AppBlocks/PageBlockHost';

const KEY = '33333333-3333-4333-8333-333333333333';
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48];
const GIF = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00];
const pngBytes = () => new Uint8Array(PNG).buffer;

const READY = {
  status: 'ready' as const,
  imageId: 77,
  nsfwLevel: 1,
  contentRating: 'pg',
  url: 'https://image.civitai.com/xG/77/width=1200/original.jpeg',
};
const SELECTED = {
  imageId: 77,
  nsfwLevel: 1,
  contentRating: 'pg',
  url: 'https://image.civitai.com/xG/77/width=1200/original.jpeg',
};

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

async function driveToReady() {
  await vi.waitFor(() => {
    if (!iframe().contentWindow) throw new Error('not mounted yet');
  });
  await vi.waitFor(() => {
    postFromBlock('BLOCK_READY', {});
    if (iframe().getAttribute('data-block-ready') !== 'true') throw new Error('not ready yet');
  });
}

/** Every IMAGE_UPLOAD_RESULT so far, keyed by requestId. */
function resultsById(replies: ReturnType<typeof listenForReply>) {
  return Object.fromEntries(
    replies.of('IMAGE_UPLOAD_RESULT').map((p) => [(p as { requestId: string }).requestId, p])
  );
}

beforeEach(() => {
  useDialogStore.getState().closeAll();
  h.uploadToCF.mockReset().mockResolvedValue({ id: KEY, url: 'u', objectUrl: 'o', type: 'image' });
  h.persist.mockReset().mockResolvedValue({ imageId: 77 });
  h.gate.mockReset().mockResolvedValue(READY);
});

describe('PageBlockHost OPEN_IMAGE_UPLOAD { bytes }', () => {
  test('CROSS-FRAME: an ArrayBuffer from the opaque sandbox is uploaded with no picker and replies the moderated image; a Uint8Array is refused', async () => {
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
      el.srcdoc =
        `<script>
        var sent = false;
        function go() {
          if (sent) return;
          sent = true;
          var png = new Uint8Array([${PNG.join(',')}]);
          parent.postMessage({ type: 'OPEN_IMAGE_UPLOAD', payload: { requestId: 'rq_xf_ab', bytes: png.buffer.slice(0), filename: 'fixed meta.png' } }, '*');
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

      await vi.waitFor(() => {
        const results = Object.fromEntries(
          echoes
            .filter((m) => m.data.type === 'IMAGE_UPLOAD_RESULT')
            .map((m) => [(m.data.payload as { requestId: string }).requestId, m.data.payload])
        );
        expect(results).toEqual({
          rq_xf_ab: { requestId: 'rq_xf_ab', selected: SELECTED },
          rq_xf_u8: { requestId: 'rq_xf_u8', error: 'invalid image-upload request' },
        });
      });
      // Positive control that the messages really crossed realms: an opaque sandbox posts as 'null'.
      expect(new Set(echoes.map((m) => m.origin))).toEqual(new Set(['null']));
    } finally {
      window.removeEventListener('message', onEcho);
    }

    // No picker: the whole point of the variant.
    expect(useDialogStore.getState().dialogs).toHaveLength(0);
    // The bytes reached the store upload unchanged, typed from their content.
    expect(h.uploadToCF).toHaveBeenCalledTimes(1);
    const file = h.uploadToCF.mock.calls[0][0] as File;
    expect([file.name, file.type]).toEqual(['fixed meta.png', 'image/png']);
    expect(Array.from(new Uint8Array(await file.arrayBuffer()))).toEqual(PNG);
    // Persisted through the stamping proc with the HOST's token, then gated on that id.
    expect(h.persist).toHaveBeenCalledWith({
      blockToken: 'tok_abc',
      url: KEY,
      name: 'fixed meta.png',
    });
    expect(h.gate).toHaveBeenCalledWith({ imageId: 77 });
  });

  test('asyncScan: replies the PENDING handle on persist, then pushes the verdict', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();
    postFromBlock('OPEN_IMAGE_UPLOAD', {
      requestId: 'rq_async',
      bytes: pngBytes(),
      asyncScan: true,
    });

    await vi.waitFor(() => {
      expect(replies.of('IMAGE_SCAN_RESOLVED')).toEqual([
        { requestId: 'rq_async', imageId: 77, result: { status: 'scanned', image: SELECTED } },
      ]);
    });
    expect(replies.of('IMAGE_UPLOAD_RESULT')).toEqual([
      {
        requestId: 'rq_async',
        selected: { status: 'pending', imageId: 77, url: expect.stringContaining(KEY) },
      },
    ]);
    replies.stop();
  });

  test('every refusal and failure replies `{ requestId, error }` — never the bare cancelled shape', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    // A GIF is not an allowed type: refused before any upload.
    postFromBlock('OPEN_IMAGE_UPLOAD', { requestId: 'rq_gif', bytes: new Uint8Array(GIF).buffer });
    // generationSource never creates an Image row, so bytes cannot ride it.
    postFromBlock('OPEN_IMAGE_UPLOAD', {
      requestId: 'rq_src',
      bytes: pngBytes(),
      purpose: 'generationSource',
    });
    await vi.waitFor(() =>
      expect(resultsById(replies)).toEqual({
        rq_gif: { requestId: 'rq_gif', error: 'file type is not allowed' },
        rq_src: { requestId: 'rq_src', error: 'invalid image-upload request' },
      })
    );
    expect(h.uploadToCF).not.toHaveBeenCalled();

    // The server refusing the persist (here: the app lacks the post scope).
    h.persist.mockRejectedValueOnce(new Error('block lacks posts:write:self scope'));
    postFromBlock('OPEN_IMAGE_UPLOAD', { requestId: 'rq_scope', bytes: pngBytes() });
    await vi.waitFor(() =>
      expect(resultsById(replies).rq_scope).toEqual({
        requestId: 'rq_scope',
        error: 'block lacks posts:write:self scope',
      })
    );

    // The scan refusing the image (a thrown BAD_REQUEST from the gate).
    h.gate.mockRejectedValueOnce(
      Object.assign(new Error('that image was flagged during review — choose a different image'), {
        data: { code: 'BAD_REQUEST' },
      })
    );
    postFromBlock('OPEN_IMAGE_UPLOAD', { requestId: 'rq_flag', bytes: pngBytes() });
    await vi.waitFor(() =>
      expect(resultsById(replies).rq_flag).toEqual({
        requestId: 'rq_flag',
        error: 'that image was flagged during review — choose a different image',
      })
    );
    expect(useDialogStore.getState().dialogs).toHaveLength(0);
    replies.stop();
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
      expect(resultsById(replies)[`rq_${UPLOAD_BYTES_MAX_PER_WINDOW}`]).toEqual({
        requestId: `rq_${UPLOAD_BYTES_MAX_PER_WINDOW}`,
        error: 'busy',
      })
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
      expect(resultsById(replies).rq_tok).toEqual({ requestId: 'rq_tok', error: 'no block token' })
    );
    expect(h.uploadToCF).not.toHaveBeenCalled();
    replies.stop();
  });
});
