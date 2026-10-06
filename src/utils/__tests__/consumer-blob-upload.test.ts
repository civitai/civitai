// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { reportApplicationError } = vi.hoisted(() => ({
  reportApplicationError: vi.fn(() => Promise.resolve(undefined)),
}));
vi.mock('~/utils/application-error', () => ({ reportApplicationError }));

import { uploadConsumerBlob } from '~/utils/consumer-blob-upload';

const PRESIGN_PATH = '/api/orchestrator/getConsumerBlobUploadUrl';

class FakeXHR {
  static instances: FakeXHR[] = [];
  status = 0;
  statusText = '';
  responseText = '';
  aborted = false;
  sent = false;
  url = '';
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
  open(_method: string, url: string) {
    this.url = url;
  }
  setRequestHeader() {
    // headers are not asserted
  }
  getResponseHeader() {
    return null;
  }
  send() {
    this.sent = true;
  }
  abort() {
    this.aborted = true;
    this.status = 0;
    this.listeners['loadend']?.forEach((cb) => cb());
  }
  respond(status: number, body: string) {
    this.upload.listeners['load']?.forEach((cb) => cb());
    this.status = status;
    this.responseText = body;
    this.listeners['loadend']?.forEach((cb) => cb());
  }
}

let presignMode: 'ok' | 'hang';
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
    const uploadUrl = `https://upload.test/blob?sig=${presignCount}`;
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ uploadUrl }) });
  }
  // A body upload issued through fetch never settles, which is what a stalled POST looks like.
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
  it('resolves with the blob the orchestrator returns', async () => {
    const result = track(uploadConsumerBlob(jpeg()));
    await vi.advanceTimersByTimeAsync(0);
    FakeXHR.instances[0].respond(200, JSON.stringify({ id: 'b1', url: 'https://blob/1' }));
    await vi.advanceTimersByTimeAsync(0);

    expect(result.value).toEqual({ id: 'b1', url: 'https://blob/1' });
    expect(FakeXHR.instances).toHaveLength(1);
    expect(reportApplicationError).not.toHaveBeenCalled();
  });

  it('aborts a stalled upload and retries it once with a fresh presigned URL', async () => {
    const result = track(uploadConsumerBlob(jpeg()));
    await vi.advanceTimersByTimeAsync(30_000);

    expect(presignCount).toBe(2);
    expect(FakeXHR.instances[0].aborted).toBe(true);
    expect(FakeXHR.instances).toHaveLength(2);
    expect(FakeXHR.instances[1].url).toBe('https://upload.test/blob?sig=2');

    FakeXHR.instances[1].respond(200, JSON.stringify({ id: 'b2' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(result.value).toEqual({ id: 'b2' });
    expect(kinds()).toEqual(['consumer blob upload failed: stalled']);
  });

  it('throws once the retry stalls too', async () => {
    const result = track(uploadConsumerBlob(jpeg()));
    await vi.advanceTimersByTimeAsync(60_000);

    expect(result.settled).toBe(true);
    expect(result.error?.message).toMatch(/Upload stalled/);
    expect(FakeXHR.instances).toHaveLength(2);
    expect(kinds()).toEqual([
      'consumer blob upload failed: stalled',
      'consumer blob upload failed: stalled',
    ]);
  });

  it('does not retry a 422 rejection', async () => {
    const result = track(uploadConsumerBlob(jpeg()));
    await vi.advanceTimersByTimeAsync(0);
    FakeXHR.instances[0].respond(422, 'bad image');
    await vi.advanceTimersByTimeAsync(0);

    expect(result.error?.message).toBe('Failed to upload blob: bad image');
    expect(FakeXHR.instances).toHaveLength(1);
    expect(presignCount).toBe(1);
    expect(kinds()).toEqual(['consumer blob upload failed: http-422']);
  });

  it('times out a hung presign request and throws after one retry', async () => {
    presignMode = 'hang';
    const result = track(uploadConsumerBlob(jpeg()));
    await vi.advanceTimersByTimeAsync(30_000);

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
