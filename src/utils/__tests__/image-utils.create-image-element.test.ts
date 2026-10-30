import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createImageElement } from '~/utils/image-utils';

type Outcome = 'load' | 'error';

// Outcomes are consumed one per attempt; a shorter script than the attempts made means the
// element never settles, so every test also asserts the attempt count to keep that visible.
let outcomes: Outcome[] = [];
let attempts = 0;

class FakeImage {
  crossOrigin: string | null = null;
  complete = false;
  naturalWidth = 0;
  width = 0;
  height = 0;

  private listeners: Record<string, ((event: unknown) => void)[]> = {};
  private _src = '';

  addEventListener(type: string, listener: (event: unknown) => void) {
    (this.listeners[type] ??= []).push(listener);
  }

  decode() {
    return Promise.resolve();
  }

  set src(value: string) {
    this._src = value;
    const outcome = outcomes[attempts];
    attempts += 1;
    if (!outcome) return;
    queueMicrotask(() => {
      if (outcome === 'load') {
        this.complete = true;
        this.naturalWidth = 512;
        this.width = 512;
        this.height = 512;
        for (const listener of this.listeners.load ?? []) listener(new Event('load'));
      } else {
        for (const listener of this.listeners.error ?? []) listener(new Event('error'));
      }
    });
  }

  get src() {
    return this._src;
  }
}

describe('createImageElement', () => {
  beforeEach(() => {
    outcomes = [];
    attempts = 0;
    vi.stubGlobal('Image', FakeImage);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('rejects with an Error, not the bare error Event', async () => {
    outcomes = ['error'];

    // Rejecting with the DOM Event is what made the caller's diagnostic log read
    // "[object Event]" and name nothing about the failure.
    await expect(createImageElement('blob:test')).rejects.toBeInstanceOf(Error);
    expect(attempts).toBe(1);
  });

  it('makes a single attempt by default', async () => {
    outcomes = ['error', 'load'];

    await expect(createImageElement('blob:test')).rejects.toBeInstanceOf(Error);
    expect(attempts).toBe(1);
  });

  it('retries a failed load and resolves when a later attempt succeeds', async () => {
    outcomes = ['error', 'error', 'load'];

    const img = await createImageElement('blob:test', {
      loadRetries: 2,
      loadRetryDelayMs: 0,
    });

    expect(img.width).toBe(512);
    expect(attempts).toBe(3);
  });

  it('gives up after the configured number of retries', async () => {
    outcomes = ['error', 'error', 'error'];

    await expect(
      createImageElement('blob:test', { loadRetries: 2, loadRetryDelayMs: 0 })
    ).rejects.toBeInstanceOf(Error);
    expect(attempts).toBe(3);
  });
});
