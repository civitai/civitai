import { describe, expect, test, vi } from 'vitest';
import { startRefreshers } from '@/vector-sync/domain/refresh';
import type { Domain } from '@/vector-sync/domain/sync';

const domain = (name: string, refresh?: Domain<any>['refresh']) =>
  ({ name, table: name, refresh } as Domain<any>);

describe('refresh walk timers', () => {
  test('each tick hands the next batch to the domain lane, wrapping at the end', async () => {
    vi.useFakeTimers();
    try {
      const added: number[] = [];
      const ids = [1, 2, 3];
      const pg = {
        query: async (_sql: string, [cursor, batch]: [number, number]) => ({
          rows: ids
            .filter((id) => id > cursor)
            .slice(0, batch)
            .map((id) => ({ id })),
        }),
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
      await vi.advanceTimersByTimeAsync(3001);
      expect(added).toEqual([1, 2, 3, 1, 2, 3]);
      for (const t of timers) clearInterval(t);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a full queue skips the tick', async () => {
    vi.useFakeTimers();
    try {
      const added: number[] = [];
      const queue = {
        lanes: new Map([['storyline', { add: (r: { id: number }) => void added.push(r.id) }]]),
        isFull: true,
      };
      const timers = startRefreshers(
        [domain('storyline', { everyMs: 1000, batch: 2 })],
        queue as never,
        { query: async () => ({ rows: [{ id: 1 }] }) } as never
      );
      await vi.advanceTimersByTimeAsync(3000);
      expect(added).toEqual([]);
      for (const t of timers) clearInterval(t);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a failed read keeps the cursor, and a read still running holds the next tick', async () => {
    vi.useFakeTimers();
    try {
      const added: number[] = [];
      const cursors: number[] = [];
      let calls = 0;
      let release: () => void = () => {};
      const pg = {
        query: async (_sql: string, [cursor]: [number, number]) => {
          cursors.push(cursor);
          calls++;
          if (calls === 1) throw new Error('replica blip');
          if (calls === 2) await new Promise<void>((r) => (release = r));
          return { rows: [{ id: cursor + 1 }, { id: cursor + 2 }] };
        },
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
      await vi.advanceTimersByTimeAsync(1000);
      expect(added).toEqual([1, 2, 3, 4]);
      expect(cursors).toEqual([0, 0, 2]);
      for (const t of timers) clearInterval(t);
    } finally {
      vi.useRealTimers();
    }
  });
});
