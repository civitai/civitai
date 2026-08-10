import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import { useS3UploadStore } from '~/store/s3-upload.store';
import { UploadType } from '~/server/common/enums';

/**
 * Regression cover for large-file uploads that transferred every byte and then
 * silently never produced a ModelFile row. Two distinct ways that happened:
 *
 *  - a part PUT answered with an HTTP status (403 on an expired presign, 429/5xx
 *    under load) fires neither 'error' nor 'abort', so the part promise never
 *    settled and the worker parked forever at ~100% with no error;
 *  - a non-ok /api/upload/complete response returned out of the store with no
 *    status change and no callback, so the row read as finished.
 *
 * Both scale with part count, which is why they showed up on 40GB+ files.
 */

const CHUNK = 1024;

/**
 * The identity `/api/upload` hands back and that every later call to
 * `/api/upload/{sign-part,complete,abort}` has to echo. Kept in one place so an
 * abort assertion checks the identity the server actually issued rather than a
 * literal retyped in the test.
 */
const UPLOAD_IDENTITY = {
  bucket: 'civitai-modelfiles',
  key: 'model/42/x.safetensors',
  uploadId: 'upload-1',
  backend: 'b2',
};

type PartResponse = { status: number; etag?: string; retryAfter?: string };

/** Body shape `POST /api/upload/abort` is called with. */
type AbortBody = {
  bucket: string;
  key: string;
  type: string;
  uploadId: string;
  backend: string;
};

let partHandler: (url: string, partNumber: number) => PartResponse;
let completeStatus: number;
/** Consumed before `completeStatus`, so a test can script the first N attempts. */
let completeStatusQueue: number[];
let signPartStatus: number;
let signedUrls: string[];
let completeCalls: number;
let abortCalls: AbortBody[];
/** Simulates the abort request itself failing at the network layer. */
let abortShouldReject: boolean;
/** Fires when `/api/upload/complete` is requested, to mutate state mid-flight. */
let onCompleteRequest: (() => void) | null;

class FakeXHR {
  readyState = 0;
  status = 0;
  private url = '';
  private headers: Record<string, string> = {};
  private listeners: Record<string, ((e: unknown) => void)[]> = {};
  private settled = false;

  upload = {
    listeners: {} as Record<string, ((e: { loaded: number }) => void)[]>,
    addEventListener(type: string, cb: (e: { loaded: number }) => void) {
      (this.listeners[type] ??= []).push(cb);
    },
  };

  addEventListener(type: string, cb: (e: unknown) => void) {
    (this.listeners[type] ??= []).push(cb);
  }
  open(_method: string, url: string) {
    this.url = url;
  }
  setRequestHeader() {
    // no-op
  }
  getResponseHeader(name: string) {
    return this.headers[name] ?? null;
  }
  abort() {
    if (this.settled) return;
    this.settled = true;
    this.readyState = 4;
    this.status = 0;
    this.emit('abort');
  }
  send(body: Blob) {
    setTimeout(() => {
      if (this.settled) return;
      this.settled = true;
      const partNumber = Number(new URL(this.url, 'https://b2.test').searchParams.get('part'));
      const res = partHandler(this.url, partNumber);
      this.readyState = 4;
      this.status = res.status;
      if (res.etag) this.headers['ETag'] = res.etag;
      if (res.retryAfter) this.headers['Retry-After'] = res.retryAfter;
      this.upload.listeners['progress']?.forEach((cb) => cb({ loaded: body.size }));
      this.upload.listeners['loadend']?.forEach((cb) => cb({ loaded: body.size }));
      this.emit('load');
      this.emit('loadend');
    }, 0);
  }
  private emit(type: string) {
    this.listeners[type]?.forEach((cb) => cb({}));
  }
}

function partUrl(partNumber: number, version = 0) {
  return `https://b2.test/upload?part=${partNumber}&v=${version}`;
}

function makeFetch(partCount: number) {
  return vi.fn(async (url: string, init?: { body?: string }) => {
    if (url === '/api/upload') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ...UPLOAD_IDENTITY,
          chunkSize: CHUNK,
          urls: Array.from({ length: partCount }, (_, i) => ({
            url: partUrl(i + 1),
            partNumber: i + 1,
          })),
        }),
      };
    }
    if (url === '/api/upload/sign-part') {
      const body = JSON.parse(init?.body ?? '{}') as { partNumber: number };
      const fresh = partUrl(body.partNumber, 1);
      signedUrls.push(fresh);
      return {
        ok: signPartStatus === 200,
        status: signPartStatus,
        json: async () => ({ url: fresh }),
      };
    }
    if (url === '/api/upload/complete') {
      completeCalls++;
      onCompleteRequest?.();
      const status = completeStatusQueue.shift() ?? completeStatus;
      return { ok: status === 200, status, json: async () => null };
    }
    if (url === '/api/upload/abort') {
      abortCalls.push(JSON.parse(init?.body ?? '{}') as AbortBody);
      // The store fire-and-forgets this response, so only a rejected request can
      // surface as a throw — which is what `abortShouldReject` reproduces.
      if (abortShouldReject) throw new TypeError('Failed to fetch');
      return { ok: true, status: 200, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => null };
  });
}

