import { sql, type SqlBool } from 'kysely';

type ItemState = { status: string; appliedAt: Date | null; audience?: string | null };

/**
 * An item whose outcome can no longer change: closed, resolved and written back to the image, or a yes/no question (one with an `audience`) that
 * reached its consensus; nothing is written back for those, and a rating item is never in `Consensus`.
 */
export const isFinalItem = (item: ItemState): boolean =>
  item.status === 'Closed' ||
  (item.status === 'Consensus' && item.audience != null) ||
  (item.status === 'Resolved' && item.appliedAt !== null);

/** The same rule as a `where` clause; pass the table alias when the item is joined under one. */
export function finalItem(alias?: string) {
  const column = (name: string) => sql.ref(alias ? `${alias}.${name}` : name);
  return sql<SqlBool>`(${column('status')} = 'Closed'
    OR (${column('status')} = 'Consensus' AND ${column('audience')} IS NOT NULL)
    OR (${column('status')} = 'Resolved' AND ${column('appliedAt')} IS NOT NULL))`;
}
