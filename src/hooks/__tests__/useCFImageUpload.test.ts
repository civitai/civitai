// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';

// React 18.3 exposes `act` on the `react` export, but our @types/react predates that typing.
const act = (React as unknown as { act: typeof actType }).act;
// Without this React warns on every `act(...)` and does not flush its queue the same way.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));
vi.mock('~/utils/notifications', () => ({ showErrorNotification: vi.fn() }));
vi.mock('~/utils/media-preprocessors', () => ({
  preprocessFile: vi.fn(async () => ({
    type: 'image',
    objectUrl: 'blob:fake-object-url',
    meta: {},
    metadata: { width: 64, height: 48, hash: 'LKO2' },
  })),
  auditImageMeta: vi.fn(async () => ({ blockedFor: undefined })),
}));

import { useCFImageUpload } from '~/hooks/useCFImageUpload';

/** The key the (stubbed) sign endpoint hands back. Distinct from every other literal here. */
const UPLOAD_ID = 'd47b16f0-9a25-4e88-8c31-71fe0a3b62d4';

type Listeners = Record<string, Array<() => void>>;

/**
 * A hand-rolled XHR that lets a test decide which terminal event sequence the browser
 * delivers. The sequences are the ones the spec mandates and they are the whole point of
 * the code under test: `error` and `abort` are EACH FOLLOWED BY `loadend`, while a
 * completed-but-refused request delivers `loadend` alone.
 */
class FakeXHR {
  static last: FakeXHR;
  readyState = 0;
  status = 0;
  upload = { addEventListener: (t: string, f: () => void) => this.add(this.uploadListeners, t, f) };
  private listeners: Listeners = {};
  private uploadListeners: Listeners = {};

  constructor() {
    FakeXHR.last = this;
  }
  private add(bag: Listeners, type: string, fn: () => void) {
    (bag[type] ??= []).push(fn);
  }
  addEventListener(type: string, fn: () => void) {
    this.add(this.listeners, type, fn);
  }
  open() {
    /* no-op */
  }
  send() {
    /* no-op — the test drives the terminal events itself */
  }
  abort() {
    /* no-op */
  }
  private fire(type: string) {
    for (const fn of this.listeners[type] ?? []) fn();
  }
  /** A request that completed with this status, i.e. `load` -> `loadend`, no `error`. */
  completeWith(status: number) {
    this.readyState = 4;
    this.status = status;
    this.fire('loadend');
  }
  /** A transport-level failure: `error` then `loadend`. */
  networkError() {
    this.readyState = 4;
    this.status = 0;
    this.fire('error');
    this.fire('loadend');
  }
  /**
   * A user cancel: `abort` then `loadend`.
   *
   * 🔴 `readyState` is 4 — the same value `src/utils/__tests__/upload-settlement.test.ts`
   * uses, and for the same reason: `abort()` runs the request-error steps, which set the
   * state to DONE and fire both events, and only afterwards is the state reset to UNSENT.
   * This stub said 0, i.e. two stubs of the same browser event disagreed about it, and one
   * of them had to be wrong.
   *
   * ⚠ THE SCOPE OF THAT FIX, MEASURED RATHER THAN ASSUMED. A round-2 audit predicted the
   * old `0` made the cancel case pass for the wrong reason — `success` computing false via
   * the `readyState === 4` clause instead of via `status === 0`. That prediction does not
   * hold here: deleting the `aborted` guard from `attachUploadSettlement` turns this case
   * red under BOTH values, identically (`expected [ 'error' ] to deeply equal [ 'aborted' ]`,
   * 1 failed | 8 passed), because with the guard gone `success` is false either way and
   * `onError` overwrites the cancel regardless of which clause produced the false. So this
   * is a FIDELITY fix — the stub now models the browser and agrees with its sibling — and
   * not a discrimination fix. The case was already discriminating.
   */
  cancel() {
    this.readyState = 4;
    this.status = 0;
    this.fire('abort');
    this.fire('loadend');
  }
}

type Harness = {
  upload: (file: File) => Promise<unknown>;
  statuses: () => string[];
  unmount: () => void;
};

async function mountHook(): Promise<Harness> {
  let api: ReturnType<typeof useCFImageUpload> | undefined;
  function Probe() {
    api = useCFImageUpload();
    return null;
  }
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(Probe));
  });
  return {
    upload: (file) => api!.uploadToCF(file),
    statuses: () => api!.files.map((f) => f.status),
    unmount: () => act(() => root.unmount()),
  };
}

