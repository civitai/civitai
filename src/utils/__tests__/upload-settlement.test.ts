import { describe, it, expect, vi, beforeEach } from 'vitest';
import { attachUploadSettlement } from '~/utils/upload-settlement';
import type { SettlementXhr } from '~/utils/upload-settlement';

// AUDIT-F1 regression guard — the defect the first draft of the upload relay shipped,
// and the one nothing in the tree could see.
//
// Per the XHR spec, an `error` at the XHR object is followed by `loadend` at the XHR
// object IN THE SAME DISPATCH. The first draft moved the `error` handler's
// synchronous `reject(...)` into a promise chain but left `loadend` settling
// unconditionally, so `loadend` won the race, computed `success = false`, and
// resolved BEFORE the relay's fetch could finish. Two consequences, the second worse
// than the bug the relay exists to fix:
//
//   1. the caller received the PRESIGN id — a key holding no bytes, because the PUT
//      that would have written them is the thing that just failed;
//   2. the pre-existing throw on a failed upload disappeared, turning a visible
//      upload failure into a silent success carrying a bad id.
//
// These drive the REAL exported function that `useCFImageUpload` calls — not a model
// of it. An earlier draft of this test re-implemented the rule inline, which would
// have stayed green against a broken hook; the logic was extracted into
// `attachUploadSettlement` specifically so the guard could bind to production code.
//
// Red against the pre-fix rule: delete the `if (relayPending) return;` line in
// `attachUploadSettlement` and the first two cases fail.

/** Minimal XHR stub that dispatches terminal events in the spec's order. */
class StubXhr implements SettlementXhr {
  readyState = 0;
  status = 0;
  private handlers: Record<string, Array<() => void>> = {};

  addEventListener(type: string, fn: EventListenerOrEventListenerObject) {
    (this.handlers[type] ??= []).push(fn as () => void);
  }

  private fire(type: string) {
    for (const fn of this.handlers[type] ?? []) fn();
  }

  /** A network-layer failure: `error` then `loadend`, same dispatch. */
  networkFailure() {
    this.readyState = 4;
    this.status = 0;
    this.fire('error');
    this.fire('loadend');
  }

  /** A response that reached the backend and was rejected by it. */
  finishedWithStatus(status: number) {
    this.readyState = 4;
    this.status = status;
    this.fire('loadend');
  }

  userAbort() {
    this.fire('abort');
  }
}

function callbacks() {
  return {
    onRelayed: vi.fn(),
    onSuccess: vi.fn(),
    onError: vi.fn(),
    onAborted: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('attachUploadSettlement', () => {
  it('resolves with the RELAYED id, not the presign id, when the direct PUT fails', async () => {
    const xhr = new StubXhr();
    const cb = callbacks();
    // A relay is a network call: it can never complete inside the dispatch that
    // `loadend` runs in, which is exactly what made the original bug reachable.
    const relay = vi.fn(() => new Promise<string>((r) => setTimeout(() => r('RELAYED-ID'), 5)));

    const settled = attachUploadSettlement(xhr, relay, cb);
    xhr.networkFailure();

    await expect(settled).resolves.toEqual({ kind: 'relayed', id: 'RELAYED-ID' });
    expect(cb.onRelayed).toHaveBeenCalledWith('RELAYED-ID');
    expect(cb.onSuccess).toHaveBeenCalledTimes(1);
    expect(cb.onError).not.toHaveBeenCalled();
  });

  it('does not settle from loadend while a relay is in flight', async () => {
    const xhr = new StubXhr();
    const cb = callbacks();
    let release: (id: string) => void = () => undefined;
    const relay = vi.fn(() => new Promise<string>((r) => (release = r)));

    const settled = attachUploadSettlement(xhr, relay, cb);
    xhr.networkFailure();

    // Both terminal events have fired. Nothing may have settled yet.
    const raced = await Promise.race([
      settled.then(() => 'settled' as const),
      new Promise<'pending'>((r) => setTimeout(() => r('pending'), 20)),
    ]);
    expect(raced).toBe('pending');

    release('RELAYED-ID');
    await expect(settled).resolves.toEqual({ kind: 'relayed', id: 'RELAYED-ID' });
  });

  it('reports the ORIGINAL failure — not the relay error — when the relay also fails', async () => {
    const xhr = new StubXhr();
    const cb = callbacks();
    const relay = vi.fn().mockRejectedValue(new Error('Upload fallback failed (status 500)'));

    const settled = attachUploadSettlement(xhr, relay, cb);
    xhr.networkFailure();

    // The failure signal the pre-fix draft silently deleted.
    await expect(settled).rejects.toThrow('Upload failed (status 0)');
    expect(cb.onError).toHaveBeenCalledTimes(1);
    expect(cb.onSuccess).not.toHaveBeenCalled();
  });

  it('treats a cancel DURING the relay as a cancel, not an upload failure', async () => {
    const xhr = new StubXhr();
    const cb = callbacks();
    const relay = vi
      .fn()
      .mockRejectedValue(new DOMException('The operation was aborted.', 'AbortError'));

    const settled = attachUploadSettlement(xhr, relay, cb);
    xhr.networkFailure();

    await expect(settled).rejects.toThrow('Upload canceled');
    expect(cb.onAborted).toHaveBeenCalledTimes(1);
    expect(cb.onError).not.toHaveBeenCalled();
  });

  it('does NOT relay a non-2xx response — that means the backend rejected us', async () => {
    const xhr = new StubXhr();
    const cb = callbacks();
    const relay = vi.fn();

    const settled = attachUploadSettlement(xhr, relay, cb);
    xhr.finishedWithStatus(403);

    await expect(settled).resolves.toEqual({ kind: 'direct', success: false });
    expect(relay).not.toHaveBeenCalled();
  });

  it('settles the ordinary success path unchanged', async () => {
    const xhr = new StubXhr();
    const cb = callbacks();
    const relay = vi.fn();

    const settled = attachUploadSettlement(xhr, relay, cb);
    xhr.finishedWithStatus(200);

    await expect(settled).resolves.toEqual({ kind: 'direct', success: true });
    expect(cb.onSuccess).toHaveBeenCalledTimes(1);
    expect(relay).not.toHaveBeenCalled();
  });

  // Renamed after a round-2 audit: this used to be called "settles exactly once" and
  // was attributed to a `settled` latch, which was measured INERT and has been
  // removed. What actually protects this is `relayPending` — a later `loadend` yields
  // to the relay that already settled. Naming the real mechanism so the next reader
  // does not go looking for a latch that is not there.
  it('ignores a later loadend once a relay has already settled', async () => {
    const xhr = new StubXhr();
    const cb = callbacks();
    const relay = vi.fn(() => Promise.resolve('RELAYED-ID'));

    const settled = attachUploadSettlement(xhr, relay, cb);
    xhr.networkFailure();
    await settled;
    // A second dispatch must not re-settle or re-report.
    xhr.finishedWithStatus(200);

    await expect(settled).resolves.toEqual({ kind: 'relayed', id: 'RELAYED-ID' });
    expect(cb.onSuccess).toHaveBeenCalledTimes(1);
  });

  it('rejects on a user abort of the direct upload', async () => {
    const xhr = new StubXhr();
    const cb = callbacks();
    const relay = vi.fn();

    const settled = attachUploadSettlement(xhr, relay, cb);
    xhr.userAbort();

    await expect(settled).rejects.toThrow('Upload canceled');
    expect(cb.onAborted).toHaveBeenCalledTimes(1);
    expect(relay).not.toHaveBeenCalled();
  });
});
