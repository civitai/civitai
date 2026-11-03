import type { Clause } from '~/server/search/search-scope';

// Reference semantics for search clauses, over plain documents. Each engine adapter must agree
// with this on the same fixtures. Strings compare case-insensitively, as Meilisearch filters do.
export type Doc = Record<string, unknown>;

const read = (doc: Doc, path: string): unknown[] => {
  let current: unknown[] = [doc];
  for (const key of path.split('.'))
    current = current.flatMap((v) => {
      const next = (v as Doc | undefined)?.[key];
      return next === undefined || next === null ? [] : Array.isArray(next) ? next : [next];
    });
  return current;
};

const same = (a: unknown, b: unknown) =>
  typeof a === 'string' && typeof b === 'string'
    ? a.toLowerCase() === b.toLowerCase()
    : String(a) === String(b);

export function matches(doc: Doc, clause: Clause): boolean {
  switch (clause.kind) {
    case 'eq':
      return read(doc, clause.field).some((v) => same(v, clause.value));
    case 'in':
      return read(doc, clause.field).some((v) => clause.values.some((x) => same(v, x)));
    case 'range':
      return read(doc, clause.field).some((raw) => {
        const v = Number(raw);
        return (
          (clause.gte === undefined || v >= clause.gte) &&
          (clause.lte === undefined || v <= clause.lte) &&
          (clause.gt === undefined || v > clause.gt) &&
          (clause.lt === undefined || v < clause.lt)
        );
      });
    case 'exists':
      return read(doc, clause.field).length > 0;
    case 'not':
      return !matches(doc, clause.clause);
    case 'and':
      return clause.clauses.every((c) => matches(doc, c));
    case 'or':
      return clause.clauses.some((c) => matches(doc, c));
  }
}
