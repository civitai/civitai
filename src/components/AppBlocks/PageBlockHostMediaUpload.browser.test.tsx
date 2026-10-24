import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { DialogProvider } from '~/components/Dialog/DialogProvider';
import { useDialogStore } from '~/components/Dialog/dialogStore';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { expectReplyKeys } from '../../../test/expectReplyKeys';
import type * as BlobUploadMod from '~/utils/consumer-blob-upload';
import { ConsumerBlobUploadError } from '~/utils/consumer-blob-upload';
import type * as TrpcMod from '~/utils/trpc';
import { makeInertSubRouter, makeTrpcProxy } from '../../../test/trpcProxyStub';

/**
 * `OPEN_MEDIA_UPLOAD` on the REAL PageBlockHost. The fixtures are real media (a canvas PNG, a
 * PCM WAV, a MediaRecorder WebM) decoded by the browser; only the network upload
 * (`uploadConsumerBlob`) is stubbed, and it answers with an object URL of what it was sent, so the
 * host's own read-back of an uploaded image runs for real.
 */

const h = vi.hoisted(() => ({ upload: vi.fn() }));

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
  trpc: makeTrpcProxy({
    'apps.shared': makeInertSubRouter(),
    'apps.storage': makeInertSubRouter(),
  }),
}));

// eslint-disable-next-line import/first
import { PageBlockHost } from '~/components/AppBlocks/PageBlockHost';
// eslint-disable-next-line import/first
import { MEDIA_UPLOAD_MAX_BYTES } from '~/components/AppBlocks/mediaUploadLogic';

const SAME_ORIGIN_SRC = `${window.location.origin}/`;
const baseProps = {
  appBlockId: 'apb_test',
  blockId: 'media-app',
  appId: 'app_test',
  blockInstanceId: 'page_apb_test',
  appName: 'Media App',
  iframeSrc: SAME_ORIGIN_SRC,
  surface: 'page-run' as const,
  bootSkeleton: false,
  sandbox: 'allow-scripts',
  trustTier: 'internal' as const,
  slug: 'media-app',
  token: 'tok_abc' as string | null,
  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  declaredScopes: [] as string[],
  missingScopes: [] as string[],
  needsConsent: false,
  tokenError: false,
  viewer: { id: 42, username: 'tester' },
  theme: 'light' as const,
};

// Pairwise-distinct dimensions and durations, so a mixed-up field cannot pass.
const IMG_W = 300;
const IMG_H = 200;
const VID_W = 160;
const VID_H = 96;
const WAV_MS = 250;

function makeWav(ms: number): ArrayBuffer {
  const rate = 8000;
  const samples = (rate * ms) / 1000;
  const view = new DataView(new ArrayBuffer(44 + samples * 2));
  const str = (o: number, s: string) =>
    [...s].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  view.setUint32(4, 36 + samples * 2, true);
  str(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  str(36, 'data');
  view.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i++) view.setInt16(44 + i * 2, Math.sin(i / 4) * 8000, true);
  return view.buffer;
}

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

async function record(
  stream: MediaStream,
  mimeType: string,
  ms: number,
  tick?: () => void
): Promise<ArrayBuffer> {
  const rec = new MediaRecorder(stream, { mimeType });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => chunks.push(e.data);
  const stopped = new Promise((r) => (rec.onstop = r));
  rec.start(50);
  const timer = tick ? setInterval(tick, 30) : undefined;
  await new Promise((r) => setTimeout(r, ms));
  rec.stop();
  await stopped;
  clearInterval(timer);
  stream.getTracks().forEach((t) => t.stop());
  return new Blob(chunks, { type: mimeType }).arrayBuffer();
}

/**
 * A real MediaRecorder WebM: no duration in its header, which is the case the host must handle.
 * Headless capture emits a frame only on `requestFrame()` from a canvas in the document.
 */
