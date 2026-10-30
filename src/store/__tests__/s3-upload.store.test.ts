import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import { useS3UploadStore } from '~/store/s3-upload.store';
import { UploadType } from '~/server/common/enums';
import { MAX_PART_ATTEMPTS } from '~/utils/upload-retry';
import { useCatchNavigationStore } from '~/store/catch-navigation.store';

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

type PartResponse = { status: number; etag?: string; retryAfter?: string; networkError?: boolean };

/** Body shape `POST /api/upload/abort` is called with. */
type AbortBody = {
  bucket: string;
  key: string;
  type: string;
  uploadId: string;
  backend: string;
  fileSize: number;
  failure?: { kind: string; partNumber?: number; status?: number };
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
/** Part numbers whose PUT stays in-flight forever, so a test can cancel mid-upload. */
let hangPartNumbers: number[];
/** File names (see `makeMultiFileFetch`) whose part PUTs stay in-flight until aborted. */
let hangFiles: string[];
/** Fires when `/api/upload/complete` is requested, to mutate state mid-flight. */
let onCompleteRequest: (() => void) | null;
/** Fires when `/api/upload/abort` is requested, so a test can order it against other effects. */
let onAbortRequest: (() => void) | null;

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
    this.emit('loadend');
  }
  send(body: Blob) {
    setTimeout(() => {
      if (this.settled) return;
      const partNumber = Number(new URL(this.url, 'https://b2.test').searchParams.get('part'));
      if (
        hangPartNumbers.includes(partNumber) ||
        hangFiles.some((f) => this.url.includes(`f=${f}`))
      )
        return; // in-flight forever until aborted
      this.settled = true;
      const res = partHandler(this.url, partNumber);
      this.readyState = 4;
      this.status = res.status;
      if (res.etag) this.headers['ETag'] = res.etag;
      if (res.retryAfter) this.headers['Retry-After'] = res.retryAfter;
      this.upload.listeners['progress']?.forEach((cb) => cb({ loaded: body.size }));
      this.upload.listeners['loadend']?.forEach((cb) => cb({ loaded: body.size }));
      if (res.networkError) {
        // A network-layer failure fires `error` (the listener that rejects with
        // `{ status: null, networkError: true }`) followed by `loadend` in the same
        // dispatch — the same order the real browser emits, and the order that makes
        // the `error` rejection win the race against `loadend`'s status-0 reject.
        this.emit('error');
        this.emit('loadend');
        return;
      }
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
      onAbortRequest?.();
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

type UploadArgs = Parameters<ReturnType<typeof useS3UploadStore.getState>['upload']>;

/** Above MAX_BACKOFF_MS, so one turn always clears whatever the longest sleep resolved to. */
const CLOCK_TURN_MS = 60_000;
/**
 * Far above the store's longest chain (MAX_PART_ATTEMPTS backoffs per part, then 3 completion
 * attempts) and above the microtask turns the fetch chain needs between them.
 */
const MAX_CLOCK_TURNS = 200;

/**
 * Runs an upload with the store's retry sleeps driven rather than waited out. Both give-up paths
 * sleep for real — parts back off exponentially over MAX_PART_ATTEMPTS, and `withRetries` holds a
 * flat second between completion attempts — which is wall clock this file was paying in full.
 *
 * 🔴 The loop is bounded and THROWS, which is the whole reason a fake clock is safe here. Driving a
 * loop with a fake is normally how a regression turns into an unreportable hang: the runner's
 * timeout is itself a timer, so a test that never settles can wedge CI with nothing to read. A
 * retry loop that stopped terminating fails here with a message instead.
 *
 * 🔴 It advances the clock unconditionally rather than while `vi.getTimerCount() > 0`. That was the
 * first shape and it hung: at the moment the upload is handed back, no timer exists yet — the first
 * one is scheduled only after `fetch('/api/upload')` resolves — so the guard read 0 and exited
 * before the run had begun. A count of pending timers says nothing about whether more are coming.
 */
async function runUpload(...args: UploadArgs) {
  let settled = false;
  const promise = useS3UploadStore
    .getState()
    .upload(...args)
    .finally(() => {
      settled = true;
    });
  for (let turn = 0; !settled && turn < MAX_CLOCK_TURNS; turn++)
    await vi.advanceTimersByTimeAsync(CLOCK_TURN_MS);
  if (!settled)
    throw new Error(
      `upload did not settle within ${MAX_CLOCK_TURNS} clock turns — a retry loop is not terminating`
    );
  return promise;
}

beforeEach(() => {
  vi.useFakeTimers();
  useS3UploadStore.setState({ items: [] });
  completeStatus = 200;
  completeStatusQueue = [];
  signPartStatus = 200;
  signedUrls = [];
  completeCalls = 0;
  abortCalls = [];
  abortShouldReject = false;
  hangPartNumbers = [];
  hangFiles = [];
  onCompleteRequest = null;
  onAbortRequest = null;
  partHandler = () => ({ status: 200, etag: 'etag' });
  vi.stubGlobal('XMLHttpRequest', FakeXHR);
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
});

afterEach(() => {
  vi.useRealTimers();
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

    const result = await runUpload({
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

    const result = await runUpload({
      file: makeFile(CHUNK * 2),
      type: UploadType.Model,
    });

    expect(result).toBeUndefined();
    expect(useS3UploadStore.getState().items[0].status).toBe('error');
  });

  // Nothing covered the TRANSIENT part-retry path: flipping shouldRetryPartError so 429/5xx were
  // never retried left all 17 of the older tests green. It went untested because it was expensive —
  // exhausting the backoff is ~1s + 2s + 4s + 8s of real sleeping. On the fake clock it is free.
  it('retries a part that answers with a transient status, and finishes', async () => {
    vi.stubGlobal('fetch', makeFetch(1));
    let attempts = 0;
    partHandler = () => {
      attempts++;
      return attempts === 1 ? { status: 503 } : { status: 200, etag: 'etag' };
    };

    const result = await runUpload({ file: makeFile(CHUNK), type: UploadType.Model });

    expect(attempts).toBe(2);
    expect(result).toBeTruthy();
    expect(useS3UploadStore.getState().items[0].status).toBe('success');
  });

  it('stops at MAX_PART_ATTEMPTS when a part is transient forever, rather than retrying without end', async () => {
    vi.stubGlobal('fetch', makeFetch(1));
    let attempts = 0;
    partHandler = () => {
      attempts++;
      return { status: 503 };
    };

    const result = await runUpload({ file: makeFile(CHUNK), type: UploadType.Model });

    expect(attempts).toBe(MAX_PART_ATTEMPTS);
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

    const result = await runUpload({
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

    const result = await runUpload({
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

    const result = await runUpload({ file: makeFile(CHUNK), type: UploadType.Model }, cb);

    expect(completeCalls).toBe(2);
    expect(result).toBeTruthy();
    expect(cb).toHaveBeenCalledOnce();
  });

  it('marks the file errored when complete never succeeds, instead of returning silently', async () => {
    vi.stubGlobal('fetch', makeFetch(1));
    completeStatus = 503;
    const cb = vi.fn();

    const result = await runUpload({ file: makeFile(CHUNK), type: UploadType.Model }, cb);

    expect(result).toBeUndefined();
    expect(cb).not.toHaveBeenCalled();
    expect(useS3UploadStore.getState().items[0].status).toBe('error');
  });

  it('treats a terminal 409 from complete as final without retrying', async () => {
    vi.stubGlobal('fetch', makeFetch(1));
    completeStatus = 409;

    const result = await runUpload({ file: makeFile(CHUNK), type: UploadType.Model });

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
  // `fileSize` is the uploaded file's byte count, so failed uploads can be grouped by size
  // server-side. Each case passes the size of the file it uploaded.
  const expectedAbort = (fileSize: number) => ({
    ...UPLOAD_IDENTITY,
    type: UploadType.Model,
    fileSize,
  });

  it('aborts the upload when completion fails terminally', async () => {
    vi.stubGlobal('fetch', makeFetch(1));
    completeStatus = 503;

    const result = await runUpload({ file: makeFile(CHUNK), type: UploadType.Model });

    expect(result).toBeUndefined();
    expect(useS3UploadStore.getState().items[0].status).toBe('error');
    expect(abortCalls).toEqual([expectedAbort(CHUNK)]);
  });

  it('aborts the upload when completion returns a terminal 422', async () => {
    // 422 = parts invalid/incomplete. The session is still live and holding every
    // part that was transferred, so this is the case that leaks the most.
    vi.stubGlobal('fetch', makeFetch(2));
    completeStatus = 422;

    await runUpload({ file: makeFile(CHUNK * 2), type: UploadType.Model });

    expect(completeCalls).toBe(1);
    expect(abortCalls).toEqual([expectedAbort(CHUNK * 2)]);
  });

  it('aborts the upload when completion returns a terminal 409', async () => {
    // 409 = already finalized or aborted. Aborting is idempotent server-side, so
    // this path abandons nothing by trying.
    vi.stubGlobal('fetch', makeFetch(1));
    completeStatus = 409;

    await runUpload({ file: makeFile(CHUNK), type: UploadType.Model });

    expect(abortCalls).toEqual([expectedAbort(CHUNK)]);
  });

  // Invariant guard, not regression cover: this path already aborted. It pins the
  // behaviour the completion path above was made to match. The `failure` expectation is
  // the 2026-09 abort-reason plumbing: a part that answered 400 must say so in the abort
  // body, with its part number.
  it('aborts the upload when a part fails terminally', async () => {
    vi.stubGlobal('fetch', makeFetch(2));
    partHandler = (_url, partNumber) =>
      partNumber === 2 ? { status: 400 } : { status: 200, etag: 'etag' };

    await runUpload({ file: makeFile(CHUNK * 2), type: UploadType.Model });

    expect(useS3UploadStore.getState().items[0].status).toBe('error');
    expect(abortCalls).toEqual([
      {
        ...expectedAbort(CHUNK * 2),
        failure: { kind: 'part-status', partNumber: 2, status: 400 },
      },
    ]);
  });

  // Negative control: proves these assertions can distinguish abort from no-abort,
  // rather than passing because something always records a call.
  it('does not abort an upload that completed successfully', async () => {
    vi.stubGlobal('fetch', makeFetch(2));

    const result = await runUpload({ file: makeFile(CHUNK * 2), type: UploadType.Model });

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

    const result = await runUpload({ file: makeFile(CHUNK), type: UploadType.Model });

    expect(result).toBeUndefined();
    expect(abortCalls).toEqual([expectedAbort(CHUNK)]);
  });

  it('still aborts when the row was cleared from the store before a part failed', async () => {
    vi.stubGlobal('fetch', makeFetch(1));
    partHandler = () => {
      useS3UploadStore.setState({ items: [] });
      return { status: 400 };
    };

    const result = await runUpload({ file: makeFile(CHUNK), type: UploadType.Model });

    expect(result).toBeUndefined();
    expect(abortCalls).toEqual([
      {
        ...expectedAbort(CHUNK),
        failure: { kind: 'part-status', partNumber: 1, status: 400 },
      },
    ]);
  });

  it('does not let a failed abort mask the original failure', async () => {
    // The teardown is best-effort cleanup, not part of the caller's outcome:
    // raising here would replace the real cause with an incidental network error.
    vi.stubGlobal('fetch', makeFetch(1));
    completeStatus = 503;
    abortShouldReject = true;

    const result = await runUpload({ file: makeFile(CHUNK), type: UploadType.Model });

    expect(result).toBeUndefined();
    expect(useS3UploadStore.getState().items[0].status).toBe('error');
    expect(abortCalls).toHaveLength(1);
  });
});

/**
 * ORDERING: the terminal row is written BEFORE the session teardown, on both give-up
 * paths.
 *
 * 🔴 This was undefended. The teardown awaits a network round-trip, so aborting first
 * leaves the row sitting at its last-rendered percentage for that whole window — which
 * is exactly the "reads to the user as a finished upload that silently never got
 * added" failure the terminal write exists to prevent. Nothing in the suite pinned the
 * order, so swapping the two statements on either branch left every test green, and a
 * merge that reversed them would have been invisible.
 *
 * The timeline is recorded from two independent observers: a zustand subscription for
 * the status write (synchronous inside `setTerminalStatus`) and the abort request
 * arriving at the fake. Asserting the exact array also pins that exactly ONE abort is
 * issued, so a duplicated teardown cannot pass either.
 */
describe('useS3UploadStore.upload teardown ordering', () => {
  /** Records 'status' on the first terminal row write and 'abort' when the abort lands. */
  function recordTimeline(terminal: 'error' | 'aborted') {
    const timeline: string[] = [];
    const unsubscribe = useS3UploadStore.subscribe((state) => {
      if (state.items[0]?.status === terminal && !timeline.includes('status'))
        timeline.push('status');
    });
    onAbortRequest = () => timeline.push('abort');
    return { timeline, unsubscribe };
  }

  it('writes the terminal row before aborting when completion fails', async () => {
    vi.stubGlobal('fetch', makeFetch(1));
    completeStatus = 503;
    const { timeline, unsubscribe } = recordTimeline('error');

    try {
      await runUpload({ file: makeFile(CHUNK), type: UploadType.Model });
    } finally {
      unsubscribe();
    }

    expect(timeline).toEqual(['status', 'abort']);
  });

  it('writes the terminal row before aborting when a part fails', async () => {
    vi.stubGlobal('fetch', makeFetch(2));
    partHandler = (_url, partNumber) =>
      partNumber === 2 ? { status: 400 } : { status: 200, etag: 'etag' };
    const { timeline, unsubscribe } = recordTimeline('error');

    try {
      await runUpload({ file: makeFile(CHUNK * 2), type: UploadType.Model });
    } finally {
      unsubscribe();
    }

    expect(timeline).toEqual(['status', 'abort']);
  });
});

/**
 * A USER CANCEL AND THE STORE'S OWN TEARDOWN ARE DIFFERENT EVENTS, and only the first is
 * something the person did.
 *
 * Both end up tripping the same `cancelController` and aborting the same in-flight part
 * xhrs, so neither the signal nor the xhrs can tell them apart. `userAborted` records the
 * intent at the one place it exists — the `abort` the store hands out on the tracked row.
 *
 * 🔴 The sibling client `useS3Upload` had the same confusion with much worse consequences:
 * its relay fallback was gated on that shared signal and could therefore never run. This
 * client has no relay (it serves model/training uploads, which the relay route does not
 * write), so what was at stake here is only the row's terminal status — but it is the same
 * defect, and keeping the two clients' answer to "did the user cancel?" identical is what
 * stops the next reader re-deriving the wrong one.
 */
describe('useS3UploadStore.upload cancel versus teardown', () => {
  it('reports a cancel that races a part failure as aborted, not as an upload error', async () => {
    vi.stubGlobal('fetch', makeFetch(1));
    // The part is refused in the same tick the person presses cancel. 400 is not
    // retryable, so it lands on the fatal slot immediately and the cancel never gets to
    // overwrite it — the row then reported a failure for an upload the user stopped.
    partHandler = () => {
      useS3UploadStore.getState().items[0].abort();
      return { status: 400 };
    };

    const result = await runUpload({ file: makeFile(CHUNK), type: UploadType.Model });

    expect(result).toBeUndefined();
    expect(useS3UploadStore.getState().items[0].status).toBe('aborted');
    // The abort body still describes what the UPLOAD hit, deliberately: the row's status
    // answers "what did the user do", the failure reason answers "why did the transfer
    // stop", and collapsing the second into the first would delete the diagnostic signal
    // the reason field was added to carry.
    expect(abortCalls.map((c) => c.failure)).toEqual([
      { kind: 'part-status', partNumber: 1, status: 400 },
    ]);
  });

  // Negative control: without this, the test above could pass against a client that had
  // simply stopped reporting 'error' at all.
  it('still reports a part failure with no cancel as an error', async () => {
    vi.stubGlobal('fetch', makeFetch(1));
    partHandler = () => ({ status: 400 });

    await runUpload({ file: makeFile(CHUNK), type: UploadType.Model });

    expect(useS3UploadStore.getState().items[0].status).toBe('error');
  });
});

/**
 * WHY the abort body carries a `failure` object: the server-side `s3-upload-abort` event
 * could not say WHY a client gave up — the 2026-09 image-upload investigation (Kayot +
 ~136 others, browser PUTs to Backblaze reset at the network layer) had to ask users for
 * devtools screenshots because the abort row carried no reason. These pin the reason
 * plumbing on the store client; `useS3Upload` shares the same helpers from
 * ~/utils/upload-retry.
 */
describe('useS3UploadStore.upload abort failure reason', () => {
  it('reports the failing part number and status when a part answers with an HTTP status', async () => {
    vi.stubGlobal('fetch', makeFetch(2));
    partHandler = (_url, partNumber) =>
      partNumber === 2 ? { status: 400 } : { status: 200, etag: 'etag' };

    await runUpload({ file: makeFile(CHUNK * 2), type: UploadType.Model });

    expect(abortCalls).toHaveLength(1);
    expect(abortCalls[0].failure).toEqual({ kind: 'part-status', partNumber: 2, status: 400 });
  });

  it('reports network-error with the part number when the PUT dies at the network layer', async () => {
    vi.stubGlobal('fetch', makeFetch(1));
    partHandler = () => ({ status: 0, networkError: true });

    await runUpload({ file: makeFile(CHUNK), type: UploadType.Model });

    expect(useS3UploadStore.getState().items[0].status).toBe('error');
    expect(abortCalls).toHaveLength(1);
    expect(abortCalls[0].failure).toEqual({ kind: 'network-error', partNumber: 1 });
  });

  it('reports client-aborted — not a failure — when the user cancels mid-upload', async () => {
    vi.stubGlobal('fetch', makeFetch(2));
    hangPartNumbers = [1];

    const promise = useS3UploadStore
      .getState()
      .upload({ file: makeFile(CHUNK * 2), type: UploadType.Model });
    // Let the multipart init and the first PUT start, then cancel the way the UI does.
    await vi.advanceTimersByTimeAsync(CLOCK_TURN_MS);
    useS3UploadStore.getState().items[0].abort();
    await promise;

    expect(useS3UploadStore.getState().items[0].status).toBe('aborted');
    expect(abortCalls).toHaveLength(1);
    expect(abortCalls[0].failure).toEqual({ kind: 'client-aborted' });
  });

  it('sends no failure object when the abort is teardown after a failed completion', async () => {
    // The complete endpoint already logs the server-side reason; the part-failure
    // object must not be invented for a path that never saw a failed part.
    vi.stubGlobal('fetch', makeFetch(1));
    completeStatus = 503;

    await runUpload({ file: makeFile(CHUNK), type: UploadType.Model });

    expect(abortCalls).toHaveLength(1);
    expect(abortCalls[0].failure).toBeUndefined();
  });
});

/**
 * SEQUENTIAL GROUPS: files of one group upload one after another, so a failure on file N leaves
 * files 1..N-1 completed AND saved. In parallel, every file advances together, so nothing has
 * completed when a network drop hits and every file's progress is discarded at once.
 *
 * Each file here is one part named by `f=<name>` in its part URL, which is how `partHandler` and
 * `hangFiles` pick a file out. The `log` is the whole point: it records the order the SERVER sees
 * init, complete and abort requests, which is what "one after another" means.
 */
describe('useS3UploadStore.upload sequential group', () => {
  type TestGroup = { id: string; sequential: boolean };
  // A fresh group per test: an upload left hanging by one test would otherwise keep holding the
  // slot of a shared id for every test after it.
  let groupCount = 0;
  let SEQ: TestGroup;
  const [A, B, C] = ['a.bin', 'b.bin', 'c.bin'];
  let log: string[];
  /** File names whose `/api/upload` init answers with an error body instead of URLs. */
  let failInit: string[];
  const files = new Map<string, File>();

  const fileOf = (name: string) => {
    if (!files.has(name)) files.set(name, new File([new Uint8Array(CHUNK)], name));
    return files.get(name) as File;
  };
  const rowOf = (name: string) => useS3UploadStore.getState().items.find((x) => x.name === name);
  const start = (
    name: string,
    uploadGroup: TestGroup | null = SEQ,
    cb?: (r: { name: string }) => void
  ) =>
    useS3UploadStore.getState().upload(
      {
        file: fileOf(name),
        type: UploadType.Model,
        meta: { uuid: name },
        uploadGroup: uploadGroup ?? undefined,
      },
      cb
    );
  /** Drives the fake clock so every request that is going to happen has happened. */
  async function settle() {
    for (let turn = 0; turn < 20; turn++) await vi.advanceTimersByTimeAsync(CLOCK_TURN_MS);
  }

  beforeEach(() => {
    log = [];
    failInit = [];
    SEQ = { id: `version-${++groupCount}`, sequential: true };
    files.clear();
    useCatchNavigationStore.setState({ handlers: [] });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { body?: string }) => {
        const body = JSON.parse(init?.body ?? '{}') as { filename?: string; key?: string };
        if (url === '/api/upload') {
          const name = decodeURIComponent(body.filename ?? '');
          log.push(`start:${name}`);
          if (failInit.includes(name))
            return { ok: true, status: 200, json: async () => ({ error: 'init refused' }) };
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ...UPLOAD_IDENTITY,
              key: `model/${name}`,
              chunkSize: CHUNK,
              urls: [{ url: `https://b2.test/upload?part=1&f=${name}`, partNumber: 1 }],
            }),
          };
        }
        const name = (body.key ?? '').replace('model/', '');
        if (url === '/api/upload/complete') log.push(`complete:${name}`);
        if (url === '/api/upload/abort') log.push(`abort:${name}`);
        return { ok: true, status: 200, json: async () => ({}) };
      })
    );
  });

  it('uploads the files of a sequential group one after another', async () => {
    const all = Promise.all([start(A), start(B), start(C)]);
    await settle();
    await all;

    expect(log).toEqual([
      `start:${A}`,
      `complete:${A}`,
      `start:${B}`,
      `complete:${B}`,
      `start:${C}`,
      `complete:${C}`,
    ]);
  });

  it('keeps the finished file, fails only the broken one, runs the next, and retries just the broken one', async () => {
    partHandler = (url) => (url.includes(`f=${B}`) ? { status: 400 } : { status: 200, etag: 'e' });
    const saved: string[] = [];
    const cb = (r: { name: string }) => {
      saved.push(r.name);
    };

    const all = Promise.all([start(A, SEQ, cb), start(B, SEQ, cb), start(C, SEQ, cb)]);
    await settle();
    await all;

    // B's multipart is torn down BEFORE C asks the server for URLs.
    expect(log).toEqual([
      `start:${A}`,
      `complete:${A}`,
      `start:${B}`,
      `abort:${B}`,
      `start:${C}`,
      `complete:${C}`,
    ]);
    expect(saved).toEqual([A, C]);
    expect([A, B, C].map((n) => rowOf(n)?.status)).toEqual(['success', 'error', 'success']);

    partHandler = () => ({ status: 200, etag: 'e' });
    log.length = 0;
    const retry = start(B, SEQ, cb);
    await settle();
    await retry;

    expect(log).toEqual([`start:${B}`, `complete:${B}`]);
    expect(saved).toEqual([A, C, B]);
    expect(rowOf(A)?.status).toBe('success');
  });

  it('cancelling the RUNNING file frees the slot for the next one', async () => {
    hangFiles = [A];
    const first = start(A);
    const second = start(B);
    await settle();
    expect(log).toEqual([`start:${A}`]);

    rowOf(A)?.abort();
    await settle();
    await Promise.all([first, second]);

    expect(log).toEqual([`start:${A}`, `abort:${A}`, `start:${B}`, `complete:${B}`]);
    expect([A, B].map((n) => rowOf(n)?.status)).toEqual(['aborted', 'success']);
  });

  it('shows a waiting file as pending, and cancelling it never starts it', async () => {
    hangFiles = [A];
    const first = start(A);
    const waiting = start(B);
    const last = start(C);
    await settle();
    expect(rowOf(B)?.status).toBe('pending');

    rowOf(B)?.abort();
    await settle();
    expect(rowOf(B)?.status).toBe('aborted');
    expect(await waiting).toBeUndefined();

    rowOf(A)?.abort();
    await settle();
    await Promise.all([first, last]);

    expect(log).toEqual([`start:${A}`, `abort:${A}`, `start:${C}`, `complete:${C}`]);
  });

  it('does not upload a waiting file whose row was removed before its turn', async () => {
    hangFiles = [A];
    const first = start(A);
    const removed = start(B);
    await settle();

    useS3UploadStore.getState().clear((x) => x.name === B);
    rowOf(A)?.abort();
    await settle();
    await Promise.all([first, removed]);

    expect(log).toEqual([`start:${A}`, `abort:${A}`]);
    expect(await removed).toBeUndefined();
  });

  it('releases the slot, and marks the row failed, when a waiting upload cannot even start', async () => {
    failInit = [B];
    const all = [start(A), start(B), start(C)];
    const outcome = all[1].then(
      () => 'resolved',
      () => 'rejected'
    );
    await settle();

    expect(await outcome).toBe('rejected');
    expect(await all[2]).toBeTruthy();
    expect(rowOf(B)?.status).toBe('error');
    expect(log).toEqual([
      `start:${A}`,
      `complete:${A}`,
      `start:${B}`,
      `start:${C}`,
      `complete:${C}`,
    ]);
  });

  it('does not make different groups wait for each other', async () => {
    hangFiles = [A];
    void start(A);
    const other = start(B, { id: `${SEQ.id}-other`, sequential: true });
    await settle();
    await other;

    expect(log).toEqual([`start:${A}`, `start:${B}`, `complete:${B}`]);
  });

  it.each([
    ['a group with sequential off', (id: string) => ({ id, sequential: false })],
    ['no group', () => null],
  ])('keeps uploading in parallel with %s', async (_label, makeGroup) => {
    const group = makeGroup(SEQ.id);
    const all = Promise.all([start(A, group), start(B, group), start(C, group)]);
    await settle();
    await all;

    expect(log.slice(0, 3)).toEqual([`start:${A}`, `start:${B}`, `start:${C}`]);
  });

  it('makes a sequential file wait for a parallel upload already running in its group', async () => {
    hangFiles = [A];
    void start(A, { id: SEQ.id, sequential: false });
    const queued = start(B, SEQ);
    await settle();
    expect(log).toEqual([`start:${A}`]);

    rowOf(A)?.abort();
    await settle();
    await queued;

    expect(log).toEqual([`start:${A}`, `abort:${A}`, `start:${B}`, `complete:${B}`]);
  });

  it('keeps the leave-page warning armed while files are only waiting', async () => {
    hangFiles = [A];
    void start(A);
    void start(B);
    await settle();
    const warning = () =>
      useCatchNavigationStore.getState().handlers.find((x) => x.name === 'file-upload');

    // Only the waiting file is left to lose: the running one has stopped reporting 'uploading'.
    useS3UploadStore.setState({
      items: useS3UploadStore
        .getState()
        .items.map((x) => (x.name === A ? { ...x, status: 'error' as const } : x)),
    });
    const predicate = warning()?.predicate as () => boolean;
    expect(predicate()).toBe(true);

    useS3UploadStore.getState().clear((x) => x.name === B);
    expect(predicate()).toBe(false);
  });
});
