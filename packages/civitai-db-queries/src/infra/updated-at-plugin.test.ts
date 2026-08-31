import { describe, expect, it } from 'vitest';
import {
  type CompiledQuery,
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  sql,
} from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { updatedAtPlugin } from './updated-at-plugin';

// An offline Kysely with the plugin installed; captures the compiled SQL via the log hook.
function pluginDb(updatedAtTables: string[]) {
  const queries: CompiledQuery[] = [];
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (k) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    plugins: [updatedAtPlugin(new Set(updatedAtTables))],
    log: (e) => {
      if (e.level === 'query') queries.push(e.query);
    },
  });
  return { db, last: () => queries[queries.length - 1] };
}

describe('updatedAtPlugin', () => {
  it('auto-stamps updatedAt on an UPDATE to a listed table', async () => {
    const h = pluginDb(['Image']);
    await h.db.updateTable('Image').set({ needsReview: null }).where('id', '=', 1).execute();
    const { sql, parameters } = h.last();
    expect(sql).toBe('update "Image" set "needsReview" = $1, "updatedAt" = $2 where "id" = $3');
    expect(parameters[1]).toBeInstanceOf(Date); // stamped with the app clock (Prisma-parity)
  });

  it('stamps an aliased update target (updateTable("Image as i")) on a listed table', async () => {
    const h = pluginDb(['Image']);
    // The alias wraps the table in an AliasNode; the plugin must unwrap it to recognize the @updatedAt table,
    // else it would silently skip the stamp.
    await h.db.updateTable('Image as i').set({ needsReview: null }).where('i.id', '=', 1).execute();
    const { sql } = h.last();
    expect(sql).toBe(
      'update "Image" as "i" set "needsReview" = $1, "updatedAt" = $2 where "i"."id" = $3'
    );
  });

  it('leaves an UPDATE to an unlisted table untouched', async () => {
    const h = pluginDb(['Image']); // Report is NOT in the @updatedAt set
    await h.db.updateTable('Report').set({ internalNotes: 'x' }).where('id', '=', 1).execute();
    const { sql } = h.last();
    expect(sql).toBe('update "Report" set "internalNotes" = $1 where "id" = $2');
    expect(sql).not.toContain('updatedAt');
  });

  it('respects an explicit updatedAt (never double-stamps)', async () => {
    const h = pluginDb(['Image']);
    const when = new Date('2024-01-01T00:00:00.000Z');
    await h.db
      .updateTable('Image')
      .set({ needsReview: null, updatedAt: when })
      .where('id', '=', 1)
      .execute();
    const { sql, parameters } = h.last();
    expect(sql).toBe('update "Image" set "needsReview" = $1, "updatedAt" = $2 where "id" = $3');
    expect(parameters[1]).toBe(when); // the caller's value wins; not a second stamp
    expect((sql.match(/updatedAt/g) ?? []).length).toBe(1);
  });

  it('detects an explicit updatedAt set via the chained .set(column, value) form (no double-stamp)', async () => {
    const h = pluginDb(['Image']);
    // The `.set(col, val)` form stores the column as a ReferenceNode, not a ColumnNode — the plugin must still
    // recognize the explicit updatedAt and not append a second one.
    await h.db
      .updateTable('Image')
      .set('poi', sql<boolean>`NOT "poi"`)
      .set('updatedAt', new Date())
      .where('id', '=', 1)
      .execute();
    const { sql: text } = h.last();
    expect(text).toBe('update "Image" set "poi" = NOT "poi", "updatedAt" = $1 where "id" = $2');
    expect((text.match(/updatedAt/g) ?? []).length).toBe(1); // exactly one, no double-stamp
  });

  it('can be opted out per-query with withoutPlugins() — the deliberate no-bump case', async () => {
    const h = pluginDb(['Image']);
    // An ingestion recompute etc. that must NOT bump updatedAt (mirrors the old raw `$executeRaw` intent).
    await h.db
      .withoutPlugins()
      .updateTable('Image')
      .set({ needsReview: null })
      .where('id', '=', 1)
      .execute();
    const { sql } = h.last();
    expect(sql).toBe('update "Image" set "needsReview" = $1 where "id" = $2');
    expect(sql).not.toContain('updatedAt');
  });

  it('never touches raw SQL updates — the natural no-bump path (matches the old $executeRaw)', async () => {
    const h = pluginDb(['Image']);
    await sql`update "Image" set "needsReview" = null where "id" = ${1}`.execute(h.db);
    const { sql: text } = h.last();
    expect(text).toBe('update "Image" set "needsReview" = null where "id" = $1');
    expect(text).not.toContain('updatedAt');
  });

  it('keeps the current value atomically via a self-reference — no read, no withoutPlugins', async () => {
    const h = pluginDb(['Image']);
    // "don't bump" = set updatedAt to its own current value, in one statement. The plugin treats it as an
    // explicit updatedAt and adds nothing.
    await h.db
      .updateTable('Image')
      .set({ needsReview: null, updatedAt: sql`"updatedAt"` })
      .where('id', '=', 1)
      .execute();
    const { sql: text } = h.last();
    expect(text).toBe(
      'update "Image" set "needsReview" = $1, "updatedAt" = "updatedAt" where "id" = $2'
    );
    expect((text.match(/updatedAt/g) ?? []).length).toBe(2); // the two sides of `updatedAt = updatedAt`, no extra stamp
  });
});