async function makeWebmVideo(): Promise<ArrayBuffer> {
  const canvas = document.createElement('canvas');
  canvas.width = VID_W;
  canvas.height = VID_H;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d')!;
  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0] as MediaStreamTrack & { requestFrame(): void };
  let frame = 0;
  try {
    return await record(stream, 'video/webm', 500, () => {
      ctx.fillStyle = frame++ % 2 ? '#c33' : '#33c';
      ctx.fillRect(0, 0, VID_W, VID_H);
      track.requestFrame();
    });
  } finally {
    canvas.remove();
  }
}

/**
 * An AudioContext stays suspended without a user gesture, so click first. The click does not always
 * take when several files share the browser, so a recording that came out empty is retried.
 */
async function makeWebmAudioOnly(): Promise<ArrayBuffer> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const target = document.createElement('button');
    target.textContent = 'gesture';
    document.body.appendChild(target);
    await userEvent.click(page.elementLocator(target));
    target.remove();
    const ac = new AudioContext();
    await Promise.race([ac.resume(), new Promise((r) => setTimeout(r, 2000))]);
    if (ac.state !== 'running') {
      await ac.close();
      continue;
    }
    const osc = ac.createOscillator();
    const dest = ac.createMediaStreamDestination();
    osc.connect(dest);
    osc.start();
    try {
      const recorded = await record(dest.stream, 'audio/webm', 400);
      if (recorded.byteLength > 500) return recorded;
    } finally {
      osc.stop();
      await ac.close();
    }
  }
  return new ArrayBuffer(0);
}

let PNG: ArrayBuffer;
let WAV: ArrayBuffer;
let WEBM_VIDEO: ArrayBuffer;
let WEBM_AUDIO: ArrayBuffer;
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0]).buffer;
const BROKEN_MP4 = new Uint8Array([
  0,
  0,
  0,
  0x18,
  ...[...'ftypisom'].map((c) => c.charCodeAt(0)),
  9,
  9,
  9,
  9,
]).buffer;

beforeAll(async () => {
  PNG = await makePng();
  WAV = makeWav(WAV_MS);
  WEBM_VIDEO = await makeWebmVideo();
  WEBM_AUDIO = await makeWebmAudioOnly();
  // Premise: real recordings, not the bare header a frameless capture produces.
  expect(WEBM_VIDEO.byteLength).toBeGreaterThan(500);
  expect(WEBM_AUDIO.byteLength).toBeGreaterThan(500);
}, 30_000);

