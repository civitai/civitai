import { describe, expect, it } from 'vitest';
import { readCatalog } from '../catalog';
import type { CatalogQueryRunner } from '../catalog';

/**
 * A stand-in for the Postgres client that answers by matching on the shape of the SQL.
 * This exercises the row-decoding half of the catalog reader — action codes, ordered
 * column tuples, expression indexes, INCLUDE columns — without a database.
 *
 * It does NOT exercise the SQL itself. What the queries return against a real catalog is
 * a separate claim; see the README.
 */
function fakeRunner(rows: {
  tables?: unknown[];
  columns?: unknown[];
  foreignKeys?: unknown[];
  uniqueIndexes?: unknown[];
}): CatalogQueryRunner & { schemas: string[] } {
  const schemas: string[] = [];
  return {
    schemas,
    async query<R>(text: string, values?: unknown[]): Promise<{ rows: R[] }> {
      schemas.push(String(values?.[0]));
      if (text.includes('pg_constraint')) return { rows: (rows.foreignKeys ?? []) as R[] };
      if (text.includes('pg_index')) return { rows: (rows.uniqueIndexes ?? []) as R[] };
      if (text.includes('pg_attribute a')) return { rows: (rows.columns ?? []) as R[] };
      return { rows: (rows.tables ?? []) as R[] };
    },
  };
}

describe('readCatalog', () => {
  it('passes the requested schema to every query', async () => {
    const runner = fakeRunner({});
    await readCatalog(runner, 'some_schema');
    expect(runner.schemas).toEqual(Array(4).fill('some_schema'));
  });

  it('reads nullability from is_not_null, not a reserved-word alias', async () => {
    const catalog = await readCatalog(
      fakeRunner({
        columns: [
          { table_name: 'A', column_name: 'id', is_not_null: true },
          { table_name: 'A', column_name: 'nickname', is_not_null: false },
        ],
      })
    );
    expect(catalog.columns).toEqual([
      { table: 'A', column: 'id', notNull: true },
      { table: 'A', column: 'nickname', notNull: false },
    ]);
  });

  it('decodes every Postgres referential-action code', async () => {
    const codes = ['a', 'r', 'c', 'n', 'd'];
    const catalog = await readCatalog(
      fakeRunner({
        foreignKeys: codes.map((code, i) => ({
          name: `fk_${code}`,
          table_name: 'A',
          ref_table: 'B',
          on_delete_code: code,
          on_update_code: codes[codes.length - 1 - i],
          columns: ['bId'],
          ref_columns: ['id'],
        })),
      })
    );
    expect(catalog.foreignKeys.map((fk) => fk.onDelete)).toEqual([
      'NoAction',
      'Restrict',
      'Cascade',
      'SetNull',
      'SetDefault',
    ]);
    expect(catalog.foreignKeys.map((fk) => fk.onUpdate)).toEqual([
      'SetDefault',
      'SetNull',
      'Cascade',
      'Restrict',
      'NoAction',
    ]);
  });

  it('throws on an action code it does not recognise instead of guessing', async () => {
    await expect(
      readCatalog(
        fakeRunner({
          foreignKeys: [
            {
              name: 'fk',
              table_name: 'A',
              ref_table: 'B',
              on_delete_code: 'z',
              on_update_code: 'c',
              columns: ['bId'],
              ref_columns: ['id'],
            },
          ],
        })
      )
    ).rejects.toThrow(/Unrecognised Postgres referential-action code "z"/);
  });

  it('preserves constrained and referenced column order', async () => {
    const catalog = await readCatalog(
      fakeRunner({
        foreignKeys: [
          {
            name: 'fk',
            table_name: 'Slot',
            ref_table: 'Project',
            on_delete_code: 'c',
            on_update_code: 'c',
            columns: ['projectId', 'position'],
            ref_columns: ['projectId', 'position'],
          },
        ],
      })
    );
    expect(catalog.foreignKeys[0].columns).toEqual(['projectId', 'position']);
    expect(catalog.foreignKeys[0].refColumns).toEqual(['projectId', 'position']);
  });

  // Found by executing the queries against a real Postgres, not by reading them: `attname`
  // is `name`, and node-postgres has no parser for `name[]`, so `array_agg(a.attname)`
  // arrives as the literal STRING "{a,b}". `.length` still answers (a character count), so
  // nothing throws and every column tuple downstream is quietly nonsense — unique indexes
  // disappeared from the catalog entirely. The `::text` cast is the fix; this is the guard.
  it('refuses a column list the driver handed back unparsed', async () => {
    await expect(
      readCatalog(
        fakeRunner({
          foreignKeys: [
            {
              name: 'fk',
              table_name: 'Slot',
              ref_table: 'Project',
              on_delete_code: 'c',
              on_update_code: 'c',
              columns: '{projectId,position}',
              ref_columns: ['projectId', 'position'],
            },
          ],
        })
      )
    ).rejects.toThrow(/Expected an array of column names for foreign key fk.*attname::text/s);
  });

  it('refuses an unparsed unique-index column list too', async () => {
    await expect(
      readCatalog(
        fakeRunner({ uniqueIndexes: [{ table_name: 'A', key_count: 2, columns: '{x,y}' }] })
      )
    ).rejects.toThrow(/Expected an array of column names for unique index on A/);
  });

  it('keeps a unique index whose key columns all resolved', async () => {
    const catalog = await readCatalog(
      fakeRunner({ uniqueIndexes: [{ table_name: 'A', key_count: 2, columns: ['x', 'y'] }] })
    );
    expect(catalog.uniqueIndexes).toEqual([{ table: 'A', columns: ['x', 'y'] }]);
  });

  it('drops an expression index, whose key positions do not resolve to column names', async () => {
    // An expression index carries attnum 0 for the expression, which has no pg_attribute
    // row, so the aggregate comes back shorter than indnkeyatts. It cannot be matched
    // against a column-name declaration, and keeping it would let a `lower(email)` index
    // masquerade as an index on `email`.
    const catalog = await readCatalog(
      fakeRunner({
        uniqueIndexes: [
          { table_name: 'A', key_count: 2, columns: ['x'] },
          { table_name: 'A', key_count: 1, columns: null },
        ],
      })
    );
    expect(catalog.uniqueIndexes).toEqual([]);
  });

  it('asks Postgres for tables only (no views) and for total unique indexes only', async () => {
    // Pinning these predicates in the query text, since the fake runner cannot execute
    // them: a model on a view must be skippable, and a partial unique index does not
    // enforce a @unique declaration for every row.
    const seen: string[] = [];
    const runner: CatalogQueryRunner = {
      async query<R>(text: string): Promise<{ rows: R[] }> {
        seen.push(text);
        return { rows: [] as R[] };
      },
    };
    await readCatalog(runner);
    const tables = seen.find((s) => s.includes('pg_class c') && !s.includes('pg_attribute'));
    expect(tables).toContain("c.relkind IN ('r', 'p')");
    const indexes = seen.find((s) => s.includes('pg_index'));
    expect(indexes).toContain('i.indpred IS NULL');
    expect(indexes).toContain('i.indisunique');
    const constraints = seen.find((s) => s.includes('pg_constraint'));
    expect(constraints).toContain('WITH ORDINALITY');
    expect(constraints).toContain('confdeltype');
    expect(constraints).toContain('confupdtype');
    // Every column aggregate must be text[], never name[] — see the guard test above.
    for (const sql of seen.filter((s) => s.includes('array_agg'))) {
      expect(sql).not.toMatch(/array_agg\(a\.attname ORDER BY/);
      expect(sql).toMatch(/array_agg\(a\.attname::text ORDER BY/);
    }
  });
});
