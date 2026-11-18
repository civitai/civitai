import type { Pool } from 'pg';
import { logger } from '@/utils/logger';
import type { Domain, DomainRef } from './sync';

/**
 * The next `batch` ids of the domain's table after `cursor`, by keyset, and the cursor for the
 * following call: 0 once the table is exhausted, so the walk wraps.
 */
export async function nextRefreshIds(
  pg: Pick<Pool, 'query'>,
  domain: Pick<Domain<any>, 'table'>,
  cursor: number,
  batch: number
): Promise<{ ids: number[]; next: number }> {
  const { rows } = await pg.query<{ id: number }>(
    `SELECT id FROM "${domain.table}" WHERE id > $1 ORDER BY id LIMIT $2`,
    [cursor, batch]
  );
  const ids = rows.map((r) => Number(r.id));
  return { ids, next: ids.length < batch ? 0 : ids[ids.length - 1] };
}

type RefreshQueue = {
  lanes: Map<string, { add(ref: DomainRef): void }>;
  readonly isFull: boolean;
  flush(): Promise<void>;
};

/**
 * Every `everyMs`, walks the domain's whole table `batch` ids a read into its lane, with the
 * collection's points in the same id range, flushing the
 * queue whenever it fills. A failed read or flush stops the pass, and the next tick resumes it from
 * the same cursor; a tick is skipped while the previous pass runs. With `startupDelayMs`, one more
 * tick runs that long after start: the cursor lives in memory, so a process restarting more often
 * than `everyMs` would otherwise never finish a pass.
 */
export function startRefreshers(
  domains: Domain<any>[],
  queue: RefreshQueue,
  pg: Pick<Pool, 'query'>
): ReturnType<typeof setTimeout>[] {
  return domains.flatMap((domain) => {
    const { refresh } = domain;
    const lane = queue.lanes.get(domain.name);
    if (!refresh || !lane) return [];
    const store = domain.store?.();
    let cursor = 0;
    let running = false;
    const pass = async () => {
      do {
        if (queue.isFull) await queue.flush();
        const { ids, next } = await nextRefreshIds(pg, domain, cursor, refresh.batch);
        // A deleted row is not in the table to walk, so its point is found from the collection
        // side: every point in this batch's id range is queued too, and one with no row is deleted.
        const points = store
          ? await store.idsInRange(cursor + 1, next === 0 ? Number.MAX_SAFE_INTEGER : next + 1)
          : [];
        for (const id of new Set([...ids, ...points])) lane.add({ id });
        cursor = next;
      } while (cursor !== 0);
    };
    const tick = () => {
      if (running) return;
      running = true;
      pass()
        .catch((err) => logger.error({ err }, `${domain.name}-sync: refresh pass stopped`))
        .finally(() => {
          running = false;
        });
    };
    return [
      setInterval(tick, refresh.everyMs),
      ...(refresh.startupDelayMs === undefined ? [] : [setTimeout(tick, refresh.startupDelayMs)]),
    ];
  });
}
