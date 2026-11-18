import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { DialogProvider } from '~/components/Dialog/DialogProvider';
import { useDialogStore } from '~/components/Dialog/dialogStore';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type * as BlobUploadMod from '~/utils/consumer-blob-upload';
import type * as TrpcMod from '~/utils/trpc';
import { makeInertSubRouter, makeTrpcProxy } from '../../../test/trpcProxyStub';

/**
 * A picked generation source on the REAL PageBlockHost while `app-block-source-scanned-rows`
 * decides the path: `OPEN_IMAGE_UPLOAD { purpose: 'generationSource' }` (the picker modal) and a
 * single `OPEN_MEDIA_UPLOAD` image (bytes mode). The upload is the one it always was (a consumer
 * blob, stubbed to an object URL so the host's read-back runs for real); what changes is the
 * answer:
 *
 * Wiring only: the decision itself (ON / OFF / query fails / copy fails) is unit-tested in
 * `__tests__/generationSourceScannedRows.test.ts`. Each host site gets one flag-ON case (the copy
 * is asked for with the CURRENT block token and its row is the reply) and, where the host builds
 * the reply itself, one flag-OFF case and the refused-copy error reply.
 */

const h = vi.hoisted(() => ({
  upload: vi.fn(),
  query: vi.fn(),
  persist: vi.fn(),
}));

vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: 42, username: 'tester' }),
}));

vi.mock('~/utils/consumer-blob-upload', async (importOriginal) => ({
  ...(await importOriginal<typeof BlobUploadMod>()),
  uploadConsumerBlob: h.upload,
}));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  setTrpcBatchingEnabled: vi.fn(),
  trpc: makeTrpcProxy(
    {
      'apps.shared': makeInertSubRouter(),
      'apps.storage': makeInertSubRouter(),
    },
    {
      useUtils: () => ({
        client: {
          blockImageUpload: { generationSourceUsesScannedRows: { query: h.query } },
          blocks: { persistUploadedGenerationSource: { mutate: h.persist } },
        },
      }),
    }
  ),
}));

// eslint-disable-next-line import/first
import { PageBlockHost } from '~/components/AppBlocks/PageBlockHost';

const SAME_ORIGIN_SRC = `${window.location.origin}/`;
const baseProps = {
  appBlockId: 'apb_test',
  blockId: 'source-app',
  appId: 'app_test',
  blockInstanceId: 'page_apb_test',
  appName: 'Source App',
  iframeSrc: SAME_ORIGIN_SRC,
  surface: 'page-run' as const,
  bootSkeleton: false,
  sandbox: 'allow-scripts',
  trustTier: 'internal' as const,
  slug: 'source-app',
  token: 'tok_abc' as string | null,
  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  declaredScopes: [] as string[],
  missingScopes: [] as string[],
  needsConsent: false,
  tokenError: false,
  viewer: { id: 42, username: 'tester' },
  theme: 'light' as const,
};

const IMG_W = 300;
const IMG_H = 200;
const PERSISTED = {
  url: 'https://image.civitai.com/x/k/original=true/k.jpeg',
  width: 298,
  height: 199,
  imageId: 9001,
  ready: true,
};

async function makePng(): Promise<ArrayBuffer> {
  const canvas = document.createElement('canvas');
  canvas.width = IMG_W;
  canvas.height = IMG_H;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#3a7';
  ctx.fillRect(0, 0, IMG_W, IMG_H);
  const blob = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), 'image/png'));
  return blob.arrayBuffer();
}

let PNG: ArrayBuffer;
beforeAll(async () => {
  PNG = await makePng();
});

const uploadedUrls: string[] = [];
beforeEach(() => {
  useDialogStore.getState().closeAll();
  uploadedUrls.length = 0;
  h.upload.mockReset().mockImplementation(async (blob: Blob) => {
    const url = URL.createObjectURL(blob);
    uploadedUrls.push(url);
    return { url };
  });
  h.query.mockReset().mockResolvedValue({ scannedRows: true });
  h.persist.mockReset().mockResolvedValue(PERSISTED);
});

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

function listen() {
  const received: Array<{ type: string; payload: unknown }> = [];
  const cw = iframe().contentWindow;
  if (!cw) throw new Error('iframe contentWindow missing');
  cw.addEventListener('message', (e: MessageEvent) => {
    const d = e.data as { type?: string; payload?: unknown } | null;
    if (d && typeof d.type === 'string') received.push({ type: d.type, payload: d.payload });
  });
  return (type: string, requestId: string) =>
    received
      .filter((m) => m.type === type)
      .map((m) => m.payload as Record<string, unknown>)
      .filter((p) => p.requestId === requestId);
}

async function mountReady() {
  await renderWithProviders(
    <>
      <PageBlockHost {...baseProps} />
      <DialogProvider />
    </>
  );
  await vi.waitFor(() => {
    if (!iframe().contentWindow) throw new Error('not mounted yet');
  });
  const replies = listen();
  await vi.waitFor(() => {
    postFromBlock('BLOCK_READY', {});
    if (iframe().getAttribute('data-block-ready') !== 'true') throw new Error('not ready yet');
  });
  return replies;
}

async function oneReply(replies: ReturnType<typeof listen>, type: string, requestId: string) {
  await vi.waitFor(() => expect(replies(type, requestId).length).toBeGreaterThan(0), {
    timeout: 10_000,
  });
  await new Promise((r) => setTimeout(r, 150));
  const all = replies(type, requestId);
  expect(all, `replies for ${requestId}`).toHaveLength(1);
  return all[0];
}

