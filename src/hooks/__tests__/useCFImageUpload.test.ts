// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';

/**
 * `uploadToCF` — the PROMISE is the contract, and it was broken.
 *
 * The hook's `loadend` listener used to compute `success` and then `resolve(success)`
 * on EVERY outcome. XHR fires `error` only on a NETWORK failure, so a PUT that
 * reaches the store and is refused — an expired presign (403), a malformed request
 * (400), a store that is briefly unavailable (503) — completes normally, lands on
 * `load` → `loadend`, and was reported to the caller as a successful upload. Every
 * caller discards that boolean and `uploadToCF` returns `{ url, id, ... }`
 * unconditionally, so consumers persisted a media key with nothing behind it.
 *
 * 🔴 These assert the PROMISE OUTCOME, not the tracked-file UI state. The UI state
 * was already wrong here (a refused PUT left the tile on `uploading`) but only
 * cosmetically; the promise is what the row was written from. One case below does
 * additionally pin the tracked status, and it is the ABORT one — because `abort` is
 * followed by its own `loadend`, so the new rejecting branch could silently
 * overwrite `aborted` with `error`.
 *
 * Expected values are hand-written literals for what a caller observes, never
 * recomputed from the hook.
 */

// React 18.3 exposes `act` on the `react` export, but our @types/react (18.0.14)
// predates that typing. Use the runtime `React.act` and borrow the typed signature.
const act = (React as unknown as { act: typeof actType }).act;

const { preprocessFileMock, auditImageMetaMock, showErrorNotificationMock } = vi.hoisted(() => ({
  preprocessFileMock: vi.fn(),
  auditImageMetaMock: vi.fn(),
  showErrorNotificationMock: vi.fn(),
}));

// Only the two functions `getDataFromFile` calls are replaced; every other export of
// the module is carried through, so nothing else in the hook's import graph silently
// loses a binding.
vi.mock('~/utils/media-preprocessors', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  preprocessFile: preprocessFileMock,
  auditImageMeta: auditImageMetaMock,
}));
vi.mock('~/utils/notifications', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  showErrorNotification: showErrorNotificationMock,
}));
vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: 1, isModerator: false }),
}));

import { useCFImageUpload } from '~/hooks/useCFImageUpload';

/** The key the (stubbed) /api/v1/image-upload endpoint hands back. */
const UPLOAD_ID = '11111111-2222-4333-8444-555555555555';
const UPLOAD_URL = `https://store.example/${UPLOAD_ID}?signature=abc`;

type Listener = (this: unknown) => void;

/**
 * A hand-rolled XHR double, so each test drives the exact event sequence a real
 * XMLHttpRequest produces. The distinction under test lives entirely in WHICH event
 * fires — a refused PUT emits `load`+`loadend` and NOT `error` — so a double that
 * only exposed a "did it fail" flag could not express the bug at all.
 */
class FakeXhr {
  static instances: FakeXhr[] = [];

  readyState = 0;
  status = 0;
  openedWith: { method: string; url: string } | null = null;
  sentBody: unknown = undefined;
  aborted = false;

  private listeners: Record<string, Listener[]> = {};
  private uploadListeners: Record<string, Listener[]> = {};

  upload = {
    addEventListener: (type: string, handler: Listener) => {
      (this.uploadListeners[type] ??= []).push(handler);
    },
  };

  constructor() {
    FakeXhr.instances.push(this);
  }

  addEventListener(type: string, handler: Listener) {
    (this.listeners[type] ??= []).push(handler);
  }

  open(method: string, url: string) {
    this.openedWith = { method, url };
  }

  send(body: unknown) {
    this.sentBody = body;
  }

  abort() {
    this.aborted = true;
  }

  /** Fire one listener type, as the browser would. */
  emit(type: string) {
    for (const handler of this.listeners[type] ?? []) handler.call(this);
  }

  /** A PUT that got an HTTP answer: `load` then `loadend`. No `error` — that is the point. */
  completeWithStatus(status: number) {
    this.readyState = 4;
    this.status = status;
    this.emit('load');
    this.emit('loadend');
  }

  /** A network failure: `error` then `loadend`, status 0. */
  failWithNetworkError() {
    this.readyState = 4;
    this.status = 0;
    this.emit('error');
    this.emit('loadend');
  }

  /** A cancel: `abort` then `loadend`. */
  cancel() {
    this.readyState = 4;
    this.status = 0;
    this.emit('abort');
    this.emit('loadend');
  }
}

type HookApi = ReturnType<typeof useCFImageUpload>;

