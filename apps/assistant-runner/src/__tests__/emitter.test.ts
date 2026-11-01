import type { TurnPart } from '@civitai/components-chat/core';
import { applyRunEvent, type RunEvent } from '@civitai/components-chat/runner-protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RunEmitter } from '../core/emitter';

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function setup(shown: TurnPart[] = []) {
  const written: RunEvent[] = [];
  let parts: TurnPart[] | undefined = shown.map((part) => ({ ...part }));
  const emitter = new RunEmitter({
    write: async (event) => {
      written.push(structuredClone(event));
    },
    parts: () => parts,
    shown,
    log,
    flushMs: 100,
  });
  return { emitter, written, set: (next: TurnPart[] | undefined) => (parts = next) };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('RunEmitter', () => {
  it('sends a growing text as one delta per flush window, never the whole part again', async () => {
    const { emitter, written, set } = setup();
    let text = '';
    for (let i = 0; i < 1000; i++) {
      text += 'abcde';
      set([{ kind: 'text', text }]);
      emitter.partsChanged();
      if (i % 20 === 19) await vi.advanceTimersByTimeAsync(25);
    }
    emitter.flushParts();
    await emitter.drain();

    const deltas = written.filter((event) => event.type === 'text-delta');
    expect(deltas.map((event) => event.text).join('')).toBe(text);
    // 50 batches of 25 ms each: about one flush per 100 ms, not one event per change.
    expect(deltas.length).toBeGreaterThanOrEqual(12);
    expect(deltas.length).toBeLessThanOrEqual(14);
    expect(JSON.stringify(written).length).toBeLessThan(text.length * 1.5);
  });

  it('writes events in the order they were emitted, one at a time', async () => {
    let inFlight = 0;
    let most = 0;
    const order: string[] = [];
    const emitter = new RunEmitter({
      write: async (event) => {
        inFlight++;
        most = Math.max(most, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push(event.type);
        inFlight--;
      },
      parts: () => [],
      shown: [],
      log,
    });
    emitter.emit({ type: 'parts-truncate', length: 0 });
    emitter.emit({
      type: 'network-retry',
      attempt: 1,
      trace: { stage: 'stream', step: 1, msIntoStep: 1, message: 'x' },
    });
    emitter.emit({ type: 'run-ended', status: 'done', messages: [], steps: 0 });
    await vi.advanceTimersByTimeAsync(50);
    await emitter.drain();
    expect(order).toEqual(['parts-truncate', 'network-retry', 'run-ended']);
    expect(most).toBe(1);
  });

  it('carries on from parts a journal already shows: only what is new goes out, and a client applying it rebuilds the reply', async () => {
    const shown: TurnPart[] = [
      { kind: 'text', text: 'Step one. ' },
      { kind: 'tool', toolCallId: 'a', toolName: 'slow', input: {}, state: 'calling' },
    ];
    const { emitter, written, set } = setup(shown);
    const now: TurnPart[] = [
      { kind: 'text', text: 'Step one. ' },
      {
        kind: 'tool',
        toolCallId: 'a',
        toolName: 'slow',
        input: {},
        state: 'error',
        error: 'interrupted',
      },
      { kind: 'text', text: 'All done.' },
    ];
    set(now);
    emitter.flushParts();
    await emitter.drain();
    expect(written).toEqual([
      { type: 'tool-error', toolCallId: 'a', error: 'interrupted' },
      { type: 'text-delta', index: 2, text: 'All done.' },
    ]);
    const client = shown.map((part) => ({ ...part }));
    for (const event of written) expect(applyRunEvent(client, event)).toBe(true);
    expect(client).toEqual(now);
  });

  it('stops writing after a refused write, so nothing lands out of order', async () => {
    const written: string[] = [];
    const emitter = new RunEmitter({
      write: async (event) => {
        if (event.type === 'network-retry') throw new Error('not the owner');
        written.push(event.type);
      },
      parts: () => [],
      shown: [],
      log,
    });
    emitter.emit({ type: 'parts-truncate', length: 0 });
    emitter.emit({
      type: 'network-retry',
      attempt: 1,
      trace: { stage: 'stream', step: 1, msIntoStep: 1, message: 'x' },
    });
    emitter.emit({ type: 'run-ended', status: 'done', messages: [], steps: 0 });
    await emitter.drain();
    expect(written).toEqual(['parts-truncate']);
  });
});
