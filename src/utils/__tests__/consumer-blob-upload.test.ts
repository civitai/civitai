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
  headers: Record<string, string> = {};
  getResponseHeader(name: string) {
    return this.headers[name] ?? null;
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
  respond(status: number, body: string, headers: Record<string, string> = {}) {
    this.bodySent();
    this.headers = headers;
    this.status = status;
    this.responseText = body;
    this.emit('loadend');
  }
  private emit(type: string) {
    this.listeners[type]?.forEach((cb) => cb());
  }
}

let presignMode: 'ok' | 'hang' | 'unavailable-once' | 'throttle-once' | 'rejected';
let rejectedStatus: number;
let presignCount: number;
// The first N presigns fail before `presignMode` applies: an upstream outage.
let presignOutage: { failures: number; as: 'http-502' | 'network-error'; afterMs?: number };
const fetchMock = vi.fn((url: string, init?: RequestInit) => {
  if (url === PRESIGN_PATH) {
    presignCount++;
    if (presignCount <= presignOutage.failures) {
      const fail = () =>
        presignOutage.as === 'http-502'
          ? Promise.resolve({ ok: false, status: 502, headers: new Headers() })
          : Promise.reject(new TypeError('Failed to fetch'));
      const after = presignOutage.afterMs;
      return after ? new Promise((r) => setTimeout(r, after)).then(fail) : fail();
    }
    if (presignMode === 'hang')
      return new Promise((_, reject) =>
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError'))
        )
      );
    if (presignMode === 'unavailable-once' && presignCount === 1)
      return Promise.resolve({ ok: false, status: 502, headers: new Headers() });
    if (presignMode === 'throttle-once' && presignCount === 1)
      return Promise.resolve({
        ok: false,
        status: 429,
        headers: new Headers({ 'Retry-After': '5' }),
      });
    if (presignMode === 'rejected')
      return Promise.resolve({
        ok: false,
        status: rejectedStatus,
        headers: new Headers(),
        text: async () => 'Not allowed',
      });
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
const mp4 = () => new Blob([new Uint8Array(1024)], { type: 'video/mp4' });
const kinds = () => reportApplicationError.mock.calls.map((c) => (c[0] as Error).message);
const attempts = () =>
  reportApplicationError.mock.calls.map((c) => (c as unknown[])[1] as { message: string });
// Upper bound of each presign retry wait (its delay plus up to 1s jitter).
const PRESIGN_WAITS_MS = [3_000, 7_000, 13_000, 21_000];

beforeEach(() => {
  vi.useFakeTimers();
  FakeXHR.instances = [];
  presignMode = 'ok';
  presignCount = 0;
  presignOutage = { failures: 0, as: 'http-502' };
  fetchMock.mockClear();
  reportApplicationError.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('XMLHttpRequest', FakeXHR);
});

afterEach(() => {
  vi.restoreAllMocks();
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
    await vi.advanceTimersByTimeAsync(29_999);
    expect(FakeXHR.instances[0].aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeXHR.instances[0].aborted).toBe(true);
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

  it.each([
    ['image', jpeg],
    ['video', mp4],
  ])(
    'fails a %s upload whose sent body gets no reply in 5 min, without retrying',
    async (_, make) => {
      const result = track(uploadConsumerBlob(make()));
      await vi.advanceTimersByTimeAsync(0);
      FakeXHR.instances[0].bodySent();
      await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
      expect(FakeXHR.instances[0].aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1 + BACKOFF_MS);

      expect(FakeXHR.instances[0].aborted).toBe(true);
      expect([FakeXHR.instances.length, presignCount]).toEqual([1, 1]);
      expect(result.error?.message).toMatch(/Timed out waiting for the server/);
      expect(kinds()).toEqual(['consumer blob upload failed: response-stalled']);
    }
  );

  it('retries a 5xx response', async () => {
    const result = track(uploadConsumerBlob(jpeg()));
    await vi.advanceTimersByTimeAsync(0);
    FakeXHR.instances[0].respond(503, 'unavailable');
    // The minimum backoff is 1s; no retry may start before it.
    await vi.advanceTimersByTimeAsync(999);
    expect([FakeXHR.instances.length, presignCount]).toEqual([1, 1]);
    await vi.advanceTimersByTimeAsync(BACKOFF_MS - 999);
    FakeXHR.instances[1].respond(200, JSON.stringify({ id: 'b2' }));
    await vi.advanceTimersByTimeAsync(0);

    expect(result.value).toEqual({ id: 'b2' });
    expect(kinds()).toEqual(['consumer blob upload failed: http-503']);
  });

  // Parsing only: cross-origin, a browser exposes Retry-After only if the upload host lists it in
  // Access-Control-Expose-Headers.
  it('retries a throttled upload after its Retry-After', async () => {
    const result = track(uploadConsumerBlob(jpeg()));
    await vi.advanceTimersByTimeAsync(0);
    FakeXHR.instances[0].respond(429, 'slow down', { 'Retry-After': '5' });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(FakeXHR.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    FakeXHR.instances[1].respond(200, JSON.stringify({ id: 'b2' }));
    await vi.advanceTimersByTimeAsync(0);

    expect(result.value).toEqual({ id: 'b2' });
    expect(kinds()).toEqual(['consumer blob upload failed: http-429']);
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

  it('retries a presign 5xx without reporting it once the retry succeeds', async () => {
    presignMode = 'unavailable-once';
    const result = track(uploadConsumerBlob(jpeg()));
    await vi.advanceTimersByTimeAsync(PRESIGN_WAITS_MS[0]);
    FakeXHR.instances[0].respond(200, JSON.stringify({ id: 'b1' }));
    await vi.advanceTimersByTimeAsync(0);

    expect(result.value).toEqual({ id: 'b1' });
    expect(presignCount).toBe(2);
    expect(reportApplicationError).not.toHaveBeenCalled();
  });

  it.each(['http-502', 'network-error'] as const)(
    'rides out a ~35 s presign outage (%s) and uploads with no failure report',
    async (as) => {
      const start = Date.now();
      // Four failures: the fifth try, after waits of 2+6+12+20 s, succeeds.
      presignOutage = { failures: 4, as };
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const result = track(uploadConsumerBlob(jpeg()));
      // The try count just before and at each cumulative wait boundary, with no jitter.
      const counts: number[] = [];
      for (const at of [1_999, 2_000, 7_999, 8_000, 19_999, 20_000, 39_999, 40_000]) {
        await vi.advanceTimersByTimeAsync(at - Date.now() + start);
        counts.push(presignCount);
      }
      expect(counts).toEqual([1, 2, 2, 3, 3, 4, 4, 5]);

      expect(presignCount).toBe(5);
      expect(FakeXHR.instances).toHaveLength(1);
      FakeXHR.instances[0].respond(200, JSON.stringify({ id: 'b1' }));
      await vi.advanceTimersByTimeAsync(0);

      expect(result.value).toEqual({ id: 'b1' });
      expect(reportApplicationError).not.toHaveBeenCalled();
    }
  );

  it('starts no presign try past the 50 s budget when each 5xx arrives slowly', async () => {
    // Each 502 takes 14 s, just under the timeout: tries start at 0, 16 and 36 s; a fourth
    // would start at 62 s, past the budget, so the third failure at 50 s is the last.
    presignOutage = { failures: Infinity, as: 'http-502', afterMs: 14_000 };
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const result = track(uploadConsumerBlob(jpeg()));
    await vi.advanceTimersByTimeAsync(49_999);
    expect(result.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(result.error?.message).toBe('Failed to get upload URL');
    expect(presignCount).toBe(3);
    expect(kinds()).toEqual(['consumer blob upload failed: presign-http-502']);
  });

  it('reports presign-http-502 once, in the existing format, when the outage outlasts the retries', async () => {
    presignOutage = { failures: Infinity, as: 'http-502' };
    const result = track(uploadConsumerBlob(jpeg()));
    await vi.advanceTimersByTimeAsync(PRESIGN_WAITS_MS.reduce((a, b) => a + b) + 60_000);

    expect(result.error?.message).toBe('Failed to get upload URL');
    expect(presignCount).toBe(5);
    expect(FakeXHR.instances).toHaveLength(0);
    expect(kinds()).toEqual(['consumer blob upload failed: presign-http-502']);
    expect(attempts().map((a) => a.message)).toEqual(['attempt 1/2']);
  });

  it('retries a throttled presign after its Retry-After', async () => {
    presignMode = 'throttle-once';
    const result = track(uploadConsumerBlob(jpeg()));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(presignCount).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    FakeXHR.instances[0].respond(200, JSON.stringify({ id: 'b1' }));
    await vi.advanceTimersByTimeAsync(0);

    expect(result.value).toEqual({ id: 'b1' });
    expect(kinds()).toEqual(['consumer blob upload failed: presign-http-429']);
  });

  it.each([400, 403])(
    'shows the text of a %i presign rejection and does not retry',
    async (status) => {
      presignMode = 'rejected';
      rejectedStatus = status;
      const result = track(uploadConsumerBlob(jpeg()));
      // Past every presign retry wait, so a retried rejection would show.
      await vi.advanceTimersByTimeAsync(60_000);

      expect(result.error?.message).toBe('Not allowed');
      expect(presignCount).toBe(1);
      expect(kinds()).toEqual([`consumer blob upload failed: presign-http-${status}`]);
    }
  );

  it('tells a signed-out user to sign in on a 401 presign, reported once and not retried', async () => {
    presignMode = 'rejected';
    rejectedStatus = 401;
    const result = track(uploadConsumerBlob(jpeg()));
    await vi.advanceTimersByTimeAsync(60_000);

    expect(result.error?.message).toBe('Sign in to upload images.');
    expect(presignCount).toBe(1);
    expect(FakeXHR.instances).toHaveLength(0);
    expect(kinds()).toEqual(['consumer blob upload failed: presign-http-401']);
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
    // Unchanged from before the presign retries: a timeout keeps the single outer retry.
    expect(attempts().map((a) => a.message)).toEqual(['attempt 1/2', 'attempt 2/2']);
  });

  it('ends on a presign timeout that follows a presign retry, reporting it once', async () => {
    presignOutage = { failures: 1, as: 'http-502' };
    presignMode = 'hang';
    const result = track(uploadConsumerBlob(jpeg()));
    await vi.advanceTimersByTimeAsync(PRESIGN_WAITS_MS[0] + 15_000 + 60_000);

    expect(result.error?.message).toMatch(/Timed out preparing the upload/);
    expect(presignCount).toBe(2);
    expect(FakeXHR.instances).toHaveLength(0);
    expect(kinds()).toEqual(['consumer blob upload failed: presign-timeout']);
    expect(attempts().map((a) => a.message)).toEqual(['attempt 1/2']);
  });

  it('adds up to 1 s of jitter to each presign wait', async () => {
    presignOutage = { failures: 1, as: 'http-502' };
    vi.spyOn(Math, 'random').mockReturnValue(0.999);
    track(uploadConsumerBlob(jpeg()));
    await vi.advanceTimersByTimeAsync(2_998);
    expect(presignCount).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(presignCount).toBe(2);
  });

  it('runs the presign retries again for the second attempt after a body failure', async () => {
    const result = track(uploadConsumerBlob(jpeg()));
    await vi.advanceTimersByTimeAsync(0);
    // `failures` counts from the first presign: this fails the second (the first retry's) only.
    presignOutage = { failures: 2, as: 'http-502' };
    FakeXHR.instances[0].respond(503, 'unavailable');
    await vi.advanceTimersByTimeAsync(BACKOFF_MS + PRESIGN_WAITS_MS[0]);

    expect(presignCount).toBe(3);
    FakeXHR.instances[1].respond(200, JSON.stringify({ id: 'b2' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(result.value).toEqual({ id: 'b2' });
    expect(kinds()).toEqual(['consumer blob upload failed: http-503']);
  });
});