const mediaReq = (requestId: string) => ({
  requestId,
  kind: 'image',
  purpose: 'generationSource',
  bytes: PNG.slice(0),
});

describe('PageBlockHost — a single OPEN_MEDIA_UPLOAD image (bytes mode)', () => {
  test('🔴 flag ON: replies with the scanned row, copied from THIS upload with the current token', async () => {
    const replies = await mountReady();
    postFromBlock('OPEN_MEDIA_UPLOAD', mediaReq('rq_on'));
    const reply = await oneReply(replies, 'MEDIA_UPLOAD_RESULT', 'rq_on');
    expect(h.upload).toHaveBeenCalledTimes(1);
    // The flag is per app: the path query names the app by the same current token.
    expect(h.query.mock.calls).toEqual([[{ blockToken: 'tok_abc' }]]);
    expect(h.persist.mock.calls).toEqual([[{ blockToken: 'tok_abc', url: uploadedUrls[0] }]]);
    expect(reply.selected).toEqual({
      kind: 'image',
      mimeType: 'image/jpeg',
      sizeBytes: expect.any(Number),
      ...PERSISTED,
    });
  });

  test('flag OFF: replies with the blob, as before, and asks for no copy', async () => {
    h.query.mockResolvedValue({ scannedRows: false });
    const replies = await mountReady();
    postFromBlock('OPEN_MEDIA_UPLOAD', mediaReq('rq_off'));
    const reply = await oneReply(replies, 'MEDIA_UPLOAD_RESULT', 'rq_off');
    expect(h.persist).not.toHaveBeenCalled();
    expect(reply.selected).toMatchObject({ url: uploadedUrls[0], width: IMG_W, height: IMG_H });
    expect(reply.selected).not.toHaveProperty('imageId');
  });

  test('🔴 flag ON and the copy is refused: an error reply, never the blob', async () => {
    h.persist.mockRejectedValue(new Error('that url is not an uploaded generation source'));
    const replies = await mountReady();
    postFromBlock('OPEN_MEDIA_UPLOAD', mediaReq('rq_refused'));
    const reply = await oneReply(replies, 'MEDIA_UPLOAD_RESULT', 'rq_refused');
    expect(reply).not.toHaveProperty('selected');
    expect(reply.error).toBe('that url is not an uploaded generation source');
  });
});

describe('PageBlockHost — OPEN_IMAGE_UPLOAD { purpose: generationSource } (the picker)', () => {
  async function pick(replies: ReturnType<typeof listen>, requestId: string) {
    postFromBlock('OPEN_IMAGE_UPLOAD', { requestId, purpose: 'generationSource' });
    const input = await vi.waitFor(() => {
      const el = document.querySelector<HTMLInputElement>('input[type="file"]:not([multiple])');
      if (!el) throw new Error('file input not found');
      return el;
    });
    await userEvent.upload(input, new File([PNG.slice(0)], 'source.png', { type: 'image/png' }));
    return oneReply(replies, 'IMAGE_UPLOAD_RESULT', requestId);
  }

  test('🔴 flag ON: the picked file comes back as the scanned row (url, size, imageId, ready)', async () => {
    const replies = await mountReady();
    const reply = await pick(replies, 'rq_pick_on');
    expect(h.persist.mock.calls).toEqual([[{ blockToken: 'tok_abc', url: uploadedUrls[0] }]]);
    expect(reply.selected).toEqual(PERSISTED);
  });

  test('flag OFF: the picked file comes back as the blob, exactly the old shape', async () => {
    h.query.mockResolvedValue({ scannedRows: false });
    const replies = await mountReady();
    const reply = await pick(replies, 'rq_pick_off');
    expect(h.persist).not.toHaveBeenCalled();
    expect(reply.selected).toEqual({ url: uploadedUrls[0], width: IMG_W, height: IMG_H });
  });
});

describe('PageBlockHost — OPEN_MEDIA_UPLOAD picker mode (BlockMediaUploadModal)', () => {
  test('🔴 flag ON: the picked image comes back as the scanned row, copied with the current token', async () => {
    const replies = await mountReady();
    postFromBlock('OPEN_MEDIA_UPLOAD', {
      requestId: 'rq_media_pick',
      kind: 'image',
      purpose: 'generationSource',
    });
    const input = await vi.waitFor(() => {
      if (!document.querySelector('[data-testid="block-media-upload-file-input"]')) {
        throw new Error('media modal not open');
      }
      const el = document.querySelector<HTMLInputElement>('input[type="file"]:not([multiple])');
      if (!el) throw new Error('media file input not found');
      return el;
    });
    await userEvent.upload(input, new File([PNG.slice(0)], 'source.png', { type: 'image/png' }));
    const reply = await oneReply(replies, 'MEDIA_UPLOAD_RESULT', 'rq_media_pick');
    expect(h.query.mock.calls).toEqual([[{ blockToken: 'tok_abc' }]]);
    expect(h.persist.mock.calls).toEqual([[{ blockToken: 'tok_abc', url: uploadedUrls[0] }]]);
    expect(reply.selected).toEqual({
      kind: 'image',
      mimeType: 'image/jpeg',
      sizeBytes: expect.any(Number),
      ...PERSISTED,
    });
  });
});