const uploaded: Blob[] = [];
beforeEach(() => {
  useDialogStore.getState().closeAll();
  uploaded.length = 0;
  h.upload.mockReset().mockImplementation(async (blob: Blob) => {
    uploaded.push(blob);
    return { url: URL.createObjectURL(blob) };
  });
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
  /** EVERY MEDIA_UPLOAD_RESULT for one requestId, so a second reply cannot hide. */
  return (requestId: string) =>
    received
      .filter((m) => m.type === 'MEDIA_UPLOAD_RESULT')
      .map((m) => m.payload as Record<string, unknown>)
      .filter((p) => p.requestId === requestId);
}

async function mount(props: Partial<typeof baseProps> & { reviewMode?: boolean } = {}) {
  await renderWithProviders(
    <>
      <PageBlockHost {...baseProps} {...props} />
      <DialogProvider />
    </>
  );
  await vi.waitFor(() => {
    if (!iframe().contentWindow) throw new Error('not mounted yet');
  });
  return listen();
}

async function mountReady(props: Partial<typeof baseProps> & { reviewMode?: boolean } = {}) {
  const replies = await mount(props);
  await vi.waitFor(() => {
    postFromBlock('BLOCK_READY', {});
    if (iframe().getAttribute('data-block-ready') !== 'true') throw new Error('not ready yet');
  });
  return replies;
}

async function oneReply(replies: ReturnType<typeof listen>, requestId: string) {
  await vi.waitFor(() => expect(replies(requestId).length).toBeGreaterThan(0), { timeout: 10_000 });
  await new Promise((r) => setTimeout(r, 150));
  const all = replies(requestId);
  expect(all, `replies for ${requestId}`).toHaveLength(1);
  return all[0];
}

const req = (requestId: string, kind: string, extra: Record<string, unknown> = {}) => ({
  requestId,
  kind,
  purpose: 'generationSource',
  ...extra,
});

describe('PageBlockHost OPEN_MEDIA_UPLOAD — bytes mode', () => {
  test('image: resized, re-encoded as JPEG, uploaded, and answered with the read-back size', async () => {
    const replies = await mountReady();
    postFromBlock('OPEN_MEDIA_UPLOAD', req('rq_img', 'image', { bytes: PNG.slice(0) }));
    const reply = await oneReply(replies, 'rq_img');
    expectReplyKeys('OPEN_MEDIA_UPLOAD', 'success', ['selected'], reply);
    expect(uploaded).toHaveLength(1);
    expect(uploaded[0].type).toBe('image/jpeg');
    expect(reply.selected).toEqual({
      url: expect.stringMatching(/^blob:/),
      kind: 'image',
      mimeType: 'image/jpeg',
      sizeBytes: uploaded[0].size,
      width: IMG_W,
      height: IMG_H,
    });
  });

  test('video: a MediaRecorder WebM with no header duration still reports one', async () => {
    const replies = await mountReady();
    postFromBlock('OPEN_MEDIA_UPLOAD', req('rq_vid', 'video', { bytes: WEBM_VIDEO.slice(0) }));
    const reply = await oneReply(replies, 'rq_vid');
    const selected = reply.selected as Record<string, unknown>;
    expect(selected).toMatchObject({
      kind: 'video',
      mimeType: 'video/webm',
      sizeBytes: WEBM_VIDEO.byteLength,
      width: VID_W,
      height: VID_H,
    });
    expect(selected.durationMs).toBeGreaterThan(100);
    expect(selected.durationMs).toBeLessThan(5000);
    expect(uploaded[0].type).toBe('video/webm');
    expect(uploaded[0].size).toBe(WEBM_VIDEO.byteLength);
  });

  test('audio: WAV answered with its duration and no dimensions; x-wav is accepted as WAV', async () => {
    const replies = await mountReady();
    postFromBlock(
      'OPEN_MEDIA_UPLOAD',
      req('rq_wav', 'audio', { bytes: WAV.slice(0), mimeType: 'audio/x-wav' })
    );
    const reply = await oneReply(replies, 'rq_wav');
    expect(reply.selected).toEqual({
      url: expect.stringMatching(/^blob:/),
      kind: 'audio',
      mimeType: 'audio/wav',
      sizeBytes: WAV.byteLength,
      durationMs: WAV_MS,
    });
  });

  test.each([
    ['image', () => GIF, 'images must be PNG, JPEG or WebP'],
    ['video', () => WAV, 'videos must be MP4 or WebM'],
    ['audio', () => PNG, 'audio must be MP3, WAV or WebM'],
  ] as const)(
    '%s: the wrong content type is refused before any upload',
    async (kind, bytes, error) => {
      const replies = await mountReady();
      postFromBlock('OPEN_MEDIA_UPLOAD', req(`rq_type_${kind}`, kind, { bytes: bytes().slice(0) }));
      const reply = await oneReply(replies, `rq_type_${kind}`);
      expectReplyKeys('OPEN_MEDIA_UPLOAD', 'error', ['error'], reply);
      expect(reply.error).toBe(error);
      expect(h.upload).not.toHaveBeenCalled();
    }
  );

  test('an over-cap file is refused as too large', async () => {
    const replies = await mountReady();
    const big = new Uint8Array(MEDIA_UPLOAD_MAX_BYTES + 1);
    big.set(new Uint8Array(WAV.slice(0, 44)));
    postFromBlock('OPEN_MEDIA_UPLOAD', req('rq_big', 'audio', { bytes: big.buffer }));
    expect(await oneReply(replies, 'rq_big')).toEqual({
      requestId: 'rq_big',
      error: 'file exceeds the 64 MB upload limit',
    });
    expect(h.upload).not.toHaveBeenCalled();
  });

  test('an image over its own 24 MB cap is refused before any decode', async () => {
    const replies = await mountReady();
    const big = new Uint8Array(24 * 1024 * 1024 + 1);
    big.set(new Uint8Array(PNG.slice(0, 64)));
    postFromBlock('OPEN_MEDIA_UPLOAD', req('rq_bigimg', 'image', { bytes: big.buffer }));
    expect(await oneReply(replies, 'rq_bigimg')).toEqual({
      requestId: 'rq_bigimg',
      error: 'file exceeds the 24 MB image upload limit',
    });
    expect(h.upload).not.toHaveBeenCalled();
  });

  test('with no block token, bytes are refused and nothing is uploaded', async () => {
    const replies = await mountReady({ token: null });
    postFromBlock('OPEN_MEDIA_UPLOAD', req('rq_tok', 'audio', { bytes: WAV.slice(0) }));
    expect(await oneReply(replies, 'rq_tok')).toEqual({
      requestId: 'rq_tok',
      error: 'no block token',
    });
    expect(h.upload).not.toHaveBeenCalled();
  });

  test.each([
    [
      'a blob POST failure',
      new ConsumerBlobUploadError('Failed to upload blob: SECRET-BODY', 'http-500', false),
      'media upload failed — please try again',
    ],
    [
      'a presign denial',
      new ConsumerBlobUploadError('SECRET-DENIAL-TEXT', 'presign-http-403', false),
      'media upload failed — please try again',
    ],
    [
      'a signed-out presign',
      new ConsumerBlobUploadError('Sign in to upload images.', 'presign-http-401', false),
      'Sign in to upload media.',
    ],
  ])('%s reaches the block as a fixed message', async (_, err, error) => {
    h.upload.mockRejectedValueOnce(err);
    const replies = await mountReady();
    postFromBlock('OPEN_MEDIA_UPLOAD', req('rq_err', 'audio', { bytes: WAV.slice(0) }));
    expect(await oneReply(replies, 'rq_err')).toEqual({ requestId: 'rq_err', error });
  });

  test('a blob the upload service blocks is refused, not answered with its url', async () => {
    h.upload.mockResolvedValueOnce({ url: 'blob:blocked', available: false, blockedReason: 'x' });
    const replies = await mountReady();
    postFromBlock('OPEN_MEDIA_UPLOAD', req('rq_blocked', 'audio', { bytes: WAV.slice(0) }));
    expect(await oneReply(replies, 'rq_blocked')).toEqual({
      requestId: 'rq_blocked',
      error: 'this audio was refused by the upload service',
    });
  });

  test('a declared mimeType that disagrees with the content is refused', async () => {
    const replies = await mountReady();
    postFromBlock(
      'OPEN_MEDIA_UPLOAD',
      req('rq_mm', 'audio', { bytes: WAV.slice(0), mimeType: 'audio/mpeg' })
    );
    expect((await oneReply(replies, 'rq_mm')).error).toBe(
      "mimeType does not match the file's content"
    );
  });

  test('video: an audio-only WebM is refused for having no video track', async () => {
    const replies = await mountReady();
    postFromBlock('OPEN_MEDIA_UPLOAD', req('rq_novt', 'video', { bytes: WEBM_AUDIO.slice(0) }));
    expect((await oneReply(replies, 'rq_novt')).error).toBe('this file has no video track');
    expect(h.upload).not.toHaveBeenCalled();
  });

  test('video: a file the browser cannot decode is refused', async () => {
    const replies = await mountReady();
    postFromBlock('OPEN_MEDIA_UPLOAD', req('rq_broken', 'video', { bytes: BROKEN_MP4.slice(0) }));
    expect((await oneReply(replies, 'rq_broken')).error).toBe('could not read this video file');
    expect(h.upload).not.toHaveBeenCalled();
  });

  test('the 9th upload inside the window is refused as busy, and a refusal does not use a slot', async () => {
    const replies = await mountReady();
    postFromBlock('OPEN_MEDIA_UPLOAD', req('rq_rl_bad', 'audio', { bytes: GIF.slice(0) }));
    for (let i = 0; i < 9; i++) {
      postFromBlock('OPEN_MEDIA_UPLOAD', req(`rq_rl_${i}`, 'audio', { bytes: WAV.slice(0) }));
    }
    for (let i = 0; i < 8; i++) {
      expect((await oneReply(replies, `rq_rl_${i}`)).selected, `upload ${i + 1}`).toBeTruthy();
    }
    expect(await oneReply(replies, 'rq_rl_8')).toEqual({ requestId: 'rq_rl_8', error: 'busy' });
    expect(h.upload).toHaveBeenCalledTimes(8);
  });

  test('a reused requestId whose upload is still running gets no second reply', async () => {
    let release!: () => void;
    h.upload.mockImplementationOnce(
      (blob: Blob) => new Promise((r) => (release = () => r({ url: URL.createObjectURL(blob) })))
    );
    const replies = await mountReady();
    postFromBlock('OPEN_MEDIA_UPLOAD', req('rq_dup', 'audio', { bytes: WAV.slice(0) }));
    await vi.waitFor(() => expect(h.upload).toHaveBeenCalledTimes(1));
    postFromBlock('OPEN_MEDIA_UPLOAD', req('rq_dup', 'audio', { kind: 'nope' }));
    await new Promise((r) => setTimeout(r, 150));
    expect(replies('rq_dup')).toEqual([]);
    release();
    expect((await oneReply(replies, 'rq_dup')).selected).toMatchObject({ kind: 'audio' });
  });

  test('a bad kind or purpose is refused', async () => {
    const replies = await mountReady();
    postFromBlock('OPEN_MEDIA_UPLOAD', req('rq_kind', 'pdf', { bytes: WAV.slice(0) }));
    postFromBlock('OPEN_MEDIA_UPLOAD', {
      requestId: 'rq_purpose',
      kind: 'audio',
      bytes: WAV.slice(0),
    });
    expect((await oneReply(replies, 'rq_kind')).error).toBe(
      "kind must be 'image', 'video' or 'audio'"
    );
    expect((await oneReply(replies, 'rq_purpose')).error).toBe(
      "purpose must be 'generationSource'"
    );
  });
});

describe('PageBlockHost OPEN_MEDIA_UPLOAD — picker mode', () => {
  /** The hidden native input of the media modal's Mantine FileInput (the test id is on its button). */
  function fileInput() {
    return vi.waitFor(() => {
      if (!document.querySelector('[data-testid="block-media-upload-file-input"]')) {
        throw new Error('media modal not open');
      }
      const el = document.querySelector<HTMLInputElement>('input[type="file"]:not([multiple])');
      if (!el) throw new Error('media file input not found');
      return el;
    });
  }

  test.each([
    ['image', 'image/png,image/jpeg,image/webp'],
    ['video', 'video/mp4,video/webm'],
    ['audio', 'audio/mpeg,audio/wav,audio/x-wav,audio/webm'],
  ] as const)('%s: the host modal offers only that kind', async (kind, accept) => {
    await mountReady();
    postFromBlock('OPEN_MEDIA_UPLOAD', req(`rq_acc_${kind}`, kind));
    expect((await fileInput()).getAttribute('accept')).toBe(accept);
  });

  test('a picked file is uploaded and answered once the modal closes; a wrong file is shown, not answered', async () => {
    const replies = await mountReady();
    postFromBlock('OPEN_MEDIA_UPLOAD', req('rq_pick', 'audio'));
    const input = await fileInput();
    await userEvent.upload(input, new File([PNG], 'not-audio.wav', { type: 'audio/wav' }));
    await expect
      .element(page.getByTestId('block-media-upload-message'))
      .toHaveTextContent('audio must be MP3, WAV or WebM');
    expect(replies('rq_pick')).toEqual([]);
    await userEvent.upload(await fileInput(), new File([WAV], 'take.wav', { type: 'audio/wav' }));
    const reply = await oneReply(replies, 'rq_pick');
    expect(reply.selected).toMatchObject({
      kind: 'audio',
      mimeType: 'audio/wav',
      durationMs: WAV_MS,
    });
  });

  test('closing the modal mid-upload answers one cancel, never the late upload', async () => {
    let release!: () => void;
    h.upload.mockImplementationOnce(
      (blob: Blob) => new Promise((r) => (release = () => r({ url: URL.createObjectURL(blob) })))
    );
    const replies = await mountReady();
    postFromBlock('OPEN_MEDIA_UPLOAD', req('rq_midclose', 'audio'));
    await userEvent.upload(await fileInput(), new File([WAV], 'take.wav', { type: 'audio/wav' }));
    await vi.waitFor(() => expect(h.upload).toHaveBeenCalledTimes(1));
    await userEvent.keyboard('{Escape}');
    await vi.waitFor(() => expect(replies('rq_midclose')).toHaveLength(1));
    release();
    await new Promise((r) => setTimeout(r, 300));
    expect(replies('rq_midclose')).toEqual([{ requestId: 'rq_midclose' }]);
  });

  test('dismissing the modal answers as a cancel', async () => {
    const replies = await mountReady();
    postFromBlock('OPEN_MEDIA_UPLOAD', req('rq_dismiss', 'video'));
    await fileInput();
    await userEvent.click(page.getByRole('button', { name: 'Cancel' }));
    const reply = await oneReply(replies, 'rq_dismiss');
    expectReplyKeys('OPEN_MEDIA_UPLOAD', 'success', [], reply);
    expect(h.upload).not.toHaveBeenCalled();
  });
});

describe('PageBlockHost OPEN_MEDIA_UPLOAD — refusals that open nothing', () => {
  test('review mode answers both modes as a cancel and uploads nothing', async () => {
    const replies = await mountReady({ reviewMode: true });
    postFromBlock('OPEN_MEDIA_UPLOAD', req('rq_rev_pick', 'image'));
    postFromBlock('OPEN_MEDIA_UPLOAD', req('rq_rev_bytes', 'audio', { bytes: WAV.slice(0) }));
    expect(await oneReply(replies, 'rq_rev_pick')).toEqual({ requestId: 'rq_rev_pick' });
    expect(await oneReply(replies, 'rq_rev_bytes')).toEqual({ requestId: 'rq_rev_bytes' });
    expect(document.querySelector('[data-testid="block-media-upload-file-input"]')).toBeNull();
    expect(h.upload).not.toHaveBeenCalled();
  });

  test('a block that is not ready yet is answered as a cancel', async () => {
    const replies = await mount();
    postFromBlock('OPEN_MEDIA_UPLOAD', req('rq_early', 'audio', { bytes: WAV.slice(0) }));
    expect(await oneReply(replies, 'rq_early')).toEqual({ requestId: 'rq_early' });
    expect(h.upload).not.toHaveBeenCalled();
  });
});

describe('PageBlockHost OPEN_IMAGE_UPLOAD is unchanged', () => {
  test("purpose 'generationSource' still opens the image-only source modal, not the media modal", async () => {
    await mountReady();
    postFromBlock('OPEN_IMAGE_UPLOAD', { requestId: 'rq_old', purpose: 'generationSource' });
    await vi.waitFor(() => {
      if (!document.querySelector('[data-testid="block-generation-source-file-input"]')) {
        throw new Error('source modal not open');
      }
    });
    expect(document.querySelector('[data-testid="block-media-upload-file-input"]')).toBeNull();
  });
});
