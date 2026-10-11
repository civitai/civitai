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
/** Under the hook's 30s silence window, so a steady trickle has to keep re-arming it. */
const SLOW_BODY_STEP_MS = 20_000;
/** 20s x 30 = ten minutes of body, which is what 25 MB on a weak mobile link looks like. */
const SLOW_BODY_STEPS = 30;
/** Mirrors `PART_RESPONSE_TIMEOUT_MS` in the hook, which is not exported. */
const RESPONSE_WINDOW_MS = 5 * 60_000;
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
 * A hanging part sends its WHOLE body first, so the silence falls in the response phase.
 *
 * 🔴 The other half of the half-open connection, and the one the two phases treat differently:
 * every byte left, `upload.loadend` fired, and the ETag reply never comes. The knobs above all
 * go silent mid-body, so without this the response phase can only be driven by a timer the test
 * also has to advance — which cannot model a tab that is hidden across the wait.
 */
let hangAfterBodySent: boolean;
/**
 * How long the server takes to answer AFTER the body is fully sent. The healthy-but-slow case
 * that a progress watchdog must not kill: `upload.progress` has stopped because there is
 * nothing left to send, not because the connection died.
 */
let responseDelayMs: number;
/**
 * Fake-clock gap between a part's `upload.progress` events, and how many it emits before the
 * body is fully sent. `null` sends the whole body in one event.
 *
 * 🔴 BYTES MOVING SLOWLY BUT STEADILY — the shape no other knob here can express, and the one
 * the watchdog's entire design rests on. Without it every fixture sends a part's whole body
 * inside a single tick, so nothing distinguishes "bounds the silence between chunks" from
 * "caps each part attempt's total body duration", and the second reading loses every part on
 * any link slow enough to need 30s for a 25 MB chunk.
 */