function renderUploader() {
  const captured: { current: HookApi | null } = { current: null };
  function Probe() {
    captured.current = useCFImageUpload();
    return null;
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(Probe));
  });
  return {
    get api() {
      if (!captured.current) throw new Error('hook did not render');
      return captured.current;
    },
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

/** Start an upload and wait until the hook has created (and opened) its XHR. */
async function startUpload(api: HookApi) {
  const file = new File([new Uint8Array([1, 2, 3])], 'pic.png', { type: 'image/png' });
  const promise = api.uploadToCF(file);
  // Never leave it unattached — a rejection before the test attaches its own handler
  // would be an unhandled rejection that fails the run for the wrong reason.
  const settled = promise.then(
    (value) => ({ outcome: 'resolved' as const, value }),
    (error: unknown) => ({ outcome: 'rejected' as const, error })
  );
  await vi.waitFor(() => {
    expect(FakeXhr.instances.length).toBe(1);
    expect(FakeXhr.instances[0].openedWith).not.toBeNull();
  });
  return { xhr: FakeXhr.instances[0], settled, file };
}

let originalXhr: typeof XMLHttpRequest;
let originalFetch: typeof fetch;

beforeEach(() => {
  FakeXhr.instances = [];
  preprocessFileMock.mockResolvedValue({
    type: 'image',
    meta: {},
    metadata: { width: 640, height: 480, hash: 'LKO2' },
    objectUrl: 'blob:local-preview',
  });
  auditImageMetaMock.mockResolvedValue({ blockedFor: undefined });

  originalXhr = globalThis.XMLHttpRequest;
  originalFetch = globalThis.fetch;
  globalThis.XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest;
  globalThis.fetch = vi.fn(async () => ({
    json: async () => ({ id: UPLOAD_ID, uploadURL: UPLOAD_URL }),
  })) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.XMLHttpRequest = originalXhr;
  globalThis.fetch = originalFetch;
  vi.clearAllMocks();
});

describe('uploadToCF — a PUT that is refused must REJECT', () => {
  // All three, not just one: 403 is the expired-presign case that produced the
  // production defect, 400 is a malformed request, 500 is the store faulting. They
  // travel the same `load` → `loadend` path and a guard that only names one of them
  // would let the other two through.
  it.each([403, 400, 500])(
    'rejects when the presigned PUT completes with HTTP %i',
    async (status) => {
      const view = renderUploader();
      try {
        const { xhr, settled } = await startUpload(view.api);
        await act(async () => {
          xhr.completeWithStatus(status);
        });
        const result = await settled;
        expect(result.outcome).toBe('rejected');
        expect((result as { error: Error }).error).toBeInstanceOf(Error);
        expect((result as { error: Error }).error.message).toBe(`Upload failed (status ${status})`);
      } finally {
        view.unmount();
      }
    }
  );

  it('marks the tracked file `error` on a refused PUT, so a spinner keyed on `uploading` clears', async () => {
    const view = renderUploader();
    try {
      const { xhr, settled } = await startUpload(view.api);
      await act(async () => {
        xhr.completeWithStatus(403);
      });
      await settled;
      expect(view.api.files.map((f) => f.status)).toEqual(['error']);
    } finally {
      view.unmount();
    }
  });
});

describe('uploadToCF — outcomes that must NOT change', () => {
  it('resolves a 200 with the existing shape', async () => {
    const view = renderUploader();
    try {
      const { xhr, settled } = await startUpload(view.api);
      await act(async () => {
        xhr.completeWithStatus(200);
      });
      const result = await settled;
      expect(result.outcome).toBe('resolved');
      // Literal expectations for what a caller has always observed: the signed URL
      // with its query stripped, the key, the local preview URL, and the media type.
      expect((result as { value: unknown }).value).toEqual({
        url: 'https://store.example/11111111-2222-4333-8444-555555555555',
        id: UPLOAD_ID,
        objectUrl: 'blob:local-preview',
        type: 'image',
      });
      expect(view.api.files.map((f) => f.status)).toEqual(['success']);
    } finally {
      view.unmount();
    }
  });

  it('keeps rejecting on a network `error` event', async () => {
    const view = renderUploader();
    try {
      const { xhr, settled } = await startUpload(view.api);
      await act(async () => {
        xhr.failWithNetworkError();
      });
      const result = await settled;
      expect(result.outcome).toBe('rejected');
      expect((result as { error: Error }).error.message).toBe('Upload failed (status 0)');
    } finally {
      view.unmount();
    }
  });

  it('keeps rejecting on `abort`, and the tracked status stays `aborted`', async () => {
    // 🔴 The regression this guards is specific to the fix: `abort` is followed by a
    // `loadend` whose status is not 200, so the new rejecting branch would run second
    // and overwrite `aborted` with `error` — and change the message the caller sees.
    const view = renderUploader();
    try {
      const { xhr, settled } = await startUpload(view.api);
      await act(async () => {
        xhr.cancel();
      });
      const result = await settled;
      expect(result.outcome).toBe('rejected');
      expect((result as { error: Error }).error.message).toBe('Upload canceled');
      expect(view.api.files.map((f) => f.status)).toEqual(['aborted']);
    } finally {
      view.unmount();
    }
  });

  it('sends the file to the signed URL with PUT', async () => {
    const view = renderUploader();
    try {
      const { xhr, settled, file } = await startUpload(view.api);
      expect(xhr.openedWith).toEqual({ method: 'PUT', url: UPLOAD_URL });
      expect(xhr.sentBody).toBe(file);
      await act(async () => {
        xhr.completeWithStatus(200);
      });
      await settled;
    } finally {
      view.unmount();
    }
  });
});
