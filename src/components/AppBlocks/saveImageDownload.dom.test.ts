// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadUrlAsBlob, SAVE_IMAGE_MAX_BYTES } from './saveImageDownload';

/**
 * F4 — executed coverage for `downloadUrlAsBlob` (the browser-side XHR→blob→
 * `<a download>` core the SAVE_IMAGE host bridge calls). The pure allowlist /
 * filename / parse helpers are covered in saveImageDownload.test.ts; the browser
 * `.browser.test.tsx` suite MOCKS this function, so this path had ZERO executed
 * coverage. Here we drive a FAKE XMLHttpRequest under happy-dom to exercise the
 * real function: the size cap actually aborts an over-size transfer, a normal
 * transfer resolves + triggers the `<a download>` DOM path (with the F2 safe
 * extension applied), and the abort/error/non-200 paths reject cleanly.
 */

// A controllable XMLHttpRequest double: the test constructs the download, grabs
// the instance, and drives its events. `abort()` mimics the browser (the 'abort'
// event is dispatched as a queued task, AFTER the caller's synchronous reject).
class FakeXHR {
  static instances: FakeXHR[] = [];
  static last(): FakeXHR {
    const x = FakeXHR.instances[FakeXHR.instances.length - 1];
    if (!x) throw new Error('no FakeXHR constructed');
    return x;
  }

  responseType = '';
  response: unknown = null;
  readyState = 0;
  status = 0;
  aborted = false;
  opened: { method: string; url: string } | null = null;
  sent = false;
  private listeners: Record<string, Array<(ev?: unknown) => void>> = {};

  constructor() {
    FakeXHR.instances.push(this);
  }
  addEventListener(type: string, cb: (ev?: unknown) => void) {
    (this.listeners[type] ||= []).push(cb);
  }
  emit(type: string, ev?: unknown) {
    (this.listeners[type] || []).forEach((cb) => cb(ev));
  }
  open(method: string, url: string) {
    this.opened = { method, url };
  }
  send() {
    this.sent = true;
  }
  abort() {
    this.aborted = true;
    // Real XHR.abort() queues the 'abort' dispatch — it must NOT pre-empt the
    // synchronous reject that runs on the next line of the progress handler.
    Promise.resolve().then(() => this.emit('abort'));
  }
}

const realXHR = globalThis.XMLHttpRequest;
let createObjectURL: ReturnType<typeof vi.fn>;
let revokeObjectURL: ReturnType<typeof vi.fn>;
let clickSpy: ReturnType<typeof vi.spyOn>;
let clickedAnchor: HTMLAnchorElement | null;

beforeEach(() => {
  FakeXHR.instances = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).XMLHttpRequest = FakeXHR;
  createObjectURL = vi.fn(() => 'blob:mock-url');
  revokeObjectURL = vi.fn();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (URL as any).createObjectURL = createObjectURL;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (URL as any).revokeObjectURL = revokeObjectURL;
  clickedAnchor = null;
  clickSpy = vi
    .spyOn(HTMLAnchorElement.prototype, 'click')
    .mockImplementation(function (this: HTMLAnchorElement) {
      // Capturing the spy's RECEIVER is the whole point here — we assert which
      // <a download> element the bridge actually clicked. `this` is the anchor,
      // so the alias is intentional, not the accidental closure-capture the rule
      // guards against.
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      clickedAnchor = this;
    });
});

afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).XMLHttpRequest = realXHR;
  clickSpy.mockRestore();
  vi.clearAllMocks();
});

