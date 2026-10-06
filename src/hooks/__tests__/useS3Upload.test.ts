// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { createRoot } from 'react-dom/client';

import { UploadType } from '~/server/common/enums';
import { useS3Upload } from '~/hooks/useS3Upload';
import { IMAGE_UPLOAD_RELAY_PRODUCER_HEADER } from '~/utils/image-upload-relay-producer';
import { MAX_PART_ATTEMPTS } from '~/utils/upload-retry';

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
type AbortBody = {
  failure?: { kind: string; partNumber?: number; status?: number };
  relayOutcome?: string;
};

let partHandler: (partNumber: number) => PartResponse;
let backend: string;
/** Part numbers whose PUT stays in flight forever, so a test can cancel mid-upload. */
let hangPartNumbers: number[];
/**
 * How many of a hanging part's attempts actually hang; `null` means all of them. Lets a case
 * script a stall that RECOVERS, which is what distinguishes "retried like any network error"
 * from "fatal on the first stall".
 */
let hangAttemptLimit: number | null;
/**
 * Bytes a hanging part reports through `upload.progress` before it goes silent.
 *
 * 🔴 THE HALF-OPEN CONNECTION, which is the shape no other fixture here models: some of the
 * body leaves, then the radio drops or NAT expires and NO RST arrives — so there is no
 * `error`, no `load`, no `loadend`, and the request simply never ends. A part that never sends
 * a byte (`null`) is the easier case; this one is the reported symptom.
 */
let hangAfterProgressBytes: number | null;
/**
 * How long the server takes to answer AFTER the body is fully sent. The healthy-but-slow case
 * that a progress watchdog must not kill: `upload.progress` has stopped because there is
 * nothing left to send, not because the connection died.
 */
let responseDelayMs: number;
/** PUT attempts per part number, so a case can assert a part was never aborted and re-sent. */
let partSendCounts: Map<number, number>;
/**
 * The most recent still-open PUT per part number, so a case can drive one by hand.
 *
 * The flag-driven hangs above script a part before it starts; a backgrounded tab has to be
 * scripted DURING one — bytes, then silence, then a resume at a chosen point on the clock.
 */
let inFlight: Map<number, FakeXHR>;
/** Fake-clock time of each part's response, for asserting the response wait really was long. */
let partLoadTimes: number[];
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
/** Reject the relay POST the way a browser does when it cannot reach our origin at all. */
let relayRejects: boolean;
/** Set once the parked relay POST has actually been issued. */
let relayStarted: boolean;
/**
 * Request headers of each relay POST.
 *
 * Captured so the PRODUCER header can be asserted through the hook rather than only
 * through `relayImageFallback` in isolation: the header exists to tell the server which
 * of the two relay callers this is, and "the shared helper sends it" is a weaker claim
 * than "the multipart hook's rescue arrives carrying it".
 */
