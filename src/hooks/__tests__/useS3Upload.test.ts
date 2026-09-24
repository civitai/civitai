// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { createRoot } from 'react-dom/client';

import { UploadType } from '~/server/common/enums';
import { useS3Upload } from '~/hooks/useS3Upload';

// React 18.3 exposes `act` on the `react` export, but our @types/react predates that typing.
// Declared locally rather than imported from `react-dom/test-utils`: that module's types are
// unreachable through @types/react-dom's `exports` map, so importing them is an implicit `any`.
type ActFn = (callback: () => void | Promise<void>) => Promise<void>;
const act = (React as unknown as { act: ActFn }).act;
// Without this React warns on every `act(...)` and does not flush its queue the same way.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * THE SEAM, not the predicate.
 *
 * `shouldRelayOnPartFailure` is correct in isolation and thoroughly unit-tested in
 * `src/utils/__tests__/upload-retry.test.ts` — with a fixture the only production caller
 * could never produce. The relay fallback it gates was therefore INERT from the day it
 * merged: the worker cancels the upload's abort signal before the gate is reached, so the
 * gate's "already cancelled" clause matched every failure, including the network-layer
 * ones the relay exists for.
 *
 * So these drive the real hook through a real part failure and assert on the request the
 * browser would actually make. A test that calls the predicate directly passes against
 * the broken code and is worth nothing here.
 */

const CHUNK = 1024;
const RELAY_ENDPOINT = '/api/v1/image-upload/relay';
/** The key the relay mints server-side. Deliberately unlike the presigned key. */
const RELAY_KEY = 'relayed/9f1c2d-4a.png';

const UPLOAD_IDENTITY = {
  bucket: 'civitai-images',
  key: 'image/7/original.png',
  uploadId: 'upload-1',
};

type PartResponse = { status: number; etag?: string; networkError?: boolean };
type AbortBody = { failure?: { kind: string; partNumber?: number; status?: number } };

let partHandler: (partNumber: number) => PartResponse;
let backend: string;
/** Part numbers whose PUT stays in flight forever, so a test can cancel mid-upload. */
let hangPartNumbers: number[];
let relayCalls: number;
let relayResponse: { ok: boolean; id?: string };
/** Consumed before `relayResponse`, so a test can script a shed followed by a success. */
let relayScriptedStatuses: number[];
/** What a scripted 429 advertises in `Retry-After`. */
let relayRetryAfterSeconds: number | null;
/**
 * Fake-clock time of each relay POST. `vi.useFakeTimers()` mocks `Date.now()`, so a delta
 * between two of these is an assertion about how long the client WAITED — independent of
 * how coarsely the test drives the clock.
 */
let relayTimes: number[];
/** Park the relay POST in flight so a test can cancel while it is running. */
let relayHangsUntilAborted: boolean;
/** Set once the parked relay POST has actually been issued. */
let relayStarted: boolean;
let abortCalls: AbortBody[];

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
      const partNumber = Number(new URL(this.url, 'https://store.test').searchParams.get('part'));
      if (hangPartNumbers.includes(partNumber)) return; // in flight until aborted
      this.settled = true;
      const res = partHandler(partNumber);
      this.readyState = 4;
      this.status = res.status;
      if (res.etag) this.headers['ETag'] = res.etag;
      if (res.networkError) {
        // 🔴 NO `upload.progress` ON THIS PATH, and that is the point of the branch
        // sitting ABOVE the progress emission rather than below it. A transport failure
        // — DNS, TLS, connection reset — is precisely the case where the request body
        // never leaves, so the browser fires little or no upload progress. Emitting a
        // full-size `progress` here (which this fake used to do unconditionally) made
        // every relayed row read `progress: 100` in tests while the real one sits at 0,
        // and that single line silently disarmed the assertion guarding it: removing the
        // relay branch's `progress: 100` left this file GREEN. Measured, not reasoned.
        //
        // The order below is the order the browser emits: `error` then `loadend` in the
        // same dispatch, which is what lets the `error` rejection win the race against
        // `loadend`'s status-0.
        this.emit('error');
        this.emit('loadend');
        return;
      }
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

function partUrl(partNumber: number) {
  return `https://store.test/upload?part=${partNumber}`;
}

