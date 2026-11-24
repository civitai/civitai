import type { Pool } from 'pg';
import { logger } from '@/utils/logger';
import { vectorSyncMetrics } from '../metrics';
import type { Domain, DomainRef } from './sync';

/**
 * More points with no row in one batch than this suggests a bad read (a lagging replica, an empty
 * result) rather than deleted rows, so none of them are deleted that pass: more than 10, and more
 * than a tenth of the batch's points.
 */
export const orphanBrake = (orphans: number, points: number) =>
  orphans > 10 && orphans > points / 10;

/**
 * The next `batch` points after `cursor`, the ones whose row is in the domain's slice of its table
 * (by primary key), and the cursor for the following call: 0 once the collection is exhausted.
 */
export async function nextRefreshPoints(
  pg: Pick<Pool, 'query'>,
  domain: Pick<Domain<any>, 'table' | 'where'>,
  store: { idsFrom(offset: number, limit: number): Promise<{ ids: number[]; next: number }> },
  cursor: number,
  batch: number
): Promise<{ ids: number[]; points: number[]; next: number }> {
  const page = await store.idsFrom(cursor + 1, batch);
  if (!page.ids.length) return { ids: [], points: [], next: 0 };
  const { rows } = await pg.query<{ id: number }>(
    `SELECT id FROM "${domain.table}" WHERE id = ANY($1::int[])${andWhere(domain)}`,
    [page.ids]
  );
  return { ids: rows.map((r) => Number(r.id)), points: page.ids, next: page.next && page.next - 1 };
}

/**
 * The next `batch` ids of the domain's table after `cursor`, by keyset, and the cursor for the
 * following call: 0 once the table is exhausted, so the walk wraps.
 */
export async function nextRefreshIds(
  pg: Pick<Pool, 'query'>,
  domain: Pick<Domain<any>, 'table' | 'where'>,
  cursor: number,
  batch: number
): Promise<{ ids: number[]; next: number }> {
  const { rows } = await pg.query<{ id: number }>(
    `SELECT id FROM "${domain.table}" WHERE id > $1${andWhere(domain)} ORDER BY id LIMIT $2`,
    [cursor, batch]
  );
  const ids = rows.map((r) => Number(r.id));
  return { ids, next: ids.length < batch ? 0 : ids[ids.length - 1] };
}

/** The domain's slice of its table, as a clause to append to a WHERE. */
export const andWhere = (domain: Pick<Domain<any>, 'where'>) =>
  domain.where ? ` AND (${domain.where})` : '';

type RefreshQueue = {
  lanes: Map<string, { add(ref: DomainRef): void }>;
  readonly isFull: boolean;
  flush(): Promise<void>;
};

/**
 * Every `everyMs`, walks the domain's whole table `batch` ids a read into its lane, with the
 * collection's points in the same id range (or, with `pointsOnly`, only the collection's points,
 * looked up in the table by primary key), flushing the
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
    if (refresh.pointsOnly && !store) {
      logger.error(`${domain.name}-sync: a points-only walk needs a store; not walking`);
      return [];
    }
    // Orphans held on the last full pass: still orphans a pass later, they are rows really deleted.
    let heldLastPass = new Set<number>();
    // This pass's holds; kept when a pass fails partway, since its next tick resumes the same pass.
    let held = new Set<number>();
    let cursor = 0;
    let running = false;
    const pass = async () => {
      do {
        if (queue.isFull) await queue.flush();
        const from = cursor + 1;
        const walked = refresh.pointsOnly
          ? await nextRefreshPoints(pg, domain, store!, cursor, refresh.batch)
          : undefined;
        const { ids, next } = walked ?? (await nextRefreshIds(pg, domain, cursor, refresh.batch));
        // A deleted row is not in the table to walk, so its point is found from the collection
        // side: every point in this batch's id range is queued too, and one with no row is deleted.
        const points = walked
          ? walked.points
          : store
          ? await store
              .idsInRange(from, next === 0 ? Number.MAX_SAFE_INTEGER : next + 1)
              .catch((err) => {
                logger.error({ err, from }, `${domain.name}-sync: refresh could not read points`);
                return [] as number[];
              })
          : [];
        const rows = new Set(ids);
        let orphans = points.filter((id) => !rows.has(id));
        // A table read that came back empty is a bad read, or a cleanup to run by hand: never trusted,
        // however few points it would delete. Its orphans are not held either, since a hold would
        // exempt them from the brake on the next pass.
        // A points batch is read by primary key, so one that finds no rows is the same bad read anywhere
        // in the pass, and the held-orphan recheck would repeat it rather than check it.
        if ((cursor === 0 || walked) && ids.length === 0) {
          if (orphans.length) {
            logger.error(
              { points: points.length, sample: orphans.slice(0, 10) },
              `${domain.name}-sync: refresh read no rows but the collection has points; deleting none`
            );
            vectorSyncMetrics.orphanBrakes.inc({ domain: domain.name });
          }
          orphans = [];
        }
        const fresh = orphans.filter((id) => !heldLastPass.has(id));
        if (orphanBrake(fresh.length, points.length)) {
          for (const id of fresh) held.add(id);
          logger.error(
            { orphans: fresh.length, points: points.length, from, sample: fresh.slice(0, 10) },
            `${domain.name}-sync: refresh found too many points with no row in one batch; holding them a pass`
          );
          vectorSyncMetrics.orphanBrakes.inc({ domain: domain.name });
          orphans = orphans.filter((id) => heldLastPass.has(id));
        }
        // A held orphan is released only once a primary-key lookup on the table confirms its row is
        // gone, so a walk read that keeps missing rows cannot delete them; a failed lookup releases none.
        const recheck = orphans.filter((id) => heldLastPass.has(id));
        if (recheck.length) {
          const present = await pg
            .query<{ id: number }>(
              `SELECT id FROM "${domain.table}" WHERE id = ANY($1::int[])${andWhere(domain)}`,
              [recheck]
            )
            .then(({ rows: found }) => new Set(found.map((r) => Number(r.id))))
            .catch((err) => {
              logger.error(
                { err, from },
                `${domain.name}-sync: held orphan lookup failed; releasing none`
              );
              return new Set(recheck);
            });
          if (present.size) {
            logger.error(
              { present: present.size, from, sample: [...present].slice(0, 10) },
              `${domain.name}-sync: held orphans still have rows; keeping them held`
            );
            for (const id of present) held.add(id);
            orphans = orphans.filter((id) => !present.has(id));
          }
        }
        for (const id of [...ids, ...orphans]) lane.add({ id });
        cursor = next;
      } while (cursor !== 0);
      heldLastPass = held;
      held = new Set();
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