let relayRequestHeaders: Record<string, string>[];
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
  /** A resumed transfer reporting bytes again, at a moment the case chooses. */
  emitProgress(loaded: number) {
    this.upload.listeners['progress']?.forEach((cb) => cb({ loaded }));
  }
  /** Finish a hand-driven part: body fully sent, then the response. */
  finishOk(loaded: number) {
    if (this.settled) return;
    this.upload.listeners['loadend']?.forEach((cb) => cb({ loaded }));
    this.settled = true;
    this.readyState = 4;
    this.status = 200;
    this.headers['ETag'] = 'etag';
    this.emit('load');
    this.emit('loadend');
  }
  send(body: Blob) {
    const partNumber = Number(new URL(this.url, 'https://store.test').searchParams.get('part'));
    const attempt = (partSendCounts.get(partNumber) ?? 0) + 1;
    partSendCounts.set(partNumber, attempt);
    inFlight.set(partNumber, this);
    setTimeout(() => {
      if (this.settled) return;
      if (
        hangPartNumbers.includes(partNumber) &&
        (hangAttemptLimit === null || attempt <= hangAttemptLimit)
      ) {
        // Deliberately NOT `settled`: the request is still open, so an abort from the hook's
        // watchdog still reaches `abort()` and emits its events, the way a real one does.
        if (hangAfterProgressBytes !== null)
          this.upload.listeners['progress']?.forEach((cb) =>
            cb({ loaded: hangAfterProgressBytes as number })
          );
        return; // in flight until aborted
      }
      const res = partHandler(partNumber);
      if (res.networkError) {
        this.settled = true;
        this.readyState = 4;
        this.status = res.status;
        // 🔴 NO FULL-SIZE `upload.progress` ON THIS PATH, and that is the point of the
        // branch sitting ABOVE the ordinary progress emission. Emitting a full-size
        // `progress` here (which this fake used to do unconditionally) made every relayed
        // row read `progress: 100` in tests while the real one sits far below it, and
        // that single line silently disarmed the assertion guarding it: removing the
        // relay branch's `progress: 100` left this file GREEN. Measured, not reasoned.
        //
        // ⚠ WHAT THIS MODELS, PRECISELY — the bytes-never-left sub-case, with
        // `loaded: 0`. A reset can also land MID-BODY or after the body is fully sent,
        // and this fake does not model that; an earlier draft of this comment claimed
        // the body "never leaves" on a transport failure, which is false for exactly the
        // ERR_CONNECTION_RESET class that motivated the relay. The assertions guarding
        // the relay row hold for any transmitted fraction below 100%, so the narrow
        // model is sufficient for them — it is not a general statement about resets.
        //
        // `upload.loadend` DOES fire on a request error (per XHR's request-error steps
        // it is `progress` that is skipped, not `loadend`), so it is emitted here with
        // the bytes actually transmitted. Dropping it left production's own
        // `xhr.upload.addEventListener('loadend', …)` handler unexercised on the failure
        // path. Then `error` before the xhr-level `loadend`, which is what lets the
        // `error` rejection win the race against `loadend`'s status-0.
        this.upload.listeners['loadend']?.forEach((cb) => cb({ loaded: 0 }));
        this.emit('error');
        this.emit('loadend');
        return;
      }
      this.upload.listeners['progress']?.forEach((cb) => cb({ loaded: body.size }));
      this.upload.listeners['loadend']?.forEach((cb) => cb({ loaded: body.size }));
      // The response phase. Kept un-`settled` until the answer lands so an abort DURING the
      // wait still emits its events — otherwise a watchdog that wrongly policed this phase
      // would be invisible here, and the mutation proving it does not would pass.
      const respond = () => {
        if (this.settled) return;
        this.settled = true;
        this.readyState = 4;
        this.status = res.status;
        if (res.etag) this.headers['ETag'] = res.etag;
        partLoadTimes.push(Date.now());
        this.emit('load');
        this.emit('loadend');
      };
      if (responseDelayMs > 0) setTimeout(respond, responseDelayMs);
      else respond();
    }, 0);
  }
  private emit(type: string) {
    this.listeners[type]?.forEach((cb) => cb({}));
  }
}

/** The `fetch` init shape these cases read. Named so the stub's signature stays one line. */
type FetchInit = { body?: string; signal?: AbortSignal; headers?: Record<string, string> };

function partUrl(partNumber: number) {
  return `https://store.test/upload?part=${partNumber}`;
}