function makeFetch(partCount: number) {
  return vi.fn(async (url: string, init?: { body?: string; signal?: AbortSignal }) => {
    // 🔴 HONOUR THE SIGNAL, because the browser does. A real `fetch` handed an
    // already-aborted signal rejects without sending anything, and the relay POST is
    // handed one. Without this the stub counts a request the browser would never have
    // made: verified by mutation — reverting the relay's signal back to the upload's
    // internal teardown signal (which has ALWAYS fired by the time the relay runs) left
    // every case in this file green, i.e. the harness could not see half the fix.
    if (init?.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    if (url === '/api/upload') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ...UPLOAD_IDENTITY,
          backend,
          chunkSize: CHUNK,
          urls: Array.from({ length: partCount }, (_, i) => ({
            url: partUrl(i + 1),
            partNumber: i + 1,
          })),
        }),
      };
    }
    if (url === RELAY_ENDPOINT) {
      relayTimes.push(Date.now());
      relayCalls++;
      const scripted = relayScriptedStatuses.shift();
      if (scripted !== undefined)
        return {
          ok: scripted === 200,
          status: scripted,
          headers: {
            get: (name: string) =>
              name.toLowerCase() === 'retry-after' && relayRetryAfterSeconds !== null
                ? String(relayRetryAfterSeconds)
                : null,
          },
          json: async () => ({ id: relayResponse.id }),
        };
      const response = {
        ok: relayResponse.ok,
        status: relayResponse.ok ? 200 : 500,
        headers: { get: () => null },
        json: async () => ({ id: relayResponse.id }),
      };
      // 🔴 The other half of honouring the signal: a real `fetch` also rejects an
      // ALREADY-IN-FLIGHT request when the signal fires later. Without this, replacing
      // the relay's signal with one that can never fire leaves every case green — the
      // POST's cancellability would be claimed by a comment and checked by nothing.
      if (relayHangsUntilAborted)
        return new Promise((_resolve, reject) => {
          relayStarted = true;
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted.', 'AbortError'))
          );
        });
      return response;
    }
    if (url === '/api/upload/abort') {
      abortCalls.push(JSON.parse(init?.body ?? '{}') as AbortBody);
      return { ok: true, status: 200, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => null };
  });
}

type Harness = {
  upload: (file: File, type: UploadType) => Promise<{ url: string | null; key: string }>;
  statuses: () => string[];
  /**
   * The tracked rows' `progress`. `useMediaUpload` gates row-clearing on every file
   * reading exactly 100, so a row that is `success` at a lower number is still, to the
   * UI, an upload in flight.
   */
  progresses: () => number[];
  /** Cancel the way the UI does: the `abort` the hook hands out on the tracked file. */
  cancel: () => void;
  unmount: () => void;
};

async function mountHook(): Promise<Harness> {
  let api: ReturnType<typeof useS3Upload> | undefined;
  function Probe() {
    api = useS3Upload();
    return null;
  }
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(Probe));
  });
  return {
    upload: (file, type) =>
      api!.uploadToS3(file, type) as Promise<{ url: string | null; key: string }>,
    statuses: () => api!.files.map((f) => f.status),
    progresses: () => api!.files.map((f) => f.progress),
    cancel: () => api!.files[0].abort(),
    unmount: () => act(() => root.unmount()),
  };
}

/**
 * Drive an upload to settlement on the fake clock.
 *
 * A network-layer part failure exhausts MAX_PART_ATTEMPTS of exponential backoff before it
 * becomes fatal — ~15s of real sleeping per test. On the fake clock it is free.
 *
 * 🔴 The loop is bounded and THROWS, which is the whole reason a fake clock is safe here.
 * Driving a loop with a fake is normally how a regression turns into an unreportable hang:
 * the runner's timeout is itself a timer, so a test that never settles can wedge CI with
 * nothing to read. A retry loop that stopped terminating fails here with a message instead.
 *
 * 🔴 It advances the clock unconditionally rather than while `vi.getTimerCount() > 0`. That
 * shape hangs: at the moment the upload is handed back no timer exists yet — the first is
 * scheduled only after `fetch('/api/upload')` resolves — so the guard reads 0 and exits
 * before the run has begun. A count of pending timers says nothing about what is coming.
 *
 * (Both traps are recorded on the sibling harness in `src/store/__tests__/s3-upload.store.test.ts`,
 * which this is modelled on; they are repeated rather than cross-referenced because the
 * next person to change this loop will be reading this file.)
 */
