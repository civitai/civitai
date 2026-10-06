// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { reportApplicationError } = vi.hoisted(() => ({
  reportApplicationError: vi.fn(() => Promise.resolve(undefined)),
}));
vi.mock('~/utils/application-error', () => ({ reportApplicationError }));

import { uploadConsumerBlob } from '~/utils/consumer-blob-upload';

const PRESIGN_PATH = '/api/orchestrator/getConsumerBlobUploadUrl';
// Upper bound of getPartRetryDelay's first backoff (1s + up to 1s jitter).
const BACKOFF_MS = 2_000;

class FakeXHR {
  static instances: FakeXHR[] = [];
  status = 0;
  statusText = '';
  responseText = '';
  aborted = false;
  method = '';
  url = '';
  body: unknown;
  private listeners: Record<string, (() => void)[]> = {};
  upload = {
    listeners: {} as Record<string, (() => void)[]>,
    addEventListener(type: string, cb: () => void) {
      (this.listeners[type] ??= []).push(cb);
    },
  };
  constructor() {
    FakeXHR.instances.push(this);
  }
  addEventListener(type: string, cb: () => void) {
    (this.listeners[type] ??= []).push(cb);
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader() {
    return undefined;
  }
  getResponseHeader() {
    return null;
  }
  send(body: unknown) {
    this.body = body;
  }
  abort() {
    this.aborted = true;
    this.status = 0;
    this.emit('loadend');
  }
  progress() {
    this.upload.listeners['progress']?.forEach((cb) => cb());
  }
  bodySent() {
    this.upload.listeners['load']?.forEach((cb) => cb());
  }
  /** A dropped connection: status 0 with no abort. */
  fail() {
    this.status = 0;
    this.emit('loadend');
  }
  respond(status: number, body: string) {
    this.bodySent();
    this.status = status;
    this.responseText = body;
    this.emit('loadend');
  }
  private emit(type: string) {
    this.listeners[type]?.forEach((cb) => cb());
  }
}

let presignMode: 'ok' | 'hang' | 'fail-once';
let presignCount: number;
const fetchMock = vi.fn((url: string, init?: RequestInit) => {
  if (url === PRESIGN_PATH) {
    presignCount++;
    if (presignMode === 'hang')
      return new Promise((_, reject) =>
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError'))
        )
      );
    if (presignMode === 'fail-once' && presignCount === 1)
      return Promise.resolve({ ok: false, status: 503, headers: new Headers() });
    const uploadUrl = `https://upload.test/blob?sig=${presignCount}`;
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ uploadUrl }) });
  }
  // Tripwire: a body sent through fetch never settles, so a return to fetch fails the stall cases.
  return new Promise(() => undefined);
});

function track<T>(p: Promise<T>) {
  const state: { settled: boolean; value?: T; error?: Error } = { settled: false };
  p.then(
    (value) => Object.assign(state, { settled: true, value }),
    (error) => Object.assign(state, { settled: true, error })
  );
  return state;
}

const jpeg = () => new Blob([new Uint8Array(1024)], { type: 'image/jpeg' });
const kinds = () => reportApplicationError.mock.calls.map((c) => (c[0] as Error).message);

