import { describe, expect, test, vi } from 'vitest';
import { startRefreshers } from '@/vector-sync/domain/refresh';
import type { Domain } from '@/vector-sync/domain/sync';

const domain = (name: string, refresh?: Domain<any>['refresh'], points?: number[]) =>
  ({
    name,
    table: name,
    refresh,
    store: points
      ? () => ({
          idsInRange: async (lo: number, hi: number) => points.filter((id) => id >= lo && id < hi),
        })
      : undefined,
  } as unknown as Domain<any>);

/** Throws past `max` reads, so a walk whose cursor never wraps fails instead of spinning forever. */
const bounded =
  <A extends unknown[], R>(read: (...args: A) => Promise<R>, max = 20) =>
  (...args: A) => {
    if (--max < 0) throw new Error('refresh walk never wrapped');
    return read(...args);
  };

describe('refresh walk timers', () => {
  /** A walk that drops rows 2-29 every pass; `lookup` answers the primary-key check. */
  const droppingWalk = async (lookup: (ids: number[]) => Promise<{ rows: { id: number }[] }>) => {
    const added: number[] = [];
    const pg = {
      query: bounded(async (sql: string, args: unknown[]) => {
        if (sql.includes('ANY(')) return lookup(args[0] as number[]);
        return { rows: (args[0] as number) === 0 ? [{ id: 1 }, { id: 30 }] : [] };
      }, 40),
    };
    const queue = {
      lanes: new Map([['storyline', { add: (r: { id: number }) => void added.push(r.id) }]]),
      isFull: false,
    };
    const points = Array.from({ length: 30 }, (_, i) => i + 1);
    const timers = startRefreshers(
      [domain('storyline', { everyMs: 1000, batch: 100 }, points)],
      queue as never,
      pg as never
    );
    await vi.advanceTimersByTimeAsync(3000);
    for (const t of timers) clearInterval(t);
    return added.filter((id) => id !== 1 && id !== 30);
  };

  test('a walk that keeps missing rows the table still has deletes none of them', async () => {
    vi.useFakeTimers();
    try {
      const deleted = await droppingWalk(async (ids) => ({ rows: ids.map((id) => ({ id })) }));
      expect(deleted).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  test('releases only the held orphans the primary-key lookup cannot find', async () => {
    vi.useFakeTimers();
    try {
      const deleted = await droppingWalk(async (ids) => ({
        rows: ids.filter((id) => id % 2 === 0).map((id) => ({ id })),
      }));
      expect(deleted.length).toBeGreaterThan(0);
      expect(deleted.every((id) => id % 2 === 1)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a failed primary-key lookup releases no held orphan', async () => {
    vi.useFakeTimers();
    try {
      const deleted = await droppingWalk(async () => {
        throw new Error('connection reset');
      });
      expect(deleted).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  test('an empty read does not exempt the next pass from the brake', async () => {
    vi.useFakeTimers();
    try {
      const added: number[] = [];
      let rows: number[] = [];
      const pg = {
        query: bounded(async (_sql: string, [cursor, batch]: [number, number]) => ({
          rows: rows
            .filter((id) => id > cursor)
            .slice(0, batch)
            .map((id) => ({ id })),
        })),
      };
      const queue = {
        lanes: new Map([['storyline', { add: (r: { id: number }) => void added.push(r.id) }]]),
        isFull: false,
      };
      const points = Array.from({ length: 50 }, (_, i) => i + 1);
      const timers = startRefreshers(
        [domain('storyline', { everyMs: 1000, batch: 100 }, points)],
        queue as never,
        pg as never
      );
      await vi.advanceTimersByTimeAsync(1000); // empty read
      rows = [1, 2]; // then a lagging read missing most rows
      await vi.advanceTimersByTimeAsync(1000);
      expect(added).toEqual([1, 2]);
      for (const t of timers) clearInterval(t);
    } finally {
      vi.useRealTimers();
    }
  });

  test('held orphans are let through the next pass even when the batch ranges shifted', async () => {
    vi.useFakeTimers();
    try {
      const added: number[] = [];
      let rows = [1, 40];
      const pg = {
        query: bounded(async (_sql: string, [cursor, batch]: [number, number]) => ({
          rows: rows
            .filter((id) => id > cursor)
            .slice(0, batch)
            .map((id) => ({ id })),
        })),
      };
      const queue = {
        lanes: new Map([['storyline', { add: (r: { id: number }) => void added.push(r.id) }]]),
        isFull: false,
      };
      const points = Array.from({ length: 40 }, (_, i) => i + 1);
      const timers = startRefreshers(
        [domain('storyline', { everyMs: 1000, batch: 2 }, points)],
        queue as never,
        pg as never
      );
      await vi.advanceTimersByTimeAsync(1000);
      expect(added.filter((id) => id > 1 && id < 40)).toEqual([]);
      rows = [40]; // row 1 deleted too: the one batch now starts and ends elsewhere
      added.length = 0;
      await vi.advanceTimersByTimeAsync(1000);
      expect([...added].sort((a, b) => a - b)).toEqual(points);
      for (const t of timers) clearInterval(t);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a burst of orphans is held one pass, then deleted when the same orphans are still there', async () => {
    vi.useFakeTimers();
    try {
      const added: number[] = [];
      const pg = {
        query: bounded(async (_sql: string, [cursor]: [number, number]) => ({
          rows: cursor === 0 ? [{ id: 1 }, { id: 30 }] : [],
        })),
      };
      const queue = {
        lanes: new Map([['storyline', { add: (r: { id: number }) => void added.push(r.id) }]]),
        isFull: false,
      };
      // Rows 2-29 deleted together: 28 orphans of 30 points.
      const points = Array.from({ length: 30 }, (_, i) => i + 1);
      const timers = startRefreshers(
        [domain('storyline', { everyMs: 1000, batch: 100 }, points)],
        queue as never,
        pg as never
      );
      await vi.advanceTimersByTimeAsync(1000);
      expect(added).toEqual([1, 30]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(added.slice(2).sort((a, b) => a - b)).toEqual(points);
      for (const t of timers) clearInterval(t);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a failed point read (a missing collection) deletes nothing and leaves other domains walking', async () => {
    vi.useFakeTimers();
    try {
      const added: Record<string, number[]> = { storyline: [], comic: [] };
      const pg = {
        query: bounded(async (_sql: string, [cursor]: [number, number]) => ({
          rows: cursor === 0 ? [{ id: 1 }, { id: 2 }] : [],
        })),
      };
      const lane = (name: string) => ({ add: (r: { id: number }) => void added[name].push(r.id) });
      const queue = {
        lanes: new Map([
          ['storyline', lane('storyline')],
          ['comic', lane('comic')],
        ]),
        isFull: false,
      };
      const missing = {
        ...domain('comic', { everyMs: 1000, batch: 10 }),
        store: () => ({
          idsInRange: async () => {
            throw Object.assign(new Error('Not found: Collection comics does not exist'), {
              status: 404,
            });
          },
        }),
      } as unknown as Domain<any>;
      const timers = startRefreshers(
        [missing, domain('storyline', { everyMs: 1000, batch: 10 }, [1, 2, 7])],
        queue as never,
        pg as never
      );
      await vi.advanceTimersByTimeAsync(1000);
      // Its rows are still walked; no point is queued, so nothing is deleted on its account.
      expect(added.comic).toEqual([1, 2]);
      expect([...added.storyline].sort()).toEqual([1, 2, 7]);
      for (const t of timers) clearInterval(t);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a row read that comes back empty over a populated range deletes nothing', async () => {
    vi.useFakeTimers();
    try {
      const added: number[] = [];
      const pg = { query: bounded(async () => ({ rows: [] })) };
      const queue = {
        lanes: new Map([['storyline', { add: (r: { id: number }) => void added.push(r.id) }]]),
        isFull: false,
      };
      const points = Array.from({ length: 50 }, (_, i) => i + 1);
      const timers = startRefreshers(
        [domain('storyline', { everyMs: 1000, batch: 100 }, points)],
        queue as never,
        pg as never
      );
      await vi.advanceTimersByTimeAsync(3000);
      expect(added).toEqual([]);
      for (const t of timers) clearInterval(t);
    } finally {
      vi.useRealTimers();
    }
  });

  test('an empty row read deletes nothing even when too few points to trip the brake', async () => {
    vi.useFakeTimers();
    try {
      const added: number[] = [];
      const pg = { query: bounded(async () => ({ rows: [] })) };
      const queue = {
        lanes: new Map([['storyline', { add: (r: { id: number }) => void added.push(r.id) }]]),
        isFull: false,
      };
      const timers = startRefreshers(
        [domain('storyline', { everyMs: 1000, batch: 100 }, [1, 2, 3])],
        queue as never,
        pg as never
      );
      await vi.advanceTimersByTimeAsync(3000);
      expect(added).toEqual([]);
      for (const t of timers) clearInterval(t);
    } finally {
      vi.useRealTimers();
    }
  });

  test('also queues points whose row is gone, inside a batch and past the last row', async () => {
    vi.useFakeTimers();
    try {
      const added: number[] = [];
      const ids = [1, 2, 4, 5];
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
      // 3 sits between rows of the second batch's range, 9 after the last row; 1 and 4 have rows.
      const timers = startRefreshers(
        [domain('storyline', { everyMs: 1000, batch: 2 }, [1, 3, 4, 9])],
        queue as never,
        pg as never
      );
      await vi.advanceTimersByTimeAsync(1000);
      expect([...added].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 9]);
      expect(added.filter((id) => id === 1 || id === 4)).toHaveLength(2);
      for (const t of timers) clearInterval(t);
    } finally {
      vi.useRealTimers();
    }
  });

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

// An owner's ban and a cover's later moderation change no challenge or crucible row, so the walk is
// what deletes those points; moderation requires it at least daily.
describe('the startup walk', () => {
  test('walks once startupDelayMs after start, before the first interval', async () => {
    vi.useFakeTimers();
    try {
      const added: number[] = [];
      const pg = {
        query: bounded(async (_sql: string, [cursor]: [number]) => ({
          rows: [1, 2].filter((id) => id > cursor).map((id) => ({ id })),
        })),
      };
      const queue = {
        lanes: new Map([['crucible', { add: (r: { id: number }) => void added.push(r.id) }]]),
        isFull: false,
      };
      const timers = startRefreshers(
        [domain('crucible', { everyMs: 60_000, batch: 10, startupDelayMs: 1000 })],
        queue as never,
        pg as never
      );
      expect(timers).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(999);
      expect(added).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(added).toEqual([1, 2]);
      for (const t of timers) clearInterval(t);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('challenge and crucible refresh walks', () => {
  test.each([
    ['challenge', () => import('@/vector-sync/challenges/domain').then((m) => m.challengeDomain)],
    ['crucible', () => import('@/vector-sync/crucibles/domain').then((m) => m.crucibleDomain)],
  ])('%s walks its whole table at least daily, and soon after every start', async (_name, load) => {
    const { refresh } = await load();
    expect(refresh).toBeDefined();
    expect(refresh!.everyMs).toBeLessThanOrEqual(24 * 60 * 60_000);
    expect(refresh!.startupDelayMs).toBeDefined();
    expect(refresh!.startupDelayMs!).toBeLessThan(refresh!.everyMs);
  });
});

describe('a points-only walk', () => {
  const walk = async (
    rowsFor: (ids: number[]) => number[],
    points: number[],
    ms = 1500,
    where?: string
  ) => {
    const sqls: string[] = [];
    const added: number[] = [];
    const pg = {
      query: bounded(async (sql: string, args: unknown[]) => {
        sqls.push(sql);
        return { rows: rowsFor(args[0] as number[]).map((id) => ({ id })) };
      }, 40),
    };
    const store = {
      idsFrom: async (offset: number, limit: number) => {
        const page = points.filter((id) => id >= offset).slice(0, limit + 1);
        return { ids: page.slice(0, limit), next: page[limit] ?? 0 };
      },
    };
    const queue = {
      lanes: new Map([['video', { add: (r: { id: number }) => void added.push(r.id) }]]),
      isFull: false,
    };
    const timers = startRefreshers(
      [
        {
          name: 'video',
          table: 'Image',
          where,
          refresh: { everyMs: 1000, batch: 2, pointsOnly: true },
          store: () => store,
        } as never,
      ],
      queue as never,
      pg as never
    );
    await vi.advanceTimersByTimeAsync(ms);
    for (const t of timers) clearInterval(t);
    return { sqls, added };
  };

  test('reads the table only by primary key, for the points, and queues each point once a pass', async () => {
    vi.useFakeTimers();
    try {
      const points = [101, 102, 103, 104, 105];
      const { sqls, added } = await walk((ids) => ids.filter((id) => id !== 104), points);
      expect(sqls.every((sql) => sql.includes('= ANY('))).toBe(true);
      expect(sqls.some((sql) => sql.includes('ORDER BY id'))).toBe(false);
      expect([...added].sort()).toEqual(points);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a table that reads empty for several passes deletes none of its points', async () => {
    vi.useFakeTimers();
    try {
      const points = Array.from({ length: 9 }, (_, i) => 101 + i);
      const { added } = await walk(() => [], points, 3500);
      expect(added).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("looks points up within the domain's slice of its table", async () => {
    vi.useFakeTimers();
    try {
      const { sqls } = await walk((ids) => ids, [101, 102], 1500, "type = 'video'");
      expect(sqls.length).toBeGreaterThan(0);
      expect(sqls.every((sql) => sql.includes("AND (type = 'video')"))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a first lookup that finds no rows deletes none of its points', async () => {
    vi.useFakeTimers();
    try {
      const { added } = await walk((ids) => (ids.includes(101) ? [] : ids), [101, 102, 103]);
      expect(added).not.toContain(101);
      expect(added).not.toContain(102);
      expect(added).toContain(103);
    } finally {
      vi.useRealTimers();
    }
  });
});