function makeFile(bytes: number) {
  return new File([new Uint8Array(bytes)], 'model.safetensors');
}

beforeEach(() => {
  useS3UploadStore.setState({ items: [] });
  completeStatus = 200;
  completeStatusQueue = [];
  signPartStatus = 200;
  signedUrls = [];
  completeCalls = 0;
  abortCalls = [];
  abortShouldReject = false;
  onCompleteRequest = null;
  partHandler = () => ({ status: 200, etag: 'etag' });
  vi.stubGlobal('XMLHttpRequest', FakeXHR);
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useS3UploadStore.upload', () => {
  it('slices by the chunk size the server signed against, not a client constant', async () => {
    vi.stubGlobal('fetch', makeFetch(3));
    const seen: number[] = [];
    partHandler = (_url, partNumber) => {
      seen.push(partNumber);
      return { status: 200, etag: 'etag' };
    };

    const result = await useS3UploadStore.getState().upload({
      file: makeFile(CHUNK * 3),
      type: UploadType.Model,
    });

    expect(result).toBeTruthy();
    expect(seen.sort()).toEqual([1, 2, 3]);
  });

  it('does not hang when a part answers with an HTTP status instead of a network error', async () => {
    vi.stubGlobal('fetch', makeFetch(2));
    // 400 is neither retryable nor an expiry — the part must reject and fail the
    // upload rather than leaving the worker awaiting a promise that never settles.
    partHandler = (_url, partNumber) =>
      partNumber === 2 ? { status: 400 } : { status: 200, etag: 'etag' };

    const result = await useS3UploadStore.getState().upload({
      file: makeFile(CHUNK * 2),
      type: UploadType.Model,
    });

    expect(result).toBeUndefined();
    expect(useS3UploadStore.getState().items[0].status).toBe('error');
  });

  it('re-signs and retries a part whose presigned URL expired', async () => {
    vi.stubGlobal('fetch', makeFetch(2));
    partHandler = (url, partNumber) => {
      // Part 2's original URL is past its expiry; the re-signed one works.
      if (partNumber === 2 && !url.includes('v=1')) return { status: 403 };
      return { status: 200, etag: 'etag' };
    };

    const result = await useS3UploadStore.getState().upload({
      file: makeFile(CHUNK * 2),
      type: UploadType.Model,
    });

    expect(signedUrls).toEqual([partUrl(2, 1)]);
    expect(result).toBeTruthy();
    expect(useS3UploadStore.getState().items[0].status).toBe('success');
  });

  it('gives up on an expired part when re-signing fails, rather than looping', async () => {
    vi.stubGlobal('fetch', makeFetch(1));
    signPartStatus = 500;
    partHandler = () => ({ status: 403 });

    const result = await useS3UploadStore.getState().upload({
      file: makeFile(CHUNK),
      type: UploadType.Model,
    });

    expect(result).toBeUndefined();
    expect(useS3UploadStore.getState().items[0].status).toBe('error');
  });

  it('retries a transient complete failure and reports the file on success', async () => {
    vi.stubGlobal('fetch', makeFetch(1));
    completeStatusQueue = [503];
    const cb = vi.fn();

    const result = await useS3UploadStore
      .getState()
      .upload({ file: makeFile(CHUNK), type: UploadType.Model }, cb);

    expect(completeCalls).toBe(2);
    expect(result).toBeTruthy();
    expect(cb).toHaveBeenCalledOnce();
  });

  it('marks the file errored when complete never succeeds, instead of returning silently', async () => {
    vi.stubGlobal('fetch', makeFetch(1));
    completeStatus = 503;
    const cb = vi.fn();

    const result = await useS3UploadStore
      .getState()
      .upload({ file: makeFile(CHUNK), type: UploadType.Model }, cb);

    expect(result).toBeUndefined();
    expect(cb).not.toHaveBeenCalled();
    expect(useS3UploadStore.getState().items[0].status).toBe('error');
  });

  it('treats a terminal 409 from complete as final without retrying', async () => {
    vi.stubGlobal('fetch', makeFetch(1));
    completeStatus = 409;

    const result = await useS3UploadStore
      .getState()
      .upload({ file: makeFile(CHUNK), type: UploadType.Model });

    expect(completeCalls).toBe(1);
    expect(result).toBeUndefined();
    expect(useS3UploadStore.getState().items[0].status).toBe('error');
  });
});

