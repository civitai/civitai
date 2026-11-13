import type { Pool } from 'pg';
import type { Domain } from './sync';

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