const CLOCK_TURN_MS = 60_000;
/** Matches the sibling harness: far above this client's longest chain of sleeps. */
const MAX_CLOCK_TURNS = 200;

/** Advance the fake clock one turn, inside `act` so React flushes what the turn produced. */
async function turnClock() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(CLOCK_TURN_MS);
  });
}

async function runUpload(
  h: Harness,
  file: File,
  type: UploadType,
  /** Runs once the upload is in flight, before the clock is driven to settlement. */
  beforeSettle?: () => void | Promise<void>
) {
  let settled = false;
  let promise!: Promise<{ url: string | null; key: string }>;
  await act(async () => {
    // Chained, not discarded: an upload that starts rejecting must surface as a clean
    // assertion failure rather than as an unhandled rejection beside one.
    promise = h.upload(file, type).finally(() => {
      settled = true;
    });
    // Let the multipart init and the first PUT start.
    await vi.advanceTimersByTimeAsync(0);
  });
  await beforeSettle?.();
  for (let turn = 0; !settled && turn < MAX_CLOCK_TURNS; turn++) await turnClock();
  if (!settled)
    throw new Error(
      `upload did not settle within ${MAX_CLOCK_TURNS} clock turns — a retry loop is not terminating`
    );
  return promise;
}

/**
 * Drive the clock until `predicate` holds, so a test can act mid-flight.
 *
 * Its budget is ADDITIONAL to `runUpload`'s, so a case using both is bounded at 2x
 * MAX_CLOCK_TURNS. Both throw rather than hang, which is the property that matters.
 */
async function advanceUntil(predicate: () => boolean, what: string) {
  for (let turn = 0; !predicate() && turn < MAX_CLOCK_TURNS; turn++) await turnClock();
  if (!predicate()) throw new Error(`${what} never happened within ${MAX_CLOCK_TURNS} clock turns`);
}

function makeFile(bytes: number) {
  return new File([new Uint8Array(bytes)], 'photo.png', { type: 'image/png' });
}

