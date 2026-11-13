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
};

/**
 * Starts each refreshing domain's walk: every `everyMs`, one full pass over its table, `batch` ids a
 * read, each into its lane for the queue's normal flush. So whatever the table size or restarts, a
 * row is revisited within one tick. A pass stops early when the queue fills or a read fails, and the
 * next tick resumes it from there; a tick is skipped while the previous pass runs or the queue is
 * full. Returns the timers, for shutdown.
 */
export function startRefreshers(
  domains: Domain<any>[],
  queue: RefreshQueue,
  pg: Pick<Pool, 'query'>
): ReturnType<typeof setInterval>[] {
  return domains.flatMap((domain) => {
    const { refresh } = domain;
    const lane = queue.lanes.get(domain.name);
    if (!refresh || !lane) return [];
    let cursor = 0;
    let running = false;
    const pass = async () => {
      do {
        const { ids, next } = await nextRefreshIds(pg, domain, cursor, refresh.batch);
        for (const id of ids) lane.add({ id });
        cursor = next;
      } while (cursor !== 0 && !queue.isFull);
    };
    return [
      setInterval(() => {
        if (running || queue.isFull) return;
        running = true;
        pass()
          .catch((err) => logger.error({ err }, `${domain.name}-sync: refresh read failed`))
          .finally(() => {
            running = false;
          });
      }, refresh.everyMs),
    ];
  });
}
