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
 * Every `everyMs`, walks the domain's whole table `batch` ids a read into its lane, flushing the
 * queue whenever it fills. A failed read or flush stops the pass, and the next tick resumes it from
 * the same cursor; a tick is skipped while the previous pass runs.
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
        if (queue.isFull) await queue.flush();
        const { ids, next } = await nextRefreshIds(pg, domain, cursor, refresh.batch);
        for (const id of ids) lane.add({ id });
        cursor = next;
      } while (cursor !== 0);
    };
    return [
      setInterval(() => {
        if (running) return;
        running = true;
        pass()
          .catch((err) => logger.error({ err }, `${domain.name}-sync: refresh pass stopped`))
          .finally(() => {
            running = false;
          });
      }, refresh.everyMs),
    ];
  });
}
