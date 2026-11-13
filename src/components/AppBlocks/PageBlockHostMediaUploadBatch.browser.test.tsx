import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { DialogProvider } from '~/components/Dialog/DialogProvider';
import { useDialogStore } from '~/components/Dialog/dialogStore';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { expectReplyKeys } from '../../../test/expectReplyKeys';
import type * as BlobUploadMod from '~/utils/consumer-blob-upload';
import type * as TrpcMod from '~/utils/trpc';
import { makeInertSubRouter, makeTrpcProxy } from '../../../test/trpcProxyStub';

/**
 * `OPEN_MEDIA_UPLOAD_BATCH` on the REAL PageBlockHost. The fixtures are real WAVs decoded by the
 * browser; the network upload (`uploadConsumerBlob`) and the three batch procedures are stubbed,
 * and the upload stub can hold its uploads open, so how many run at once is observed, not inferred.
 */

const h = vi.hoisted(() => ({
  upload: vi.fn(),
  start: vi.fn(),
  presign: vi.fn(),
  record: vi.fn(),
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
          blocks: {
            startMediaUploadBatch: { mutate: h.start },
            presignMediaUploadBatchItem: { mutate: h.presign },
            recordMediaUploadBatchItem: { mutate: h.record },
          },
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
  blockId: 'media-app',
  appId: 'app_test',
  blockInstanceId: 'page_apb_test',
  appName: 'Batch App',
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

const WAV_MS = 250;
const EXPIRES_AT = '2026-12-11T10:00:00.000Z';
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0]).buffer;

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

let WAV: ArrayBuffer;
beforeAll(() => {
  WAV = makeWav(WAV_MS);
});

/** Uploads the stub has been handed, in call order. */
const uploads: Array<{ blob: Blob; options: unknown }> = [];
/** When set, each upload waits for this to be called before it resolves. */
let holdUploads: ((release: () => void) => void) | null = null;
let inFlight = 0;
let peakInFlight = 0;

beforeEach(() => {
  useDialogStore.getState().closeAll();
  uploads.length = 0;
  holdUploads = null;
  inFlight = 0;
  peakInFlight = 0;
  h.upload.mockReset().mockImplementation(async (blob: Blob, options?: unknown) => {
    const n = uploads.push({ blob, options });
    inFlight++;
    peakInFlight = Math.max(peakInFlight, inFlight);
    if (holdUploads) await new Promise<void>((resolve) => holdUploads!(resolve));
    inFlight--;
    return {
      id: `${String(n).padStart(32, '0')}.wav`,
      url: URL.createObjectURL(blob),
      available: true,
    };
  });
  h.start.mockReset().mockResolvedValue({ batchId: 91, expiresAt: EXPIRES_AT });
  h.presign
    .mockReset()
    .mockResolvedValue({ uploadUrl: 'https://upload.invalid/x', expiresAt: 'e' });
  h.record.mockReset().mockResolvedValue({ expiresAt: EXPIRES_AT });
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

/** The last mount, so a test can re-render it with new props (a refreshed token). */
let mounted: Awaited<ReturnType<typeof renderWithProviders>> | null = null;

async function mountReady(props: Partial<typeof baseProps> & { reviewMode?: boolean } = {}) {
  mounted = await renderWithProviders(
    <>
      <PageBlockHost {...baseProps} {...props} />
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

type Replies = Awaited<ReturnType<typeof mountReady>>;

async function oneReply(replies: Replies, requestId: string, type = 'MEDIA_UPLOAD_BATCH_RESULT') {
  await vi.waitFor(() => expect(replies(type, requestId).length).toBeGreaterThan(0), {
    timeout: 15_000,
  });
  await new Promise((r) => setTimeout(r, 150));
  const all = replies(type, requestId);
  expect(all, `replies for ${requestId}`).toHaveLength(1);
  return all[0];
}

const batch = (requestId: string, items: unknown[]) => ({
  requestId,
  purpose: 'generationSource',
  items,
});
const wavs = (n: number) =>
  Array.from({ length: n }, () => ({ kind: 'audio', bytes: WAV.slice(0) }));

const confirmButton = () => page.getByRole('button', { name: 'Upload', exact: true });

async function confirm() {
  await expect.element(confirmButton(), { timeout: 4000 }).toBeEnabled();
  await confirmButton().click();
}

describe('PageBlockHost OPEN_MEDIA_UPLOAD_BATCH — the confirm', () => {
  test('asks ONE host-chrome question, and uploads nothing until it is answered', async () => {
    const replies = await mountReady();
    postFromBlock('OPEN_MEDIA_UPLOAD_BATCH', batch('rq_ask', wavs(3)));
    await expect
      .element(page.getByText(/^Upload 3 audio files \([\d.]+ MB\) for “Batch App”\?/))
      .toBeVisible();
    // Long enough for an eager host to have started.
    await new Promise((r) => setTimeout(r, 300));
    expect(h.start).not.toHaveBeenCalled();
    expect(h.upload).not.toHaveBeenCalled();
    expect(replies('MEDIA_UPLOAD_BATCH_RESULT', 'rq_ask')).toEqual([]);
  });

  test('a declined confirm uploads nothing, starts no batch, and answers bare', async () => {
    const replies = await mountReady();
    postFromBlock('OPEN_MEDIA_UPLOAD_BATCH', batch('rq_decline', wavs(3)));
    await page.getByRole('button', { name: 'Cancel' }).click();
    const reply = await oneReply(replies, 'rq_decline');
    expect(reply).toEqual({ requestId: 'rq_decline' });
    expect(h.start).not.toHaveBeenCalled();
    expect(h.upload).not.toHaveBeenCalled();
    expect(h.presign).not.toHaveBeenCalled();
  });

  test('confirmed: starts the batch for the valid files, uploads each with the batch’s presign, records each', async () => {
    const replies = await mountReady();
    postFromBlock('OPEN_MEDIA_UPLOAD_BATCH', batch('rq_ok', wavs(3)));
    await confirm();
    const reply = await oneReply(replies, 'rq_ok');
    expectReplyKeys('OPEN_MEDIA_UPLOAD_BATCH', 'success', ['results', 'expiresAt'], reply);
    expect(h.start).toHaveBeenCalledWith({
      blockToken: 'tok_abc',
      items: Array.from({ length: 3 }, () => ({ kind: 'audio', sizeBytes: WAV.byteLength })),
    });
    expect(reply.expiresAt).toBe(EXPIRES_AT);
    expect(reply.results).toEqual(
      [0, 1, 2].map((index) => ({
        index,
        selected: {
          url: expect.stringMatching(/^blob:/),
          kind: 'audio',
          mimeType: 'audio/wav',
          sizeBytes: WAV.byteLength,
          durationMs: WAV_MS,
        },
      }))
    );
    // Every upload went through the batch's own presign, never the default one.
    expect(uploads).toHaveLength(3);
    for (const u of uploads) expect(u.options).toEqual({ presign: expect.any(Function) });
    const recorded = h.record.mock.calls.map((c) => (c[0] as { blobKey: string }).blobKey).sort();
    expect(recorded).toEqual(['1', '2', '3'].map((n) => `${n.padStart(32, '0')}.wav`));
    for (const c of h.record.mock.calls)
      expect(c[0]).toMatchObject({ blockToken: 'tok_abc', batchId: 91 });
  });

  test('the batch’s presign mints through the batch procedure', async () => {
    const replies = await mountReady();
    h.upload.mockImplementationOnce(
      async (_blob: Blob, options: { presign: () => Promise<unknown> }) => {
        await options.presign();
        return { id: `${'f'.repeat(32)}.wav`, url: 'blob:x', available: true };
      }
    );
    postFromBlock('OPEN_MEDIA_UPLOAD_BATCH', batch('rq_presign', wavs(1)));
    await confirm();
    await oneReply(replies, 'rq_presign');
    expect(h.presign).toHaveBeenCalledWith({ blockToken: 'tok_abc', batchId: 91, index: 0 });
  });
});

describe('PageBlockHost OPEN_MEDIA_UPLOAD_BATCH — validation, scan and limits', () => {
  test('each item is checked as a single upload is: a bad one is refused alone, and not counted in the confirm', async () => {
    const replies = await mountReady();
    postFromBlock(
      'OPEN_MEDIA_UPLOAD_BATCH',
      batch('rq_mixed', [
        { kind: 'audio', bytes: WAV.slice(0) },
        { kind: 'image', bytes: GIF.slice(0) },
        { kind: 'audio', bytes: WAV.slice(0), mimeType: 'audio/mpeg' },
        { kind: 'audio', bytes: WAV.slice(0) },
      ])
    );
    await expect.element(page.getByText(/^Upload 2 audio files /)).toBeVisible();
    await confirm();
    const reply = await oneReply(replies, 'rq_mixed');
    const results = reply.results as Array<Record<string, unknown>>;
    expect(results.map((r) => r.error ?? 'ok')).toEqual([
      'ok',
      'images must be PNG, JPEG or WebP',
      "mimeType does not match the file's content",
      'ok',
    ]);
    expect(h.start.mock.calls[0][0].items).toHaveLength(2);
    expect(uploads).toHaveLength(2);
  });

  test('no valid item: answered per item at once, with no confirm and no batch', async () => {
    const replies = await mountReady();
    postFromBlock(
      'OPEN_MEDIA_UPLOAD_BATCH',
      batch('rq_none', [{ kind: 'image', bytes: GIF.slice(0) }])
    );
    const reply = await oneReply(replies, 'rq_none');
    expectReplyKeys('OPEN_MEDIA_UPLOAD_BATCH', 'success', ['results'], reply);
    expect(reply.results).toEqual([{ index: 0, error: 'images must be PNG, JPEG or WebP' }]);
    expect(h.start).not.toHaveBeenCalled();
  });

  test('a file the content scan blocks is refused for that item, and never recorded or handed over', async () => {
    const replies = await mountReady();
    h.upload.mockImplementationOnce(async () => ({
      id: `${'b'.repeat(32)}.wav`,
      url: 'blob:blocked',
      available: false,
      blockedReason: 'x',
    }));
    postFromBlock('OPEN_MEDIA_UPLOAD_BATCH', batch('rq_blocked', wavs(1)));
    await confirm();
    const reply = await oneReply(replies, 'rq_blocked');
    expect(reply.results).toEqual([
      { index: 0, error: 'this audio was refused by the upload service' },
    ]);
    expect(h.record).not.toHaveBeenCalled();
  });

  test('a batch the server refuses (the daily quota) uploads nothing and relays the reason', async () => {
    const replies = await mountReady();
    const quota =
      "You've reached today's batch upload limit (1,200 files or 10 GB). It resets at midnight UTC.";
    h.start.mockRejectedValueOnce(
      Object.assign(new Error(quota), { data: { code: 'TOO_MANY_REQUESTS', httpStatus: 429 } })
    );
    postFromBlock('OPEN_MEDIA_UPLOAD_BATCH', batch('rq_quota', wavs(2)));
    await confirm();
    const reply = await oneReply(replies, 'rq_quota');
    expectReplyKeys('OPEN_MEDIA_UPLOAD_BATCH', 'error', ['error'], reply);
    expect(reply).toEqual({ requestId: 'rq_quota', error: quota });
    expect(h.upload).not.toHaveBeenCalled();
  });

  test('with no block token the batch is refused before any confirm', async () => {
    const replies = await mountReady({ token: null });
    postFromBlock('OPEN_MEDIA_UPLOAD_BATCH', batch('rq_tok', wavs(1)));
    expect(await oneReply(replies, 'rq_tok')).toEqual({
      requestId: 'rq_tok',
      error: 'no block token',
    });
    expect(h.start).not.toHaveBeenCalled();
  });

  test('review mode answers bare and asks nothing', async () => {
    const replies = await mountReady({ reviewMode: true });
    postFromBlock('OPEN_MEDIA_UPLOAD_BATCH', batch('rq_review', wavs(1)));
    expect(await oneReply(replies, 'rq_review')).toEqual({ requestId: 'rq_review' });
    expect(h.start).not.toHaveBeenCalled();
  });

  test(`uploads at most 3 files at once`, async () => {
    const replies = await mountReady();
    const pending: Array<() => void> = [];
    holdUploads = (release) => pending.push(release);
    postFromBlock('OPEN_MEDIA_UPLOAD_BATCH', batch('rq_conc', wavs(7)));
    await confirm();
    // Drain one at a time; the host refills to its bound each time.
    for (let released = 0; released < 7; released++) {
      await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0), { timeout: 10_000 });
      await new Promise((r) => setTimeout(r, 100));
      expect(inFlight).toBeLessThanOrEqual(3);
      pending.shift()!();
    }
    const reply = await oneReply(replies, 'rq_conc');
    expect((reply.results as unknown[]).length).toBe(7);
    expect(peakInFlight).toBe(3);
  });

  test('has no per-minute window — 12 files upload — and the single-upload window is unchanged', async () => {
    const replies = await mountReady();
    postFromBlock('OPEN_MEDIA_UPLOAD_BATCH', batch('rq_many', wavs(12)));
    await confirm();
    const reply = await oneReply(replies, 'rq_many');
    expect((reply.results as Array<Record<string, unknown>>).every((r) => 'selected' in r)).toBe(
      true
    );
    // The batch took nothing from the single bytes window: 8 still go through, the 9th is busy.
    for (let i = 0; i < 9; i++) {
      postFromBlock('OPEN_MEDIA_UPLOAD', {
        requestId: `rq_single_${i}`,
        kind: 'audio',
        purpose: 'generationSource',
        bytes: WAV.slice(0),
      });
    }
    const singles = [];
    for (let i = 0; i < 9; i++)
      singles.push(await oneReply(replies, `rq_single_${i}`, 'MEDIA_UPLOAD_RESULT'));
    expect(singles.slice(0, 8).every((r) => 'selected' in r)).toBe(true);
    expect(singles[8]).toEqual({ requestId: 'rq_single_8', error: 'busy' });
  });

  test('a second batch while one is running is refused busy', async () => {
    const replies = await mountReady();
    postFromBlock('OPEN_MEDIA_UPLOAD_BATCH', batch('rq_first', wavs(1)));
    await expect.element(confirmButton()).toBeVisible();
    postFromBlock('OPEN_MEDIA_UPLOAD_BATCH', batch('rq_second', wavs(1)));
    expect(await oneReply(replies, 'rq_second')).toEqual({ requestId: 'rq_second', error: 'busy' });
  });
});

describe('PageBlockHost OPEN_MEDIA_UPLOAD_BATCH — a batch that outlives its token', () => {
  /** The token each call of `fn` was made with, in call order. */
  const tokensOf = (fn: typeof h.record) =>
    fn.mock.calls.map((c) => (c[0] as { blockToken: string }).blockToken);

  test('calls made after the host refreshes its token use the NEW token', async () => {
    const replies = await mountReady();
    const pending: Array<() => void> = [];
    holdUploads = (release) => pending.push(release);
    // Each upload mints its URL through the batch presign, as the real upload does.
    h.upload.mockImplementation(
      async (blob: Blob, options: { presign: () => Promise<unknown> }) => {
        await options.presign();
        const n = uploads.push({ blob, options });
        if (holdUploads) await new Promise<void>((resolve) => holdUploads!(resolve));
        return { id: `${String(n).padStart(32, '0')}.wav`, url: 'blob:x', available: true };
      }
    );
    postFromBlock('OPEN_MEDIA_UPLOAD_BATCH', batch('rq_refresh', wavs(5)));
    await confirm();
    await vi.waitFor(() => expect(pending.length).toBe(3), { timeout: 10_000 });
    // The host's token refresh lands while the first three uploads are in flight.
    await mounted!.rerender(
      <>
        <PageBlockHost {...baseProps} token="tok_refreshed" />
        <DialogProvider />
      </>
    );
    holdUploads = null;
    pending.splice(0).forEach((release) => release());
    const reply = await oneReply(replies, 'rq_refresh');
    expect((reply.results as Array<Record<string, unknown>>).every((r) => 'selected' in r)).toBe(
      true
    );
    expect(tokensOf(h.start)).toEqual(['tok_abc']);
    // The first three presigns ran before the refresh; the last two after it.
    expect(tokensOf(h.presign)).toEqual([
      'tok_abc',
      'tok_abc',
      'tok_abc',
      'tok_refreshed',
      'tok_refreshed',
    ]);
    // Every record ran after the refresh.
    expect(tokensOf(h.record)).toEqual(new Array(5).fill('tok_refreshed'));
  });

  test('a call refused UNAUTHORIZED is retried once with the token read again', async () => {
    const replies = await mountReady();
    h.record.mockRejectedValueOnce(
      Object.assign(new Error('invalid block token'), {
        data: { code: 'UNAUTHORIZED', httpStatus: 401 },
      })
    );
    postFromBlock('OPEN_MEDIA_UPLOAD_BATCH', batch('rq_401', wavs(1)));
    await confirm();
    const reply = await oneReply(replies, 'rq_401');
    expect(reply.results).toEqual([
      { index: 0, selected: expect.objectContaining({ kind: 'audio' }) },
    ]);
    expect(h.record).toHaveBeenCalledTimes(2);
  });
});

describe('PageBlockHost OPEN_MEDIA_UPLOAD_BATCH — recording an uploaded file', () => {
  const serverError = () =>
    Object.assign(new Error('Internal server error'), {
      data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500 },
    });

  test('a record that fails with a server error is retried, and the file handed over once it lands', async () => {
    const replies = await mountReady();
    h.record
      .mockRejectedValueOnce(serverError())
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    postFromBlock('OPEN_MEDIA_UPLOAD_BATCH', batch('rq_rec_retry', wavs(1)));
    await confirm();
    const reply = await oneReply(replies, 'rq_rec_retry');
    expect(reply.results).toEqual([
      { index: 0, selected: expect.objectContaining({ kind: 'audio' }) },
    ]);
    expect(h.record).toHaveBeenCalledTimes(3);
  });

  test('after 3 failed attempts the item is an error, and the file is not handed over', async () => {
    const replies = await mountReady();
    h.record.mockRejectedValue(serverError());
    postFromBlock('OPEN_MEDIA_UPLOAD_BATCH', batch('rq_rec_fail', wavs(1)));
    await confirm();
    const reply = await oneReply(replies, 'rq_rec_fail');
    expect(reply.results).toEqual([{ index: 0, error: 'media upload failed — please try again' }]);
    expect(h.record).toHaveBeenCalledTimes(3);
  });

  test('a record the server refuses (not a server error) is not retried', async () => {
    const replies = await mountReady();
    h.record.mockRejectedValue(
      Object.assign(new Error('this batch cannot record more files'), {
        data: { code: 'FORBIDDEN', httpStatus: 403 },
      })
    );
    postFromBlock('OPEN_MEDIA_UPLOAD_BATCH', batch('rq_rec_403', wavs(1)));
    await confirm();
    await oneReply(replies, 'rq_rec_403');
    expect(h.record).toHaveBeenCalledTimes(1);
  });

  test('each presign names its file’s position in the batch the server was told about', async () => {
    const replies = await mountReady();
    h.upload.mockImplementation(
      async (_blob: Blob, options: { presign: () => Promise<unknown> }) => {
        await options.presign();
        return { id: `${'c'.repeat(32)}.wav`, url: 'blob:x', available: true };
      }
    );
    // The GIF is refused before the batch starts, so the server's items are the three WAVs.
    postFromBlock(
      'OPEN_MEDIA_UPLOAD_BATCH',
      batch('rq_index', [
        { kind: 'audio', bytes: WAV.slice(0) },
        { kind: 'image', bytes: GIF.slice(0) },
        { kind: 'audio', bytes: WAV.slice(0) },
        { kind: 'audio', bytes: WAV.slice(0) },
      ])
    );
    await confirm();
    await oneReply(replies, 'rq_index');
    const indexes = h.presign.mock.calls.map((c) => (c[0] as { index: number }).index).sort();
    expect(indexes).toEqual([0, 1, 2]);
  });
});
