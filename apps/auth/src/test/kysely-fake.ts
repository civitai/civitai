// In-memory stand-in for the slice of Kysely the OAuth routes use, over plain row arrays. It FILTERS,
// JOINS and PROJECTS rather than returning canned rows, so a route that drops a `where` or joins the
// wrong column reads the wrong rows here too. Anything it does not implement throws.

type Row = Record<string, unknown>;
type Get = (column: string) => unknown;
type Clause = (get: Get) => boolean;

const compare = (column: string, op: string, value: unknown): Clause => {
  return (get) => {
    const actual = get(column);
    // SQL `=` is never true against NULL; only `is` matches it.
    if (op === '=') return value != null && actual === value;
    if (op === 'is') return actual === value;
    if (op === '<' && actual instanceof Date && value instanceof Date) {
      return actual.getTime() < value.getTime();
    }
    if (op === '<') return false;
    if (op === 'in') return (value as unknown[]).includes(actual);
    if (op === '>=' && actual instanceof Date && value instanceof Date) {
      return actual.getTime() >= value.getTime();
    }
    if (op === '>=') return false;
    throw new Error(`kysely fake: operator "${op}" is not implemented`);
  };
};

const eb = Object.assign(compare, {
  or:
    (clauses: Clause[]): Clause =>
    (get) =>
      clauses.some((c) => c(get)),
});

function addWhere(clauses: Clause[], a: unknown, op?: string, value?: unknown) {
  clauses.push(
    typeof a === 'function'
      ? (a as (b: typeof eb) => Clause)(eb)
      : compare(a as string, op as string, value)
  );
}

export type TableDefaults = Record<string, (row: Row) => Row>;

export function createKyselyFake(tables: Record<string, Row[]>, defaults: TableDefaults = {}) {
  const rows = (table: string): Row[] => (tables[table] ??= []);
  const ids: Record<string, number> = {};
  const nextId = (table: string) => {
    ids[table] =
      (ids[table] ?? rows(table).reduce((m, r) => Math.max(m, Number(r.id) || 0), 0)) + 1;
    return ids[table];
  };

  const plainGet =
    (row: Row): Get =>
    (column) =>
      row[column.includes('.') ? column.slice(column.indexOf('.') + 1) : column];

  function selectFrom(base: string) {
    const clauses: Clause[] = [];
    const joins: { table: string; left: string; right: string }[] = [];
    let columns: string[] | 'all' = [];
    const qb = {
      innerJoin(table: string, left: string, right: string) {
        joins.push({ table, left, right });
        return qb;
      },
      select(cols: string | string[]) {
        if (columns !== 'all') columns = [...columns, ...(Array.isArray(cols) ? cols : [cols])];
        return qb;
      },
      selectAll() {
        columns = 'all';
        return qb;
      },
      where(a: unknown, op?: string, value?: unknown) {
        addWhere(clauses, a, op, value);
        return qb;
      },
      async execute() {
        const out: Row[] = [];
        for (const row of rows(base)) {
          const scope: Record<string, Row> = { [base]: row };
          const get: Get = (column) => {
            const dot = column.indexOf('.');
            if (dot < 0) return row[column];
            return scope[column.slice(0, dot)]?.[column.slice(dot + 1)];
          };
          const joined = joins.every(({ table, left, right }) => {
            const [lt, lc] = left.split('.');
            const [rt, rc] = right.split('.');
            const [ownCol, otherTable, otherCol] = lt === table ? [lc, rt, rc] : [rc, lt, lc];
            const key = scope[otherTable]?.[otherCol];
            const match = key == null ? undefined : rows(table).find((r) => r[ownCol] === key);
            if (match) scope[table] = match;
            return !!match;
          });
          if (!joined || !clauses.every((c) => c(get))) continue;
          if (columns === 'all') {
            out.push({ ...row });
            continue;
          }
          out.push(Object.fromEntries(columns.map((c) => [c.slice(c.indexOf('.') + 1), get(c)])));
        }
        return out;
      },
      async executeTakeFirst() {
        return (await qb.execute())[0];
      },
    };
    return qb;
  }

  function insertInto(table: string) {
    let values: Row[] = [];
    let conflict: { columns: string[]; set: Row } | undefined;
    let returning: string[] | undefined;
    const qb = {
      values(v: Row | Row[]) {
        values = Array.isArray(v) ? v : [v];
        return qb;
      },
      onConflict(
        cb: (oc: {
          columns: (c: string[]) => { doUpdateSet: (s: Row) => unknown };
          column: (c: string) => { doNothing: () => unknown };
        }) => unknown
      ) {
        cb({
          columns: (c) => ({ doUpdateSet: (set) => (conflict = { columns: c, set }) }),
          column: (c) => ({ doNothing: () => (conflict = { columns: [c], set: {} }) }),
        });
        return qb;
      },
      returning(cols: string[]) {
        returning = cols;
        return qb;
      },
      async execute() {
        const out: Row[] = [];
        for (const v of values) {
          const existing = conflict
            ? rows(table).find((r) => conflict!.columns.every((c) => r[c] === v[c]))
            : undefined;
          let row: Row;
          if (existing) {
            Object.assign(existing, conflict!.set);
            row = existing;
          } else {
            row = { ...(defaults[table]?.(v) ?? {}), ...v };
            if (row.id === undefined) row.id = nextId(table);
            rows(table).push(row);
          }
          out.push(returning ? Object.fromEntries(returning.map((c) => [c, row[c]])) : row);
        }
        return out;
      },
      async executeTakeFirst() {
        return (await qb.execute())[0];
      },
      async executeTakeFirstOrThrow() {
        const row = await qb.executeTakeFirst();
        if (!row) throw new Error('kysely fake: no row');
        return row;
      },
    };
    return qb;
  }

  function updateTable(table: string) {
    const clauses: Clause[] = [];
    let set: Row = {};
    const qb = {
      set(s: Row) {
        set = s;
        return qb;
      },
      where(a: unknown, op?: string, value?: unknown) {
        addWhere(clauses, a, op, value);
        return qb;
      },
      async executeTakeFirst() {
        const hit = rows(table).filter((r) => clauses.every((c) => c(plainGet(r))));
        hit.forEach((r) => Object.assign(r, set));
        return { numUpdatedRows: BigInt(hit.length) };
      },
    };
    return qb;
  }

  function deleteFrom(table: string) {
    const clauses: Clause[] = [];
    const qb = {
      where(a: unknown, op?: string, value?: unknown) {
        addWhere(clauses, a, op, value);
        return qb;
      },
      async executeTakeFirst() {
        const keep = rows(table).filter((r) => !clauses.every((c) => c(plainGet(r))));
        const removed = rows(table).length - keep.length;
        tables[table] = keep;
        return { numDeletedRows: BigInt(removed) };
      },
      async execute() {
        return [await qb.executeTakeFirst()];
      },
    };
    return qb;
  }

  const db = {
    selectFrom,
    insertInto,
    updateTable,
    deleteFrom,
    transaction: () => ({ execute: <T>(fn: (trx: typeof db) => Promise<T>) => fn(db) }),
  };
  return db;
}