beforeEach(() => {
  vi.useFakeTimers();
  FakeXHR.instances = [];
  presignMode = 'ok';
  presignCount = 0;
  fetchMock.mockClear();
  reportApplicationError.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('XMLHttpRequest', FakeXHR);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('uploadConsumerBlob', () => {
  it('POSTs the blob to the presigned URL and resolves with the response', async () => {
    const blob = jpeg();
    const result = track(uploadConsumerBlob(blob));
    await vi.advanceTimersByTimeAsync(0);
    const xhr = FakeXHR.instances[0];
    expect([xhr.method, xhr.url]).toEqual(['POST', 'https://upload.test/blob?sig=1']);
    expect(xhr.body).toBe(blob);

    xhr.respond(200, JSON.stringify({ id: 'b1', url: 'https://blob/1' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(result.value).toEqual({ id: 'b1', url: 'https://blob/1' });
    expect(reportApplicationError).not.toHaveBeenCalled();
  });

  it('aborts a stalled upload and retries it once with a fresh presigned URL', async () => {
    const result = track(uploadConsumerBlob(jpeg()));
    await vi.advanceTimersByTimeAsync(29_999);
    expect(FakeXHR.instances[0].aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1 + BACKOFF_MS);

    expect(presignCount).toBe(2);
    expect(FakeXHR.instances[0].aborted).toBe(true);
    expect(FakeXHR.instances[1].url).toBe('https://upload.test/blob?sig=2');

    FakeXHR.instances[1].respond(200, JSON.stringify({ id: 'b2' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(result.value).toEqual({ id: 'b2' });
    expect(kinds()).toEqual(['consumer blob upload failed: stalled']);
  });

  it('does not abort an upload that keeps reporting progress', async () => {
    track(uploadConsumerBlob(jpeg()));
    await vi.advanceTimersByTimeAsync(20_000);
    FakeXHR.instances[0].progress();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(FakeXHR.instances[0].aborted).toBe(false);
  });

  it('throws once the retry stalls too', async () => {
    const result = track(uploadConsumerBlob(jpeg()));
    await vi.advanceTimersByTimeAsync(30_000 + BACKOFF_MS + 30_000);

    expect(result.settled).toBe(true);
    expect(result.error?.message).toMatch(/Upload stalled/);
    expect(FakeXHR.instances).toHaveLength(2);
    expect(kinds()).toEqual([
      'consumer blob upload failed: stalled',
      'consumer blob upload failed: stalled',
    ]);
  });

  it('retries a dropped connection', async () => {
    const result = track(uploadConsumerBlob(jpeg()));
    await vi.advanceTimersByTimeAsync(0);
    FakeXHR.instances[0].fail();
    await vi.advanceTimersByTimeAsync(BACKOFF_MS);
    FakeXHR.instances[1].respond(200, JSON.stringify({ id: 'b2' }));
    await vi.advanceTimersByTimeAsync(0);

    expect(result.value).toEqual({ id: 'b2' });
    expect(kinds()).toEqual(['consumer blob upload failed: network-error']);
  });

  it('gives a sent body a wider window, then reports a response stall', async () => {
    track(uploadConsumerBlob(jpeg()));
    await vi.advanceTimersByTimeAsync(0);
    FakeXHR.instances[0].bodySent();
    await vi.advanceTimersByTimeAsync(45_000);
    expect(FakeXHR.instances[0].aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(15_000);

    expect(FakeXHR.instances[0].aborted).toBe(true);
    expect(kinds()).toEqual(['consumer blob upload failed: response-stalled']);
  });

  it('retries a 5xx response', async () => {
    const result = track(uploadConsumerBlob(jpeg()));
    await vi.advanceTimersByTimeAsync(0);
    FakeXHR.instances[0].respond(503, 'unavailable');
    await vi.advanceTimersByTimeAsync(BACKOFF_MS);
    FakeXHR.instances[1].respond(200, JSON.stringify({ id: 'b2' }));
    await vi.advanceTimersByTimeAsync(0);

    expect(result.value).toEqual({ id: 'b2' });
    expect(kinds()).toEqual(['consumer blob upload failed: http-503']);
  });

  it('does not retry a 422 rejection', async () => {
    const result = track(uploadConsumerBlob(jpeg()));
    await vi.advanceTimersByTimeAsync(0);
    FakeXHR.instances[0].respond(422, 'bad image');
    await vi.advanceTimersByTimeAsync(BACKOFF_MS);

    expect(result.error?.message).toBe('Failed to upload blob: bad image');
    expect(FakeXHR.instances).toHaveLength(1);
    expect(presignCount).toBe(1);
    expect(kinds()).toEqual(['consumer blob upload failed: http-422']);
  });

  it('retries a presign 5xx', async () => {
    presignMode = 'fail-once';
    const result = track(uploadConsumerBlob(jpeg()));
    await vi.advanceTimersByTimeAsync(BACKOFF_MS);
    FakeXHR.instances[0].respond(200, JSON.stringify({ id: 'b1' }));
    await vi.advanceTimersByTimeAsync(0);

    expect(result.value).toEqual({ id: 'b1' });
    expect(kinds()).toEqual(['consumer blob upload failed: presign-http-503']);
  });

  it('times out a hung presign request and throws after one retry', async () => {
    presignMode = 'hang';
    const result = track(uploadConsumerBlob(jpeg()));
    await vi.advanceTimersByTimeAsync(15_000 + BACKOFF_MS + 15_000);

    expect(result.settled).toBe(true);
    expect(result.error?.message).toMatch(/Timed out preparing the upload/);
    expect(presignCount).toBe(2);
    expect(FakeXHR.instances).toHaveLength(0);
    expect(kinds()).toEqual([
      'consumer blob upload failed: presign-timeout',
      'consumer blob upload failed: presign-timeout',
    ]);
  });
});
