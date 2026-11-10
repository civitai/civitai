/**
 * An in-memory reading of the Prisma `where` subset the block services write (OR, AND, `in`,
 * `contains`, `gt`, `gte`, `not`, equality), so a test can run a real `where` against rows and
 * assert which rows it hits instead of pinning the object's shape. A key it does not know reads
 * as equality, so an unsupported operator matches nothing rather than everything.
 */
export type Where = Record<string, unknown>;

export function matches(row: object, where: Where): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as Where[]).some((w) => matches(row, w));
    if (key === 'AND') return (cond as Where[]).every((w) => matches(row, w));
    const value = (row as Record<string, unknown>)[key];
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as { in?: unknown[]; gt?: Date; gte?: Date; not?: unknown; contains?: string };
      if (c.in) return c.in.includes(value);
      if (c.contains !== undefined) return typeof value === 'string' && value.includes(c.contains);
      if (c.gt) return value instanceof Date && value.getTime() > c.gt.getTime();
      if (c.gte) return value instanceof Date && value.getTime() >= c.gte.getTime();
      if ('not' in c) return value !== c.not;
    }
    return value === cond;
  });
}