function makeFetch(partCount: number) {
  return vi.fn(async (url: string, init?: FetchInit) => {
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
      relayRequestHeaders.push((init?.headers ?? {}) as Record<string, string>);
      relayCalls++;
      if (relayRejects) throw new TypeError('Failed to fetch');
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

/** Advance the fake clock, inside `act` so React flushes what the advance produced. */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function turnClock() {
  await advance(CLOCK_TURN_MS);
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
  hangAttemptLimit = null;
  hangAfterProgressBytes = null;
  responseDelayMs = 0;
  partSendCounts = new Map();
  inFlight = new Map();
  partLoadTimes = [];
  relayCalls = 0;
  relayResponse = { ok: true, id: RELAY_KEY };
  relayScriptedStatuses = [];
  relayRetryAfterSeconds = null;
  relayTimes = [];
  relayHangsUntilAborted = false;
  relayRejects = false;
  relayStarted = false;
  relayRequestHeaders = [];
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
    expect(abortCalls.map((c) => c.relayOutcome)).toEqual(['rescued']);
    h.unmount();
  });

  it('🔴 identifies itself as the MULTIPART producer on the relay POST', async () => {
    // 🔴 WHY THIS IS ASSERTED THROUGH THE HOOK. The relay's usage counter reads a
    // non-zero success count earned entirely by the OTHER caller — the single-PUT path,
    // which shipped first — so this path cannot be graded on it without a discriminator.
    // `relayImageFallback` sending the header is pinned in
    // `src/utils/__tests__/upload-settlement.test.ts`; what only this file can see is
    // that the hook's real rescue arrives carrying it, which is the claim anyone reading
    // `producer="multipart"` in production is relying on.
    vi.stubGlobal('fetch', makeFetch(1));
    partHandler = () => ({ status: 0, networkError: true });
    const h = await mountHook();

    await runUpload(h, makeFile(CHUNK), UploadType.Image);

    // Positive control: without it, a run where no relay happened would satisfy an
    // every()-style assertion over an empty list.
    expect(relayRequestHeaders).toHaveLength(1);
    // An EQUALITY, not a presence check: sending the other caller's label here is the
    // mutation that silently restores the attribution error while looking like a working
    // discriminator, and only an equality can see it.
    expect(relayRequestHeaders[0][IMAGE_UPLOAD_RELAY_PRODUCER_HEADER]).toBe('multipart');
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
    // 🔴 THE DISCRIMINATION THAT MATTERS: the gate declining and the relay running-and-failing
    // are different populations, and one failure value put them on one row.
    expect(abortCalls.map((c) => c.relayOutcome)).toEqual(['not_attempted']);
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
    // A cancel mid-relay is not a relay that failed, and it reaches the same `catch` as a dead
    // network — so without this the two are one row.
    expect(abortCalls.map((c) => c.relayOutcome)).toEqual(['aborted']);
    h.unmount();
  });

  it('falls back to the original failure when the relay itself refuses', async () => {
    // `relayImageFallback` returns `ok: false` for EVERY failure, so a broken fallback
    // degrades to the pre-existing outcome — "the upload failed" — rather than replacing the
    // user's real diagnosis with a fallback error. Without this case the refusal path is
    // declared by the harness and exercised by nothing.
    vi.stubGlobal('fetch', makeFetch(1));
    partHandler = () => ({ status: 0, networkError: true });
    // 🔴 The refusal carries an id ANYWAY. With `{ ok: false }` alone it is the MISSING id
    // that produces the failure, so deleting `relayImageFallback`'s
    // `if (!res.ok) return { ok: false, reason: 'non_2xx' }` would leave this green — the
    // case would be pinning the harness rather than the status check. Measured: it survives
    // that mutation without this id.
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

  it.each([
    [
      'transport_error',
      'the relay could not be reached',
      () => {
        relayRejects = true;
      },
    ],
    [
      'non_2xx',
      'our own origin answered and refused',
      () => {
        relayResponse = { ok: false, id: RELAY_KEY };
      },
    ],
    [
      'bad_body',
      'the relay answered 2xx carrying no id',
      () => {
        relayResponse = { ok: true };
      },
    ],
  ])('reports %s on the abort POST when %s', async (expected, _why, arrange) => {
    vi.stubGlobal('fetch', makeFetch(1));
    partHandler = () => ({ status: 0, networkError: true });
    arrange();
    const h = await mountHook();

    const result = await runUpload(h, makeFile(CHUNK), UploadType.Image);

    // Positive control: a run where the relay never fired would satisfy the row below with
    // `not_attempted` and read as a working discriminator.
    expect(relayCalls).toBe(1);
    expect(abortCalls.map((c) => c.relayOutcome)).toEqual([expected]);
    // 🔴 The caller's behaviour is UNCHANGED by the new result shape: every failure still
    // degrades to the pre-existing terminal error, reporting the presigned key and no url.
    expect(result).toMatchObject({ url: null, key: UPLOAD_IDENTITY.key });
    expect(h.statuses()).toEqual(['error']);
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

/**
 * THE SEAM AGAIN, for the same reason.
 *
 * `XMLHttpRequest.timeout` defaults to 0 — wait forever — so a part whose connection goes
 * half-open fires neither `error` nor `load`: the row froze at its last progress value, the
 * fatal slot was never written, the relay could not run and NOTHING was logged. A test that
 * only asserts the watchdog's timer fired would also pass against a watchdog whose abort
 * records the user-cancel shape, which `shouldRelayOnPartFailure` refuses on `err.aborted` —
 * the inert-gate defect this code has shipped twice. So these assert the relay POST.
 */
describe('useS3Upload part stall watchdog', () => {
  /** Comfortably past the hook's 30s window at the 60s clock turn the harness uses. */
  const SLOW_RESPONSE_MS = 90_000;

  it('relays a part that sent some bytes and then went silent', async () => {
    // 🔴 THE DECISIVE CASE. Before the watchdog this upload never settles at all: the PUT
    // hangs forever, so `runUpload` exhausts its clock budget and throws rather than failing
    // an assertion. Every gate in `shouldRelayOnPartFailure` is satisfied — image type, image
    // backend, a file far under the cap, a network-layer failure that nobody cancelled.
    vi.stubGlobal('fetch', makeFetch(1));
    hangPartNumbers = [1];
    hangAfterProgressBytes = CHUNK / 2;
    const h = await mountHook();

    const result = await runUpload(h, makeFile(CHUNK), UploadType.Image);

    // The watchdog aborted the part, the error survived the retry ladder as relay-eligible,
    // and the relay actually ran. An `aborted: true` watchdog abort fails here.
    expect(relayCalls).toBe(1);
    expect(result).toMatchObject({ url: RELAY_KEY, key: RELAY_KEY });
    expect(h.statuses()).toEqual(['success']);
    expect(h.progresses()).toEqual([100]);
    // 🔴 `stalled`, not `network-error`: a half-open connection and a real reset call for
    // different fixes, and one kind for both is how the stall population stays invisible.
    expect(abortCalls.map((c) => c.failure)).toEqual([{ kind: 'stalled', partNumber: 1 }]);
    expect(abortCalls.map((c) => c.relayOutcome)).toEqual(['rescued']);
    // The ladder was walked, not short-circuited — MAX_PART_ATTEMPTS PUTs for the one part.
    expect(partSendCounts.get(1)).toBe(MAX_PART_ATTEMPTS);
    h.unmount();
  });

  it('retries a stall that recovers, and never reaches the relay', async () => {
    // A stall is transient far more often than it is fatal, so it must ride the ordinary
    // network-error retry path. Only an exhausted part is owed a relay.
    vi.stubGlobal('fetch', makeFetch(1));
    hangPartNumbers = [1];
    hangAttemptLimit = 1;
    hangAfterProgressBytes = CHUNK / 2;
    const h = await mountHook();

    const result = await runUpload(h, makeFile(CHUNK), UploadType.Image);

    expect(relayCalls).toBe(0);
    // Positive control: a stall that was never provoked would satisfy everything below.
    expect(partSendCounts.get(1)).toBe(2);
    expect(result).toMatchObject({ key: UPLOAD_IDENTITY.key });
    expect(h.statuses()).toEqual(['success']);
    // Nothing gave up, so the session was completed rather than torn down.
    expect(abortCalls).toEqual([]);
    h.unmount();
  });

  it('does not abort a part whose body is sent and whose response is slow', async () => {
    // 🔴 WHY `upload.loadend` CLEARS THE TIMER. Once the body is fully sent, `upload.progress`
    // stops because there is nothing left to send — not because the connection died. Treating
    // that wait as a stall kills a healthy upload against a slow backend, and the harm is
    // invisible in production: the part is retried, so it looks like a flaky network.
    vi.stubGlobal('fetch', makeFetch(1));
    responseDelayMs = SLOW_RESPONSE_MS;
    const h = await mountHook();

    const t0 = Date.now();
    const result = await runUpload(h, makeFile(CHUNK), UploadType.Image);

    // ONE PUT: the part was never aborted and re-sent. Asserted first because it is the
    // legible reading of a watchdog that policed the response phase — `expected 5 to be 1`
    // says the part was killed and retried, where the timing control below reads `NaN`.
    expect(partSendCounts.get(1)).toBe(1);
    expect(relayCalls).toBe(0);
    expect(abortCalls).toEqual([]);
    expect(result).toMatchObject({ key: UPLOAD_IDENTITY.key });
    expect(h.statuses()).toEqual(['success']);
    // 🔴 THE POSITIVE CONTROL, and the case is vacuous without it: if the harness ignored
    // `responseDelayMs` the part would answer instantly, there would be no silent window at
    // all, and every assertion above would hold against a watchdog that polices this phase.
    // Last, so a real regression reports itself before this reports the harness.
    expect(partLoadTimes[0] - t0).toBeGreaterThanOrEqual(SLOW_RESPONSE_MS);
    h.unmount();
  });

  it('reports error, not a stall, when a stalled part cannot relay', async () => {
    // The stall kind is a diagnostic, not a status: a non-image backend still owes the user an
    // error row, and the abort stream still gets the real reason.
    vi.stubGlobal('fetch', makeFetch(1));
    backend = 'b2';
    hangPartNumbers = [1];
    hangAfterProgressBytes = CHUNK / 2;
    const h = await mountHook();

    const result = await runUpload(h, makeFile(CHUNK), UploadType.Model);

    expect(relayCalls).toBe(0);
    expect(result).toMatchObject({ url: null, key: UPLOAD_IDENTITY.key });
    expect(h.statuses()).toEqual(['error']);
    expect(abortCalls.map((c) => c.failure)).toEqual([{ kind: 'stalled', partNumber: 1 }]);
    expect(abortCalls.map((c) => c.relayOutcome)).toEqual(['not_attempted']);
    h.unmount();
  });
});

/**
 * THE WATCHDOG AGAINST A BACKGROUNDED TAB.
 *
 * The thing a stall watchdog must not do is kill a transfer that was merely suspended, and
 * switching apps mid-upload is routine on a phone — the population this whole PR is for.
 * Chromium backgrounds a tab in two ways and they need different handling, so both are
 * modelled here:
 *
 *   THROTTLED — timers still run, roughly one per minute, so a window armed before the tab
 *     went away expires while it is still hidden. Modelled by advancing the fake clock.
 *   FROZEN — timers do not run at all while wall-clock time passes, so what is pending on
 *     resume is a window that is already overdue. Modelled by `vi.setSystemTime`, which moves
 *     `Date.now()` without running a single timer.
 *
 * 🔴 No progress-delta or elapsed-time check could tell either apart from a dead radio: no
 * bytes move in either case. Only `visibilityState` can, which is why these cases drive it.
 */
describe('useS3Upload part stall watchdog across a backgrounded tab', () => {
  /** Mirrors `createPartStallWatchdog`'s window, which is not exported. */
  const STALL_WINDOW_MS = 30_000;
  /** Long enough that no window measured from BEFORE the tab went away can survive it. */
  const HIDDEN_WALL_CLOCK_MS = 10 * 60_000;

  let visibility: DocumentVisibilityState;
  /** Live `visibilitychange` callbacks, by identity — a leak is a count that never falls. */
  let liveListeners: Set<unknown>;
  let listenerAdds: number;

  beforeEach(() => {
    visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibility,
    });
    liveListeners = new Set();
    listenerAdds = 0;
    const realAdd = document.addEventListener.bind(document);
    const realRemove = document.removeEventListener.bind(document);
    vi.spyOn(document, 'addEventListener').mockImplementation((type, cb, opts) => {
      if (type === 'visibilitychange') {
        listenerAdds++;
        liveListeners.add(cb);
      }
      return realAdd(type, cb, opts);
    });
    vi.spyOn(document, 'removeEventListener').mockImplementation((type, cb, opts) => {
      if (type === 'visibilitychange') liveListeners.delete(cb);
      return realRemove(type, cb, opts);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // happy-dom defines `visibilityState` on the prototype, so dropping the own property
    // put there above restores the real getter.
    delete (document as unknown as { visibilityState?: unknown }).visibilityState;
  });

  const setVisibility = async (next: DocumentVisibilityState) => {
    visibility = next;
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
  };

  it('does not abort a part whose transfer resumes after the tab comes back', async () => {
    // 🔴 THE CASE THE FIX EXISTS FOR. A part sends half its bytes, the person switches apps,
    // ten minutes pass, they come back and the transfer continues. Nothing here is wrong with
    // the upload, and a watchdog that counts hidden time against it re-sends up to 25 MB of
    // somebody's cellular data per attempt, five attempts deep.
    vi.stubGlobal('fetch', makeFetch(1));
    hangPartNumbers = [1];
    hangAfterProgressBytes = CHUNK / 2;
    const h = await mountHook();

    const result = await runUpload(h, makeFile(CHUNK), UploadType.Image, async () => {
      await advanceUntil(() => inFlight.has(1), 'the first PUT');
      // Foreground silence, inside the window: nothing has given up yet, so what follows is
      // attributable to the tab going away rather than to time already spent.
      await advance(STALL_WINDOW_MS - 5_000);
      await setVisibility('hidden');
      // THROTTLED: the window expires here, while hidden. Whatever is left of it afterwards
      // is deliberately short, so the FROZEN half below is decisive on its own.
      await advance(STALL_WINDOW_MS + 25_000);
      expect(partSendCounts.get(1)).toBe(1);
      // FROZEN, then the return.
      vi.setSystemTime(Date.now() + HIDDEN_WALL_CLOCK_MS);
      await setVisibility('visible');
      // Past what was left of the pre-freeze window, inside one measured from the return.
      await advance(10_000);
      inFlight.get(1)!.emitProgress(CHUNK * 0.75);
      inFlight.get(1)!.finishOk(CHUNK);
    });

    // ONE PUT: the part was never aborted and re-sent. Asserted first because it is the
    // legible reading of a watchdog that counted hidden time — `expected 2 to be 1`.
    expect(partSendCounts.get(1)).toBe(1);
    expect(relayCalls).toBe(0);
    expect(abortCalls).toEqual([]);
    expect(result).toMatchObject({ key: UPLOAD_IDENTITY.key });
    expect(h.statuses()).toEqual(['success']);
    h.unmount();
  });

  it('aborts a part still silent a full window after the tab comes back, and relays it', async () => {
    // The mirror, and the negative control for the case above: hidden time buying a reprieve
    // must not buy immunity. A part that is still silent once the person is watching is dead,
    // and is owed the abort, the `stalled` kind and the relay rescue.
    vi.stubGlobal('fetch', makeFetch(1));
    hangPartNumbers = [1];
    hangAfterProgressBytes = CHUNK / 2;
    const h = await mountHook();

    const result = await runUpload(h, makeFile(CHUNK), UploadType.Image, async () => {
      await advanceUntil(() => inFlight.has(1), 'the first PUT');
      await setVisibility('hidden');
      await advance(STALL_WINDOW_MS + 25_000);
      vi.setSystemTime(Date.now() + HIDDEN_WALL_CLOCK_MS);
      await setVisibility('visible');
      // 🔴 THE CLAIM: the window is measured from the RETURN, not from the last byte. This
      // part has been silent for over ten minutes of wall clock and is still not given up on
      // five seconds short of a full foreground window.
      await advance(STALL_WINDOW_MS - 5_000);
      expect(partSendCounts.get(1)).toBe(1);
    });

    // The ladder was walked once the tab was back, and the stall reached the relay.
    expect(partSendCounts.get(1)).toBe(MAX_PART_ATTEMPTS);
    expect(abortCalls.map((c) => c.failure)).toEqual([{ kind: 'stalled', partNumber: 1 }]);
    expect(relayCalls).toBe(1);
    expect(result).toMatchObject({ url: RELAY_KEY, key: RELAY_KEY });
    expect(h.statuses()).toEqual(['success']);
    // Five aborted attempts' worth of listeners, all gone. The abort path's half of the leak
    // assertion below, which rides the success path.
    expect(liveListeners.size).toBe(0);
    h.unmount();
  });

  it('leaves no visibilitychange listener behind once the parts have settled', async () => {
    // One `document` listener per part attempt, four parts in flight at a time, many parts
    // per file: a watchdog that does not unregister leaks for the life of the page, and every
    // leaked listener re-arms a timer for a part that finished long ago.
    const PARTS = 8;
    vi.stubGlobal('fetch', makeFetch(PARTS));
    const h = await mountHook();

    await runUpload(h, makeFile(CHUNK * PARTS), UploadType.Image);

    expect(h.statuses()).toEqual(['success']);
    // 🔴 THE POSITIVE CONTROL, and the case is vacuous without it: a watchdog that registered
    // nothing at all also ends with zero live listeners.
    expect(listenerAdds).toBe(PARTS);
    expect(liveListeners.size).toBe(0);
    h.unmount();
  });
});
