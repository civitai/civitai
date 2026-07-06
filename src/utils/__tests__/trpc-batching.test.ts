import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __getTrpcBatchingEnabled,
  setTrpcBatchingEnabled,
  shouldBatch,
} from '~/utils/trpc';

/**
 * Unit coverage for the tRPC batching split decision (`shouldBatch`) that the
 * `splitLink` terminating link uses to route a query to `httpBatchStreamLink`
 * (batch) vs the unbatched large-query-aware link. The link objects themselves
 * are tRPC internals; the branch SELECTION is the behaviour we own, so we test
 * the predicate directly.
 */

// tRPC operations only need these fields for `shouldBatch`.
type Op = { type: string; input: unknown; context: Record<string, unknown> };
const op = (over: Partial<Op> = {}): Op => ({
  type: 'query',
  input: { limit: 5 },
  context: {},
  ...over,
});

const setWindowAuthed = (isAuthed: boolean | undefined) => {
  (globalThis as any).window = isAuthed === undefined ? {} : { isAuthed };
};
const clearWindow = () => {
  delete (globalThis as any).window;
};

beforeEach(() => {
  setTrpcBatchingEnabled(false);
  clearWindow();
});
afterEach(() => {
  setTrpcBatchingEnabled(false);
  clearWindow();
});

describe('setTrpcBatchingEnabled', () => {
  it('defaults OFF and toggles the module flag', () => {
    expect(__getTrpcBatchingEnabled()).toBe(false); // dark by default
    setTrpcBatchingEnabled(true);
    expect(__getTrpcBatchingEnabled()).toBe(true);
    setTrpcBatchingEnabled(false);
    expect(__getTrpcBatchingEnabled()).toBe(false);
  });
});

describe('shouldBatch', () => {
  it('batches an authed-browser small query when the flag is on', () => {
    setTrpcBatchingEnabled(true);
    setWindowAuthed(true);
    expect(shouldBatch(op())).toBe(true);
  });

  it('does NOT batch when the flag is off (dark default), even if authed', () => {
    setTrpcBatchingEnabled(false);
    setWindowAuthed(true);
    expect(shouldBatch(op())).toBe(false);
  });

  it('does NOT batch anonymous traffic (preserves CF edge-cache for anon GETs)', () => {
    setTrpcBatchingEnabled(true);
    setWindowAuthed(false);
    expect(shouldBatch(op())).toBe(false);
  });

  it('does NOT batch when window.isAuthed is unknown/undefined (early hydration is safe)', () => {
    setTrpcBatchingEnabled(true);
    setWindowAuthed(undefined); // window exists but isAuthed not yet set
    expect(shouldBatch(op())).toBe(false);
  });

  it('does NOT batch on the server (no window)', () => {
    setTrpcBatchingEnabled(true);
    clearWindow();
    expect(shouldBatch(op())).toBe(false);
  });

  it('honors the skipBatch context escape hatch', () => {
    setTrpcBatchingEnabled(true);
    setWindowAuthed(true);
    expect(shouldBatch(op({ context: { skipBatch: true } }))).toBe(false);
  });

  it('does NOT batch mutations (they stay standalone / keep the POST path)', () => {
    setTrpcBatchingEnabled(true);
    setWindowAuthed(true);
    expect(shouldBatch(op({ type: 'mutation' }))).toBe(false);
  });

  it('does NOT batch large queries (they go out as POST methodOverride, body-carried)', () => {
    setTrpcBatchingEnabled(true);
    setWindowAuthed(true);
    // input serializes to > MAX_QUERY_INPUT_LENGTH (2500 chars) => large => unbatched
    expect(shouldBatch(op({ input: { q: 'x'.repeat(3000) } }))).toBe(false);
  });

  it('still batches a query whose input is just under the large-query threshold', () => {
    setTrpcBatchingEnabled(true);
    setWindowAuthed(true);
    expect(shouldBatch(op({ input: { q: 'x'.repeat(100) } }))).toBe(true);
  });
});
