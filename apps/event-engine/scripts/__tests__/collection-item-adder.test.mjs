import { describe, expect, it } from 'vitest';
import {
  buildEvents,
  landedState,
  nextStampMs,
  readLedger,
} from '../lib/collection-item-adder.mjs';

const T = 1_761_000_000;

describe('buildEvents', () => {
  it('emits what the CDC handler would, one event per key valued at its row count', () => {
    // One owner holding model 7 in two collections: two +1 rows with the same raw-table key would
    // collapse to one under ReplacingMergeTree, so they must arrive as a single +2.
    const events = buildEvents(
      [
        { id: 1, collectionId: 10, modelId: 7, addedById: 5 },
        { id: 2, collectionId: 11, modelId: 7, addedById: 5 },
        { id: 3, collectionId: 12, articleId: 3, addedById: 6 },
        { id: 4, collectionId: 12, postId: 9, addedById: 6 },
      ],
      T
    );

    const by = (entityType, entityId) =>
      events.filter((e) => e.entityType === entityType && e.entityId === entityId);
    expect(by('Model', 7)).toEqual([
      {
        entityType: 'Model',
        entityId: 7,
        metricType: 'collectedCount',
        userId: 5,
        metricValue: 2,
        createdAt: T,
      },
    ]);
    expect(by('Article', 3)).toMatchObject([
      { metricType: 'collectedCount', userId: 6, metricValue: 1 },
    ]);
    expect(by('Post', 9)).toMatchObject([
      { metricType: 'collectedCount', userId: 6, metricValue: 1 },
    ]);
    expect(by('Collection', 12)).toMatchObject([
      { metricType: 'itemCount', userId: 6, metricValue: 2 },
    ]);
    expect(events).toHaveLength(6);
  });
});

describe('nextStampMs', () => {
  it('gives each batch its own second even when batches finish within one', () => {
    const first = nextStampMs(null, T * 1000 + 400);
    const second = nextStampMs(first, T * 1000 + 900);
    expect(first).toBe(T * 1000);
    expect(second).toBe(T * 1000 + 1000);
  });
});

describe('readLedger', () => {
  const line = (o) => JSON.stringify(o);

  const pending = (lo, hi, stampMs) =>
    line({ lo, hi, phase: 'pending', xid: String(lo), stampMs, events: [] });

  it('returns the one unfinished batch and where finished work ends', () => {
    const state = readLedger([
      pending(0, 100, 1000),
      line({ lo: 0, phase: 'committed' }),
      line({ lo: 0, phase: 'inserted' }),
      pending(100, 200, 2000),
      line({ lo: 100, phase: 'committed' }),
      '',
    ]);
    expect(state.open).toMatchObject({ lo: 100, hi: 200, phase: 'committed', xid: '100' });
    expect(state.resumeFrom).toBe(100);
    expect(state.lastStampMs).toBe(2000);
  });

  it('does not count an abandoned batch as done, so its range is redone', () => {
    const state = readLedger([
      pending(0, 100, 1000),
      line({ lo: 0, phase: 'inserted' }),
      pending(100, 200, 2000),
      line({ lo: 100, phase: 'abandoned' }),
    ]);
    expect(state.open).toBeNull();
    expect(state.resumeFrom).toBe(100);
  });

  it('resumes a restamped batch with its new stamp and events', () => {
    const events = [{ entityType: 'Model', entityId: 1, createdAt: 9 }];
    const state = readLedger([
      pending(0, 100, 1000),
      line({ lo: 0, phase: 'committed' }),
      line({ lo: 0, phase: 'restamped', stampMs: 9000, events }),
    ]);
    expect(state.open).toMatchObject({ phase: 'restamped', stampMs: 9000, events });
    expect(state.lastStampMs).toBe(9000);
  });

  it('drops a torn final line but not a torn line in the middle', () => {
    expect(readLedger([pending(0, 100, 1000), '{"lo":0,"pha']).open).toMatchObject({
      phase: 'pending',
    });
    expect(() => readLedger(['{"lo":0,"pha', pending(0, 100, 1000)])).toThrow();
  });

  it('refuses a ledger with two unfinished batches', () => {
    expect(() => readLedger([pending(0, 100, 1000), pending(100, 200, 2000)])).toThrow(
      /2 unfinished batches/
    );
  });
});

describe('landedState', () => {
  const ev = (entityId, metricValue) => ({
    entityType: 'Model',
    entityId,
    metricType: 'collectedCount',
    userId: 5,
    metricValue,
  });

  it('reads all, none and partial', () => {
    expect(landedState([ev(1, 2), ev(2, 1)], [ev(1, 2), ev(2, 1)])).toBe('all');
    expect(landedState([ev(1, 2), ev(2, 1)], [])).toBe('none');
    expect(landedState([ev(1, 2), ev(2, 1)], [ev(1, 2)])).toBe('partial');
  });

  it('does not take a live event with the same key but another value as ours', () => {
    expect(landedState([ev(1, 2)], [ev(1, 1)])).toBe('none');
  });
});
