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
      this.upload.listeners['progress']?.forEach((cb) => cb({ loaded: body.size }));
      this.upload.listeners['loadend']?.forEach((cb) => cb({ loaded: body.size }));
      if (res.networkError) {
        // The order the browser emits: `error` then `loadend` in the same dispatch, which
        // is what lets the `error` rejection win the race against `loadend`'s status-0.
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

function partUrl(partNumber: number) {
  return `https://store.test/upload?part=${partNumber}`;
}

function makeFetch(partCount: number) {
  return vi.fn(async (url: string, init?: { body?: string }) => {
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
      relayCalls++;
      return {
        ok: relayResponse.ok,
        status: relayResponse.ok ? 200 : 500,
        headers: { get: () => null },
        json: async () => ({ id: relayResponse.id }),
      };
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
    cancel: () => api!.files[0].abort(),
    unmount: () => act(() => root.unmount()),
  };
}

/**
 * Drive an upload to settlement on the fake clock.
 *
 * A network-layer part failure exhausts MAX_PART_ATTEMPTS of exponential backoff before
 * it becomes fatal — ~15s of real sleeping per test. The loop is BOUNDED and throws, so a
 * retry loop that stopped terminating fails with a message rather than wedging the runner
 * on a timeout that is itself a faked timer.
 */
const CLOCK_TURN_MS = 60_000;
const MAX_CLOCK_TURNS = 100;

async function runUpload(h: Harness, file: File, type: UploadType, beforeSettle?: () => void) {
  let settled = false;
  let promise!: Promise<{ url: string | null; key: string }>;
  await act(async () => {
    promise = h.upload(file, type);
    promise.finally(() => {
      settled = true;
    });
    // Let the multipart init and the first PUT start.
    await vi.advanceTimersByTimeAsync(0);
  });
  beforeSettle?.();
  for (let turn = 0; !settled && turn < MAX_CLOCK_TURNS; turn++)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CLOCK_TURN_MS);
    });
  if (!settled)
    throw new Error(
      `upload did not settle within ${MAX_CLOCK_TURNS} clock turns — a retry loop is not terminating`
    );
  return promise;
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
    expect(h.statuses()).toEqual(['success']);
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

  it('does not relay a cancelled upload, and reports it as aborted', async () => {
    // The mirror case, and the negative control for the relay assertion above: a cancelled
    // upload has an owner, not a fallback. If this ever relayed, the person who pressed
    // cancel would have their file uploaded anyway.
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
