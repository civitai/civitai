import { sql, type SqlBool } from 'kysely';

type ItemState = { status: string; appliedAt: Date | null };

/** An item whose outcome can no longer change: closed, or resolved and written back to the image. */
export const isFinalItem = (item: ItemState): boolean =>
  item.status === 'Closed' || (item.status === 'Resolved' && item.appliedAt !== null);

/** The same rule as a `where` clause; pass the table alias when the item is joined under one. */
export function finalItem(alias?: string) {
  const column = (name: string) => sql.ref(alias ? `${alias}.${name}` : name);
  return sql<SqlBool>`(${column('status')} = 'Closed' OR (${column(
    'status'
  )} = 'Resolved' AND ${column('appliedAt')} IS NOT NULL))`;
}