/**
 * Every give-up path that runs after the server has issued an upload id owes it a
 * teardown. Without one the multipart session stays open forever — nothing else
 * ever closes it — and the parts already transferred keep occupying storage with
 * no way left to finalize them.
 *
 * The part-failure path always did this. Its sibling, the failed-completion path,
 * returned without aborting, so every failed completion leaked one session. These
 * assert the abort is actually issued, and issued for the right upload: a check
 * that only looked at the returned value or the row status passes with the leak
 * fully intact.
 */
describe('useS3UploadStore.upload multipart teardown', () => {
  const expectedAbort = { ...UPLOAD_IDENTITY, type: UploadType.Model };

  it('aborts the upload when completion fails terminally', async () => {
    vi.stubGlobal('fetch', makeFetch(1));
    completeStatus = 503;

    const result = await useS3UploadStore
      .getState()
      .upload({ file: makeFile(CHUNK), type: UploadType.Model });

    expect(result).toBeUndefined();
    expect(useS3UploadStore.getState().items[0].status).toBe('error');
    expect(abortCalls).toEqual([expectedAbort]);
  });

  it('aborts the upload when completion returns a terminal 422', async () => {
    // 422 = parts invalid/incomplete. The session is still live and holding every
    // part that was transferred, so this is the case that leaks the most.
    vi.stubGlobal('fetch', makeFetch(2));
    completeStatus = 422;

    await useS3UploadStore.getState().upload({ file: makeFile(CHUNK * 2), type: UploadType.Model });

    expect(completeCalls).toBe(1);
    expect(abortCalls).toEqual([expectedAbort]);
  });

  it('aborts the upload when completion returns a terminal 409', async () => {
    // 409 = already finalized or aborted. Aborting is idempotent server-side, so
    // this path abandons nothing by trying.
    vi.stubGlobal('fetch', makeFetch(1));
    completeStatus = 409;

    await useS3UploadStore.getState().upload({ file: makeFile(CHUNK), type: UploadType.Model });

    expect(abortCalls).toEqual([expectedAbort]);
  });

  // Invariant guard, not regression cover: this path already aborted. It pins the
  // behaviour the completion path above was made to match.
  it('aborts the upload when a part fails terminally', async () => {
    vi.stubGlobal('fetch', makeFetch(2));
    partHandler = (_url, partNumber) =>
      partNumber === 2 ? { status: 400 } : { status: 200, etag: 'etag' };

    await useS3UploadStore.getState().upload({ file: makeFile(CHUNK * 2), type: UploadType.Model });

    expect(useS3UploadStore.getState().items[0].status).toBe('error');
    expect(abortCalls).toEqual([expectedAbort]);
  });

  // Negative control: proves these assertions can distinguish abort from no-abort,
  // rather than passing because something always records a call.
  it('does not abort an upload that completed successfully', async () => {
    vi.stubGlobal('fetch', makeFetch(2));

    const result = await useS3UploadStore
      .getState()
      .upload({ file: makeFile(CHUNK * 2), type: UploadType.Model });

    expect(result).toBeTruthy();
    expect(abortCalls).toEqual([]);
  });

  it('still aborts when the row was cleared from the store before completion failed', async () => {
    // A consumer calling clear() (or a navigation that resets the list) mid-upload
    // makes the terminal status write throw. The teardown must not be collateral:
    // the session is open regardless of whether a row is left to update.
    vi.stubGlobal('fetch', makeFetch(1));
    completeStatus = 503;
    onCompleteRequest = () => useS3UploadStore.setState({ items: [] });

    const result = await useS3UploadStore
      .getState()
      .upload({ file: makeFile(CHUNK), type: UploadType.Model });

    expect(result).toBeUndefined();
    expect(abortCalls).toEqual([expectedAbort]);
  });

  it('still aborts when the row was cleared from the store before a part failed', async () => {
    vi.stubGlobal('fetch', makeFetch(1));
    partHandler = () => {
      useS3UploadStore.setState({ items: [] });
      return { status: 400 };
    };

    const result = await useS3UploadStore
      .getState()
      .upload({ file: makeFile(CHUNK), type: UploadType.Model });

    expect(result).toBeUndefined();
    expect(abortCalls).toEqual([expectedAbort]);
  });

  it('does not let a failed abort mask the original failure', async () => {
    // The teardown is best-effort cleanup, not part of the caller's outcome:
    // raising here would replace the real cause with an incidental network error.
    vi.stubGlobal('fetch', makeFetch(1));
    completeStatus = 503;
    abortShouldReject = true;

    const result = await useS3UploadStore
      .getState()
      .upload({ file: makeFile(CHUNK), type: UploadType.Model });

    expect(result).toBeUndefined();
    expect(useS3UploadStore.getState().items[0].status).toBe('error');
    expect(abortCalls).toHaveLength(1);
  });
});