/** Start an upload, let it reach the point where the XHR has been sent, and hand back both. */
async function startUpload(h: Harness) {
  const settled: { value?: unknown; error?: unknown } = {};
  let promise!: Promise<unknown>;
  await act(async () => {
    promise = h.upload(new File(['x'], 'a.png', { type: 'image/png' }));
    promise.then(
      (value) => (settled.value = value),
      (error) => (settled.error = error)
    );
    // Let the sign fetch + preprocess microtasks drain so the XHR exists.
    await new Promise((r) => setTimeout(r, 0));
  });
  return { promise, settled, xhr: FakeXHR.last };
}

describe('useCFImageUpload — the tracked file must not lie about a refused PUT', () => {
  beforeEach(() => {
    vi.stubGlobal('XMLHttpRequest', FakeXHR);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ json: async () => ({ id: UPLOAD_ID, uploadURL: 'https://store/put' }) }))
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('marks the file successful on a 200', async () => {
    const h = await mountHook();
    const { settled, xhr } = await startUpload(h);

    await act(async () => {
      xhr.completeWith(200);
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(h.statuses()).toEqual(['success']);
    expect(settled.value).toEqual({
      url: 'https://store/put',
      id: UPLOAD_ID,
      objectUrl: 'blob:fake-object-url',
      type: 'image',
    });
    h.unmount();
  });

  it.each([201, 204])('marks the file successful on a %i', async (status) => {
    // 🔴 A 2xx is a successful PUT by any reading. Reporting one as an error would put a
    // failure badge on an upload that worked.
    const h = await mountHook();
    const { xhr } = await startUpload(h);

    await act(async () => {
      xhr.completeWith(status);
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(h.statuses()).toEqual(['success']);
    h.unmount();
  });

  it.each([400, 403, 500, 503])('marks the file errored on a refused %i', async (status) => {
    // 🔴 THE DEFECT THIS FIXES. A refused PUT never fires `error` — it completes and lands
    // on `loadend`. Before this change the branch updated nothing, so the tracked file
    // asserted `uploading` forever: `ImageUpload` never showed its error badge and
    // `ChallengeSubmitModal`'s submit gate (`some(f => f.status === 'uploading')`) could
    // never clear.
    const h = await mountHook();
    const { settled, xhr } = await startUpload(h);

    await act(async () => {
      xhr.completeWith(status);
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(h.statuses()).toEqual(['error']);
    /**
     * 🔴 THE REMAINING HALF OF THE DEFECT, PINNED RATHER THAN FIXED. `uploadToCF` still
     * RESOLVES on a refused PUT, handing the caller a media key with nothing behind it —
     * which is how an `Image` row gets written for media that never landed. Making it
     * reject is the follow-up, and it is not a one-line change: most direct call sites do
     * not catch, and `ImageUpload`'s uncaught `Promise.all` would propagate local `blob:`
     * URLs into `onChange` as image values.
     *
     * ⚠ There was a precise count here ("14 of the 32 direct call sites"). It is gone
     * deliberately, and NOT because the qualitative claim weakened — the `Promise.all`
     * consequence above is verified at `src/components/ImageUpload/ImageUpload.tsx`. The
     * count is gone because it was derived four times and moved every time (24 → ~38 → 42
     * → 32/14), a round-2 audit independently got a different numerator, and nothing in
     * this repo asserts on any of those numbers, so the figure could only ever rot. Do not
     * reinstate one without a test that fails when it drifts.
     *
     * Asserting the current behaviour makes
     * that follow-up a deliberate edit to this expectation instead of a silent drift, and
     * the observe-only probe in `createImage` covers the `createImage` funnel server-side
     * meanwhile — not every `Image` row; see that call site for the paths it misses.
     */
    expect(settled.error).toBeUndefined();
    expect(settled.value).toEqual({
      url: 'https://store/put',
      id: UPLOAD_ID,
      objectUrl: 'blob:fake-object-url',
      type: 'image',
    });
    h.unmount();
  });

  it('marks the file errored and rejects on a network failure', async () => {
    const h = await mountHook();
    const { settled, xhr } = await startUpload(h);

    await act(async () => {
      xhr.networkError();
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(h.statuses()).toEqual(['error']);
    expect((settled.error as Error).message).toBe('Upload failed (status 0)');
    h.unmount();
  });

  it('keeps a canceled upload reported as aborted, not errored', async () => {
    // 🔴 `abort` is FOLLOWED by `loadend`. Without the terminal guard the `loadend` handler
    // re-decides the status and overwrites the user's cancel with a failure — this test
    // fails without it.
    const h = await mountHook();
    const { settled, xhr } = await startUpload(h);

    await act(async () => {
      xhr.cancel();
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(h.statuses()).toEqual(['aborted']);
    expect((settled.error as Error).message).toBe('Upload canceled');
    h.unmount();
  });
});