describe('downloadUrlAsBlob (F4 executed coverage)', () => {
  it('a normal transfer resolves and triggers the <a download> DOM path', async () => {
    const p = downloadUrlAsBlob('https://image.civitai.com/x/original', 'evil.html');
    const xhr = FakeXHR.last();
    // it opened a GET and set responseType=blob (the real transfer setup)
    expect(xhr.opened).toEqual({ method: 'GET', url: 'https://image.civitai.com/x/original' });
    expect(xhr.responseType).toBe('blob');
    expect(xhr.sent).toBe(true);

    const blob = new Blob(['abc'], { type: 'image/png' });
    xhr.readyState = 4;
    xhr.status = 200;
    xhr.response = blob;
    xhr.emit('loadend');

    await expect(p).resolves.toBeUndefined();
    // object URL created for the blob, anchor clicked, URL revoked (no leak)
    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    // F2: the hostile .html name was coerced to the content type's safe extension
    expect(clickedAnchor).not.toBeNull();
    expect(clickedAnchor?.download).toBe('evil.png');
  });

  it('a benign progress event does NOT abort a normal transfer', async () => {
    const p = downloadUrlAsBlob('https://image.civitai.com/x', 'a.jpg');
    const xhr = FakeXHR.last();
    xhr.emit('progress', { loaded: 10, total: 20 }); // well under the cap
    expect(xhr.aborted).toBe(false);
    xhr.readyState = 4;
    xhr.status = 200;
    xhr.response = new Blob(['x'], { type: 'image/jpeg' });
    xhr.emit('loadend');
    await expect(p).resolves.toBeUndefined();
  });

  it('the size cap ABORTS an over-size transfer via the progress handler → rejects', async () => {
    const p = downloadUrlAsBlob('https://image.civitai.com/big.mp4', 'v.mp4', { maxBytes: 100 });
    const xhr = FakeXHR.last();
    // a declared total over the cap trips the guard: the handler aborts + rejects
    xhr.emit('progress', { loaded: 0, total: 500 });
    await expect(p).rejects.toThrow(/maximum download size/i);
    expect(xhr.aborted).toBe(true);
    // no download was triggered
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it('the cap also trips on streamed bytes exceeding it (no declared total)', async () => {
    const p = downloadUrlAsBlob('https://image.civitai.com/big', 'v.mp4', { maxBytes: 100 });
    const xhr = FakeXHR.last();
    xhr.emit('progress', { loaded: 250, total: 0 });
    await expect(p).rejects.toThrow(/maximum download size/i);
    expect(xhr.aborted).toBe(true);
  });

  it('rejects when the loaded blob exceeds the cap (belt for a missed progress)', async () => {
    const p = downloadUrlAsBlob('https://image.civitai.com/x', 'a.png', { maxBytes: 100 });
    const xhr = FakeXHR.last();
    xhr.readyState = 4;
    xhr.status = 200;
    // a blob bigger than the cap that slipped past progress
    xhr.response = { size: 999, type: 'image/png' } as Blob;
    xhr.emit('loadend');
    await expect(p).rejects.toThrow(/maximum download size/i);
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it('rejects cleanly on a non-200 response', async () => {
    const p = downloadUrlAsBlob('https://image.civitai.com/gone', 'a.png');
    const xhr = FakeXHR.last();
    xhr.readyState = 4;
    xhr.status = 404;
    xhr.emit('loadend');
    await expect(p).rejects.toThrow(/download failed \(404\)/i);
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it('rejects cleanly on a network error', async () => {
    const p = downloadUrlAsBlob('https://image.civitai.com/x', 'a.png');
    const xhr = FakeXHR.last();
    xhr.emit('error');
    await expect(p).rejects.toThrow(/download failed/i);
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it('rejects cleanly on an abort event', async () => {
    const p = downloadUrlAsBlob('https://image.civitai.com/x', 'a.png');
    const xhr = FakeXHR.last();
    xhr.emit('abort');
    await expect(p).rejects.toThrow(/download aborted/i);
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it('defaults the cap to SAVE_IMAGE_MAX_BYTES (200 MB) when unspecified', async () => {
    expect(SAVE_IMAGE_MAX_BYTES).toBe(200 * 1024 * 1024);
    const p = downloadUrlAsBlob('https://image.civitai.com/x', 'a.png');
    const xhr = FakeXHR.last();
    // just under the default cap streams fine
    xhr.emit('progress', { loaded: 199 * 1024 * 1024, total: 199 * 1024 * 1024 });
    expect(xhr.aborted).toBe(false);
    xhr.readyState = 4;
    xhr.status = 200;
    xhr.response = new Blob(['x'], { type: 'image/png' });
    xhr.emit('loadend');
    await expect(p).resolves.toBeUndefined();
  });
});
