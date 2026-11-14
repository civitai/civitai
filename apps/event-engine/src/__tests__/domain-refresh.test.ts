import { describe, expect, test, vi } from 'vitest';
import { startRefreshers } from '@/vector-sync/domain/refresh';
import type { Domain } from '@/vector-sync/domain/sync';

const domain = (name: string, refresh?: Domain<any>['refresh']) =>
  ({ name, table: name, refresh } as Domain<any>);

/** Throws past `max` reads, so a walk whose cursor never wraps fails instead of spinning forever. */
const bounded =
  <A extends unknown[], R>(read: (...args: A) => Promise<R>, max = 20) =>
  (...args: A) => {
    if (--max < 0) throw new Error('refresh walk never wrapped');
    return read(...args);
  };

describe('refresh walk timers', () => {
  test('each tick walks the whole table, a batch per read, into the domain lane', async () => {
    vi.useFakeTimers();
    try {
      const added: number[] = [];
      const ids = [1, 2, 3];
      const pg = {
        query: bounded(async (_sql: string, [cursor, batch]: [number, number]) => ({
          rows: ids
            .filter((id) => id > cursor)
            .slice(0, batch)
            .map((id) => ({ id })),
        })),
      };
      const queue = {
        lanes: new Map([['storyline', { add: (r: { id: number }) => void added.push(r.id) }]]),
        isFull: false,
      };
      const timers = startRefreshers(
        [domain('storyline', { everyMs: 1000, batch: 2 }), domain('article')],
        queue as never,
        pg as never
      );
      expect(timers).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(999);
      expect(added).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(added).toEqual([1, 2, 3]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(added).toEqual([1, 2, 3, 1, 2, 3]);
      for (const t of timers) clearInterval(t);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a failed read keeps the cursor, and a pass still running holds the next tick', async () => {
    vi.useFakeTimers();
    try {
      const added: number[] = [];
      const cursors: number[] = [];
      let calls = 0;
      let release: () => void = () => {};
      const pg = {
        query: bounded(async (_sql: string, [cursor]: [number, number]) => {
          cursors.push(cursor);
          calls++;
          if (calls === 1) throw new Error('replica blip');
          if (calls === 2) await new Promise<void>((r) => (release = r));
          return { rows: [cursor + 1, cursor + 2].filter((id) => id <= 4).map((id) => ({ id })) };
        }),
      };
      const queue = {
        lanes: new Map([['storyline', { add: (r: { id: number }) => void added.push(r.id) }]]),
        isFull: false,
      };
      const timers = startRefreshers(
        [domain('storyline', { everyMs: 1000, batch: 2 })],
        queue as never,
        pg as never
      );
      await vi.advanceTimersByTimeAsync(1000); // fails
      await vi.advanceTimersByTimeAsync(1000); // starts, and hangs
      await vi.advanceTimersByTimeAsync(3000); // three ticks while it runs: skipped
      expect(cursors).toEqual([0, 0]);
      release();
      await vi.advanceTimersByTimeAsync(0);
      // The second read finishes the pass the hung one began.
      expect(added).toEqual([1, 2, 3, 4]);
      expect(cursors).toEqual([0, 0, 2, 4]);
      for (const t of timers) clearInterval(t);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a queue that fills is flushed and the pass finishes within the tick', async () => {
    vi.useFakeTimers();
    try {
      const added: number[] = [];
      const pending = new Set<number>();
      const ids = [1, 2, 3, 4, 5];
      let flushes = 0;
      const queue = {
        lanes: new Map([
          ['storyline', { add: (r: { id: number }) => void (added.push(r.id), pending.add(r.id)) }],
        ]),
        get isFull() {
          return pending.size >= 2;
        },
        flush: async () => {
          flushes++;
          pending.clear();
        },
      };
      const pg = {
        query: bounded(async (_sql: string, [cursor, batch]: [number, number]) => ({
          rows: ids
            .filter((id) => id > cursor)
            .slice(0, batch)
            .map((id) => ({ id })),
        })),
      };
      const timers = startRefreshers(
        [domain('storyline', { everyMs: 1000, batch: 2 })],
        queue as never,
        pg as never
      );
      await vi.advanceTimersByTimeAsync(1000);
      expect(added).toEqual([1, 2, 3, 4, 5]);
      expect(flushes).toBe(2);
      for (const t of timers) clearInterval(t);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a failed flush stops the pass, and the next tick resumes from the same cursor', async () => {
    vi.useFakeTimers();
    try {
      const added: number[] = [];
      const cursors: number[] = [];
      const ids = [1, 2, 3, 4, 5];
      let full = false;
      let flushFails = true;
      const queue = {
        lanes: new Map([['storyline', { add: (r: { id: number }) => void added.push(r.id) }]]),
        get isFull() {
          return full;
        },
        flush: async () => {
          if (flushFails) throw new Error('qdrant down');
          full = false;
        },
      };
      const pg = {
        query: bounded(async (_sql: string, [cursor, batch]: [number, number]) => {
          cursors.push(cursor);
          if (cursor === 0) full = true;
          return {
            rows: ids
              .filter((id) => id > cursor)
              .slice(0, batch)
              .map((id) => ({ id })),
          };
        }),
      };
      const timers = startRefreshers(
        [domain('storyline', { everyMs: 1000, batch: 2 })],
        queue as never,
        pg as never
      );
      await vi.advanceTimersByTimeAsync(1000);
      expect(added).toEqual([1, 2]);
      flushFails = false;
      await vi.advanceTimersByTimeAsync(1000);
      expect(added).toEqual([1, 2, 3, 4, 5]);
      expect(cursors).toEqual([0, 2, 4]);
      for (const t of timers) clearInterval(t);
    } finally {
      vi.useRealTimers();
    }
  });
});