let bodyProgressStepMs: number | null;
let bodyProgressSteps: number;
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
  timeout = 0;
  private url = '';
  private headers: Record<string, string> = {};
  private listeners: Record<string, ((e: unknown) => void)[]> = {};
  private settled = false;
  private uploadComplete = false;

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
  /**
   * 🔴 `abort()` runs XHR's REQUEST-ERROR STEPS, the same ones the transport-failure path below
   * runs — so while the upload-complete flag is unset it fires `upload.loadend` FIRST, and only
   * then the xhr-level `abort`. Emitting just the xhr-level pair (which this fake did) hides a
   * whole defect class, because production's own watchdog aborts mid-body: its `upload.loadend`
   * handler then runs before the `abort` handler, and anything that handler writes is read by
   * the rejection as if the body had got through. One kind of stall reported as the other, with
   * four cases green either way.
   *
   * The guard is the spec's: those upload events fire only while the body is still in flight, so
   * an abort DURING the response phase emits no second `upload.loadend`. The `upload`-level
   * `abort`/`error` events themselves are not modelled — neither upload client listens for them.
   */
  abort() {
    if (this.settled) return;
    this.settled = true;
    this.readyState = 4;
    this.status = 0;
    this.emitUploadLoadend(0);
    this.emit('abort');
    this.emit('loadend');
  }
  /** A resumed transfer reporting bytes again, at a moment the case chooses. */
  emitProgress(loaded: number) {
    this.upload.listeners['progress']?.forEach((cb) => cb({ loaded }));
  }
  /** `upload.loadend`, fired at most once per request — the spec's upload-complete flag. */
  private emitUploadLoadend(loaded: number) {
    if (this.uploadComplete) return;
    this.uploadComplete = true;
    this.upload.listeners['loadend']?.forEach((cb) => cb({ loaded }));
  }
  /** Finish a hand-driven part: body fully sent, then the response. */
  finishOk(loaded: number) {
    if (this.settled) return;
    this.emitUploadLoadend(loaded);
    this.respondOk();
  }
  /** Answer a part whose body this fake has already finished sending. */
  respondOk() {
    if (this.settled) return;
    this.settled = true;
    this.readyState = 4;
    this.status = 200;
    this.headers['ETag'] = 'etag';
    partLoadTimes.push(Date.now());
    this.emit('load');
    this.emit('loadend');
  }
  /**
   * XHR's own total-duration timer, measured from `send()` rather than from whenever `timeout`
   * was assigned.
   *
   * 🔴 Production sets no `timeout`, so this is inert against the current hook — and it is kept
   * for exactly that reason. It is the only thing that makes re-introducing `xhr.timeout` for the
   * response phase REPORTABLE: the hidden-tab case below counts hidden wall clock against the
   * part and goes red. Delete this and that regression ships green.
   */
  private armTimeout(sentAt: number) {
    if (!this.timeout) return;
    setTimeout(() => {
      if (this.settled) return;
      this.settled = true;
      this.readyState = 4;
      this.status = 0;
      this.emit('timeout');
      this.emit('loadend');
    }, Math.max(0, this.timeout - (Date.now() - sentAt)));
  }
  send(body: Blob) {
    const partNumber = Number(new URL(this.url, 'https://store.test').searchParams.get('part'));
    const attempt = (partSendCounts.get(partNumber) ?? 0) + 1;
    partSendCounts.set(partNumber, attempt);
    inFlight.set(partNumber, this);
    const sentAt = Date.now();
    setTimeout(() => {
      if (this.settled) return;
      if (
        hangPartNumbers.includes(partNumber) &&
        (hangAttemptLimit === null || attempt <= hangAttemptLimit)
      ) {
        // Deliberately NOT `settled`: the request is still open, so an abort from the hook's
        // watchdog still reaches `abort()` and emits its events, the way a real one does.
        if (hangAfterBodySent) {
          this.upload.listeners['progress']?.forEach((cb) => cb({ loaded: body.size }));
          this.emitUploadLoadend(body.size);
          // Read AFTER the handler, like the `bodySent` helper below: a response-phase
          // `xhr.timeout` is assigned there, so arming first would make that bound untestable.
          this.armTimeout(sentAt);
          return; // in flight until the test answers it, or the hook gives up
        }
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
        this.emitUploadLoadend(0);
        this.emit('error');
        this.emit('loadend');
        return;
      }
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
      const bodySent = () => {
        this.emitUploadLoadend(body.size);
        // Read AFTER the handler, since `upload.loadend` is where the hook assigns it.
        this.armTimeout(sentAt);
        if (responseDelayMs > 0) setTimeout(respond, responseDelayMs);
        else respond();
      };
      if (bodyProgressStepMs === null) {
        this.upload.listeners['progress']?.forEach((cb) => cb({ loaded: body.size }));
        return bodySent();
      }
      let sentSteps = 0;
      const emitStep = () => {
        if (this.settled) return;
        sentSteps++;
        this.upload.listeners['progress']?.forEach((cb) =>
          cb({ loaded: Math.round((body.size * sentSteps) / bodyProgressSteps) })
        );
        if (sentSteps < bodyProgressSteps) setTimeout(emitStep, bodyProgressStepMs as number);
        else bodySent();
      };
      setTimeout(emitStep, bodyProgressStepMs);
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
};

/**
 * Teardown for everything a case mounted, run from `afterEach`.
 *
 * 🔴 NOT the last statement of each `it`, which is what this file used to do. A case that throws
 * inside `runUpload` never reaches its own teardown, and what it leaks is not inert: the upload
 * keeps RUNNING, and `partSendCounts` is a module-level map the fake writes to by reference at
 * send time — so the leaked retry ladder lands its PUTs in the NEXT case's freshly reset map.
 * Measured: ONE broken `arm()` reported as THREE failing tests, two of them in a describe that
 * was fine, each off by exactly the leaked ladder's remaining attempts, which sends a bisect at
 * the wrong file.
 *
 * 🔴 Unmounting is NOT enough, and that is the measurement worth keeping: React unmount does not
 * cancel an in-flight upload (`FileUploadProvider`'s own unmount effect aborts nothing either),
 * so the counts stayed inflated until the cancel below was added. The cancel is also what drops
 * the leaked `visibilitychange` listener, since that happens in the watchdog's `clear`.
 */
let mountedRoots: (() => Promise<void>)[];

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
  mountedRoots.push(async () => {
    await act(async () => {
      for (const f of api?.files ?? []) f.abort();
    });
    await act(() => root.unmount());
  });
  return {
    upload: (file, type) =>
      api!.uploadToS3(file, type) as Promise<{ url: string | null; key: string }>,
    statuses: () => api!.files.map((f) => f.status),
    progresses: () => api!.files.map((f) => f.progress),
    cancel: () => api!.files[0].abort(),
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
  mountedRoots = [];
  backend = 'backblaze';
  hangPartNumbers = [];
  hangAttemptLimit = null;
  hangAfterProgressBytes = null;
  hangAfterBodySent = false;
  responseDelayMs = 0;
  bodyProgressStepMs = null;
  bodyProgressSteps = 1;
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

afterEach(async () => {
  for (const unmount of mountedRoots) await unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/**
 * THE HARNESS'S OWN EVENT ORDER, pinned structurally rather than in the prose on `abort()`.
 *
 * Every case below that distinguishes a mid-body `stalled` from a `response-stalled` one depends
 * on `abort()` firing `upload.loadend` BEFORE the xhr-level `abort`, because that is the order
 * production's phase sampling has to be correct against. Measured: delete that one emission and
 * this file stays green — delete it and restore the sampling bug and it stays green as well. So
 * the order is asserted directly here, where de-conforming the fake fails loudly instead of
 * silently vacuuming those assertions.
 */
describe('FakeXHR conformance', () => {
  it('🔴 fires upload.loadend before the xhr-level abort while the body is in flight', () => {
    // A fresh instance has its upload-complete flag unset, which is what "mid-body" is here.
    const xhr = new FakeXHR();
    const order: string[] = [];
    xhr.upload.addEventListener('loadend', () => order.push('upload.loadend'));
    xhr.addEventListener('abort', () => order.push('abort'));
    xhr.addEventListener('loadend', () => order.push('loadend'));

    xhr.abort();

    expect(order).toEqual(['upload.loadend', 'abort', 'loadend']);
  });
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
  });

  it('🔴 does not abort a part whose body moves slowly but steadily for ten minutes', async () => {
    // 🔴 THE CENTRAL DESIGN PROPERTY, and the only case that can see it: the window bounds the
    // SILENCE between chunks, not how long a part takes to send. Delete the `arm()` in the
    // `upload.progress` handler and the watchdog becomes a flat 30s cap on each part attempt's
    // body — at the production 25 MB chunk size, every link under ~6.7 Mbps then loses EVERY
    // part at 30s, five attempts deep, each re-sent from byte 0 and reported as a stall. Mobile
    // is the population this PR is for, so that is the expensive direction.
    vi.stubGlobal('fetch', makeFetch(1));
    bodyProgressStepMs = SLOW_BODY_STEP_MS;
    bodyProgressSteps = SLOW_BODY_STEPS;
    const h = await mountHook();

    const t0 = Date.now();
    const result = await runUpload(h, makeFile(CHUNK), UploadType.Image);

    // ONE PUT: never aborted, never re-sent. First, because it is the legible reading of a
    // watchdog that bounds duration instead of silence — `expected 5 to be 1`.
    expect(partSendCounts.get(1)).toBe(1);
    expect(relayCalls).toBe(0);
    expect(abortCalls).toEqual([]);
    expect(result).toMatchObject({ key: UPLOAD_IDENTITY.key });
    expect(h.statuses()).toEqual(['success']);
    // 🔴 THE POSITIVE CONTROL, and the case is vacuous without it: if the harness ignored the
    // step knob the body would leave in one event, there would be no silence to survive at all,
    // and every assertion above would hold against a watchdog that never re-arms.
    expect(partLoadTimes[0] - t0).toBeGreaterThanOrEqual(SLOW_BODY_STEP_MS * SLOW_BODY_STEPS);
  });

  it('relays a part that never sent a single byte', async () => {
    // The connect/TLS stall, and the only case that reaches the `arm()` before `send()`: no
    // `upload.progress` ever fires, so with the progress handler's `arm()` alone nothing arms
    // and the upload never settles. That is the shape a future consolidation of the two `arm()`
    // calls into the progress handler would reintroduce.
    vi.stubGlobal('fetch', makeFetch(1));
    hangPartNumbers = [1];
    hangAfterProgressBytes = null;
    const h = await mountHook();

    const result = await runUpload(h, makeFile(CHUNK), UploadType.Image);

    expect(relayCalls).toBe(1);
    expect(result).toMatchObject({ url: RELAY_KEY, key: RELAY_KEY });
    expect(h.statuses()).toEqual(['success']);
    expect(h.progresses()).toEqual([100]);
    expect(abortCalls.map((c) => c.failure)).toEqual([{ kind: 'stalled', partNumber: 1 }]);
    expect(abortCalls.map((c) => c.relayOutcome)).toEqual(['rescued']);
    expect(partSendCounts.get(1)).toBe(MAX_PART_ATTEMPTS);
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
  });

  it('does not abort a part whose body is sent and whose response is slow', async () => {
    // 🔴 WHY `upload.loadend` WIDENS THE WINDOW RATHER THAN KEEPING THE BODY'S. Once the body is
    // fully sent, `upload.progress` stops because there is nothing left to send — not because the
    // connection died — and nothing re-arms the window again. Holding it at 30s kills a healthy
    // upload against a slow backend, and the harm is invisible in production: the part is
    // retried, so it looks like a flaky network.
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
  });
});

/**
 * THE RESPONSE PHASE, which the watchdog polices on a window of its own.
 *
 * `upload.progress` stops when the body is fully sent, so the body's window cannot be left
 * running across the wait that follows — and until it was WIDENED instead, the response wait was
 * bounded by nothing at all, because `xhr.timeout` defaults to 0. A connection going half-open
 * AFTER the body is sent therefore never ended: `useMediaUpload` runs two workers and decrements
 * its counter in a `finally`, so one such part holds a slot for the life of the page, and the
 * dropzone then accepts files that never upload — the symptom this PR exists to remove.
 */
describe('useS3Upload part response timeout', () => {
  /** Past the window by enough that no clock-turn granularity can confuse the two. */
  const NEVER_RESPONDS_MS = 60 * 60_000;

  it('gives up on a part whose response never arrives, and relays it', async () => {
    vi.stubGlobal('fetch', makeFetch(1));
    responseDelayMs = NEVER_RESPONDS_MS;
    const h = await mountHook();

    const result = await runUpload(h, makeFile(CHUNK), UploadType.Image);

    // 🔴 THE POSITIVE CONTROL: no part ever answered, so what ended the request was the bound
    // and not the backend. Without it the case holds against a harness that responded promptly.
    expect(partLoadTimes).toEqual([]);
    // The ladder was walked, and the same relay-eligible shape the body phase produces carried it
    // to the rescue — an abort recording the user-cancel shape reaches no relay.
    expect(partSendCounts.get(1)).toBe(MAX_PART_ATTEMPTS);
    expect(relayCalls).toBe(1);
    expect(result).toMatchObject({ url: RELAY_KEY, key: RELAY_KEY });
    expect(h.statuses()).toEqual(['success']);
    // 🔴 `response-stalled`, and this is the only producer of it: the host took every byte and
    // never answered. The mid-body producer's `stalled` is pinned by the watchdog cases above,
    // and one kind for both is how whichever population is rarer stays invisible.
    expect(abortCalls.map((c) => c.failure)).toEqual([{ kind: 'response-stalled', partNumber: 1 }]);
    expect(abortCalls.map((c) => c.relayOutcome)).toEqual(['rescued']);
  });

  it('🔴 does not time out a slow body whose response then arrives promptly', async () => {
    // 🔴 WHY THE RESPONSE WINDOW IS MEASURED FROM THE BODY'S END, NOT FROM `send()`. Any
    // total-duration bound — `xhr.timeout` being the obvious one, since the spec measures it from
    // `send()` — has already expired on a part whose body outlasted it, so the part dies the
    // instant its last byte lands: precisely the slow-link harm a duration cap on the body would
    // have caused, reintroduced one phase later.
    vi.stubGlobal('fetch', makeFetch(1));
    bodyProgressStepMs = SLOW_BODY_STEP_MS;
    bodyProgressSteps = SLOW_BODY_STEPS;
    responseDelayMs = 30_000;
    const h = await mountHook();

    const t0 = Date.now();
    const result = await runUpload(h, makeFile(CHUNK), UploadType.Image);

    expect(partSendCounts.get(1)).toBe(1);
    expect(abortCalls).toEqual([]);
    expect(result).toMatchObject({ key: UPLOAD_IDENTITY.key });
    expect(h.statuses()).toEqual(['success']);
    // 🔴 THE POSITIVE CONTROL: the body alone has to outlast the response window, or a flat
    // window would never have expired and the case would pin nothing.
    expect(partLoadTimes[0] - t0).toBeGreaterThan(RESPONSE_WINDOW_MS);
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
  });

  it('🔴 does not give up on a response the tab was hidden across', async () => {
    // 🔴 THE PHASE BOUNDARY'S OWN REGRESSION. The response wait was once bounded by
    // `xhr.timeout`, which is a browser timer: it counts wall clock while the tab is hidden,
    // and the watchdog that knows about `visibilityState` had been cleared one line earlier. So
    // backgrounding the tab between the last body byte and the ETag reply cost a re-sent part —
    // up to 25 MB of somebody's cellular data, five attempts deep, for an upload that was
    // merely suspended. That is the exact harm the body phase is protected from, one phase later.
    vi.stubGlobal('fetch', makeFetch(1));
    hangPartNumbers = [1];
    hangAfterBodySent = true;
    const h = await mountHook();

    const t0 = Date.now();
    const result = await runUpload(h, makeFile(CHUNK), UploadType.Image, async () => {
      await advanceUntil(() => inFlight.has(1), 'the first PUT');
      await setVisibility('hidden');
      // THROTTLED, which is the accurate model here: a browser timer keeps counting while
      // hidden, so this is the advance a wall-clock bound cannot survive. Well past the
      // response window, and past it again.
      await advance(RESPONSE_WINDOW_MS + HIDDEN_WALL_CLOCK_MS);
      // Asserted here as well as below so the regression reports at the moment it happens,
      // rather than as a relay count after the ladder has been walked.
      expect(partSendCounts.get(1)).toBe(1);
      await setVisibility('visible');
      // 🔴 PAST THE BODY'S WINDOW, INSIDE THE RESPONSE ONE. Deliberately not a few seconds: the
      // widened window has to SURVIVE the hidden stretch, and a watchdog that re-armed its way
      // back down to the body's 30s while hidden would look identical for any shorter wait.
      await advance(STALL_WINDOW_MS * 4);
      inFlight.get(1)!.respondOk();
    });

    // ONE PUT: never aborted, never re-sent.
    expect(partSendCounts.get(1)).toBe(1);
    expect(relayCalls).toBe(0);
    expect(abortCalls).toEqual([]);
    expect(result).toMatchObject({ key: UPLOAD_IDENTITY.key });
    expect(h.statuses()).toEqual(['success']);
    // 🔴 THE POSITIVE CONTROL, and the case is vacuous without it: if the harness ignored
    // `hangAfterBodySent` the part would answer inside the same tick, there would be no
    // response-phase silence to survive, and every assertion above would hold against a bound
    // that counts hidden time.
    expect(partLoadTimes[0] - t0).toBeGreaterThan(RESPONSE_WINDOW_MS);
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
  });
});