beforeEach(() => {
  vi.useFakeTimers();
  backend = 'backblaze';
  hangPartNumbers = [];
  relayCalls = 0;
  relayResponse = { ok: true, id: RELAY_KEY };
  relayScriptedStatuses = [];
  relayRetryAfterSeconds = null;
  relayTimes = [];
  relayHangsUntilAborted = false;
  relayStarted = false;
  abortCalls = [];
  partHandler = () => ({ status: 200, etag: 'etag' });
  vi.stubGlobal('XMLHttpRequest', FakeXHR);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useS3Upload relay fallback', () => {
  it('relays the file through our own origin when a part dies at the network layer', async () => {
    // 🔴 THE DEFECT. Every gate in `shouldRelayOnPartFailure` is satisfied here — image
    // type, image backend, a file well under the relay cap, a network-layer failure — and
    // before this fix the relay was still never attempted, because the worker's own
    // teardown had already tripped the signal the gate read as "the caller cancelled".
    vi.stubGlobal('fetch', makeFetch(1));
    partHandler = () => ({ status: 0, networkError: true });
    const h = await mountHook();

    const result = await runUpload(h, makeFile(CHUNK), UploadType.Image);

    expect(relayCalls).toBe(1);
    // The relay mints its OWN key, so the upload must report the id that holds the bytes.
    expect(result.key).toBe(RELAY_KEY);
    // 🔴 `url` as well as `key`, because `url` is the field the ONLY caller that can
    // reach the relay actually branches on: `useMediaUpload` does
    // `if (!url) throw new Error('Failed to upload image')` and reports the upload as
    // failed. Asserting `key` alone left `url: null` a SURVIVING mutant with this whole
    // file green — a one-token change that makes a successful relay report as a failure,
    // which is the inertness this PR exists to end, on the field nothing was pinning.
    expect(result.url).toBe(RELAY_KEY);
    expect(h.statuses()).toEqual(['success']);
    // A relayed row must read as FINISHED, not merely successful. The part died at the
    // network layer, so almost no `upload.progress` fired; `useMediaUpload` clears rows
    // only when every file reads `progress === 100`, and one row short of that leaves
    // the upload UI on screen for the rest of the session.
    expect(h.progresses()).toEqual([100]);
    // 🔴 The multipart session the relay bypassed is now orphaned — its key holds no
    // bytes and nothing else will ever close it. Without this assertion, deleting the
    // teardown entirely leaves every case in this file green: a relayed upload would leak
    // one open session apiece, and the abort stream would lose the reason that explains
    // why the direct path was abandoned.
    expect(abortCalls.map((c) => c.failure)).toEqual([{ kind: 'network-error', partNumber: 1 }]);
    h.unmount();
  });

  it('reports error, not aborted, when a part dies at the network layer and cannot relay', async () => {
    // The relay writes to the image bucket, so a non-image backend never qualifies — but
    // the upload still failed, and the user is owed an error. Before this fix the terminal
    // status read the same always-tripped teardown signal and reported every failed
    // multipart upload as a user cancel.
    vi.stubGlobal('fetch', makeFetch(1));
    backend = 'b2';
    partHandler = () => ({ status: 0, networkError: true });
    const h = await mountHook();

    const result = await runUpload(h, makeFile(CHUNK), UploadType.Model);

    expect(relayCalls).toBe(0);
    // No relay happened, so the upload reports the presigned key and no url.
    expect(result).toMatchObject({ url: null, key: UPLOAD_IDENTITY.key });
    expect(h.statuses()).toEqual(['error']);
    h.unmount();
  });

  it('does not relay when the storage host answered with an HTTP status, and reports error', async () => {
    // Reaching the backend and being refused is a real fault; replaying the bytes through
    // a second route would mask it. Pinned at the seam, not only in the predicate.
    vi.stubGlobal('fetch', makeFetch(1));
    partHandler = () => ({ status: 400 });
    const h = await mountHook();

    const result = await runUpload(h, makeFile(CHUNK), UploadType.Image);

    expect(relayCalls).toBe(0);
    expect(result).toMatchObject({ url: null, key: UPLOAD_IDENTITY.key });
    expect(h.statuses()).toEqual(['error']);
    expect(abortCalls.map((c) => c.failure)).toEqual([
      { kind: 'part-status', partNumber: 1, status: 400 },
    ]);
    h.unmount();
  });

  it('reports aborted when the user cancels while the relay is in flight', async () => {
    // ⚠ HONEST SCOPE, the same qualification the predicate's own cancel case carries: no
    // image-upload path renders a cancel today (see the note on `abort` in the hook), so
    // the STATUS half of this asserts a combination production cannot currently produce.
    // It is kept as a forward guard rather than deleted — unlike an unreachable guard in
    // production code, an unreachable assertion costs nothing and arms the day a cancel
    // button is wired to the dropzone — and the rest of the case is reachable now: it is
    // the only thing that pins the relay POST as cancellable AT ALL, and the only thing
    // that pins the teardown on this branch.
    //
    // 🔴 The relay is the ONE await between the upload failing and its terminal status,
    // so it is the only window where a cancel can land with a NON-cancel already on the
    // fatal slot. The row must still say the person cancelled — otherwise this is the very
    // bug being fixed, surviving in the half of the status line the other cases cannot
    // reach (`fatal.aborted` is false here; only the user flag can produce 'aborted').
    //
    // It also pins that the relay POST is cancellable AT ALL. The request is handed the
    // user's signal precisely so a cancel stops it; with a signal that can never fire the
    // upload simply never settles, and this fails on the parked-relay guard below.
    vi.stubGlobal('fetch', makeFetch(1));
    partHandler = () => ({ status: 0, networkError: true });
    relayHangsUntilAborted = true;
    const h = await mountHook();

    const result = await runUpload(h, makeFile(CHUNK), UploadType.Image, async () => {
      await advanceUntil(() => relayStarted, 'the relay POST');
      h.cancel();
    });

    expect(relayCalls).toBe(1);
    expect(h.statuses()).toEqual(['aborted']);
    // The bytes never landed anywhere, so the upload reports the presigned key and no url.
    expect(result).toMatchObject({ url: null, key: UPLOAD_IDENTITY.key });
    // The session still owes a teardown. This is the ONE path where dropping it would go
    // unnoticed — the relay-success case asserts its own, and every non-relay case asserts
    // through the ordinary failure path.
    expect(abortCalls.map((c) => c.failure)).toEqual([{ kind: 'network-error', partNumber: 1 }]);
    h.unmount();
  });

  it('falls back to the original failure when the relay itself refuses', async () => {
    // `relayImageFallback` returns null for EVERY failure, so a broken fallback degrades
    // to the pre-existing outcome — "the upload failed" — rather than replacing the
    // user's real diagnosis with a fallback error. Without this case the refusal path is
    // declared by the harness and exercised by nothing.
    vi.stubGlobal('fetch', makeFetch(1));
    partHandler = () => ({ status: 0, networkError: true });
    // 🔴 The refusal carries an id ANYWAY. With `{ ok: false }` alone it is the MISSING id
    // that produces null, so deleting `relayImageFallback`'s `if (!res.ok) return null`
    // would leave this green — the case would be pinning the harness rather than the
    // status check. Measured: it survives that mutation without this id.
    relayResponse = { ok: false, id: RELAY_KEY };
    const h = await mountHook();

    const result = await runUpload(h, makeFile(CHUNK), UploadType.Image);

    expect(relayCalls).toBe(1);
    expect(result).toMatchObject({ url: null, key: UPLOAD_IDENTITY.key });
    expect(h.statuses()).toEqual(['error']);
    // The abort still reports the ORIGINAL network failure, not the relay's refusal.
    expect(abortCalls.map((c) => c.failure)).toEqual([{ kind: 'network-error', partNumber: 1 }]);
    h.unmount();
  });

  it('waits out the relay\u2019s Retry-After before re-posting a shed file', async () => {
    // 🔴 The relay's 429 backoff sleeps on the USER's signal, like the POST itself — and
    // for a reason the other cases cannot see. The upload's internal teardown signal has
    // ALWAYS fired by the time the relay runs, so a sleep bound to it resolves instantly
    // and the retry re-posts the moment the origin said "back off". Nothing else in this
    // file notices: the retry still happens and the upload still succeeds, just without
    // the wait. So this is the one assertion about WHEN rather than whether.
    vi.stubGlobal('fetch', makeFetch(1));
    partHandler = () => ({ status: 0, networkError: true });
    relayScriptedStatuses = [429, 200];
    relayRetryAfterSeconds = 8; // under MAX_RETRY_AFTER_SECONDS, so it is honoured as-is
    const h = await mountHook();

    const result = await runUpload(h, makeFile(CHUNK), UploadType.Image);

    expect(relayCalls).toBe(2);
    // The claim is about the WAIT, not about the retry happening — the retry happens
    // either way, which is why nothing else here notices. Asserted as a delta between two
    // mocked `Date.now()` readings so it does not depend on the clock-turn size.
    expect(relayTimes[1] - relayTimes[0]).toBeGreaterThanOrEqual(8_000);
    expect(result.key).toBe(RELAY_KEY);
    expect(h.statuses()).toEqual(['success']);
    h.unmount();
  });

  it('does not relay a cancelled upload, and reports it as aborted', async () => {
    // The mirror case, and the negative control for the relay assertion above: a cancelled
    // upload has an owner, not a fallback. If this ever relayed, the person who pressed
    // cancel would have their file uploaded anyway.
    //
    // ⚠ It is NOT evidence that the gate's `userAborted` clause works, and not evidence
    // for its `err.aborted` clause either. A cancelled part xhr rejects with
    // `{ status: null, aborted: true }` and NO `networkError`, so `!err.networkError`
    // short-circuits first: neither `opts.userAborted` nor `err.aborted` is ever
    // evaluated on this path. Measured — deleting either one leaves this green, while
    // deleting `!err.networkError` turns the HTTP-status case red. Those two clauses are
    // pinned in `src/utils/__tests__/upload-retry.test.ts`, on hand-built fixtures; see
    // the note there on why this caller cannot produce them.
    vi.stubGlobal('fetch', makeFetch(2));
    hangPartNumbers = [1, 2];
    const h = await mountHook();

    const result = await runUpload(h, makeFile(CHUNK * 2), UploadType.Image, () => h.cancel());

    expect(relayCalls).toBe(0);
    expect(result).toMatchObject({ url: null, key: UPLOAD_IDENTITY.key });
    expect(h.statuses()).toEqual(['aborted']);
    expect(abortCalls.map((c) => c.failure)).toEqual([{ kind: 'client-aborted' }]);
    h.unmount();
  });
});
