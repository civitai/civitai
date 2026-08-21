import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { addViewSchema, VIEW_ENTITY_TYPES, VIEW_TYPES } from '~/server/schema/track.schema';

/**
 * `addViewSchema` is the only gate in front of the `views` insert: `TrackView` is
 * typed from it and `/api/internal/pulse` 400s anything it rejects into a
 * fire-and-forget catch. So a value the ClickHouse column carries and this schema
 * omits is a surface nobody can instrument, and the omission is silent at every
 * layer — which is how `Collection` sat unreachable while the column held it.
 *
 * The check runs one way only: every arm a migration declares must exist here.
 * The reverse would fail on the arms that predate the first migration file in
 * this directory, since the column's baseline is not in the repo.
 */

const MIGRATIONS_DIR = path.join(__dirname, '../../clickhouse/migrations');

/** Members of every `MODIFY COLUMN <column> Enum8(...)` across the migration files. */
function declaredEnumMembers(column: 'type' | 'entityType') {
  const members = new Set<string>();
  for (const file of fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'))) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const declarations = sql.matchAll(
      new RegExp(`MODIFY\\s+COLUMN\\s+${column}\\s+Enum8\\s*\\(([^)]*)\\)`, 'gi')
    );
    for (const [, body] of declarations) {
      for (const [, member] of body.matchAll(/['"]([^'"]+)['"]\s*=\s*-?\d+/g)) members.add(member);
    }
  }
  return members;
}

describe('addViewSchema covers the ClickHouse views columns', () => {
  it.each([
    ['type', VIEW_TYPES],
    ['entityType', VIEW_ENTITY_TYPES],
  ] as const)('accepts every %s arm a migration declares', (column, accepted) => {
    const declared = declaredEnumMembers(column);

    // A parser that matched nothing would pass every assertion below.
    expect(declared.size, `no Enum8 declarations found for ${column}`).toBeGreaterThan(0);

    expect([...declared].filter((member) => !accepted.includes(member as never))).toEqual([]);
  });

  it('accepts a collection view', () => {
    expect(
      addViewSchema.safeParse({ type: 'CollectionView', entityType: 'Collection', entityId: 1 })
        .success
    ).toBe(true);
  });

  it('rejects an entity type the column does not carry', () => {
    expect(
      addViewSchema.safeParse({ type: 'ImageView', entityType: 'CommentV2', entityId: 1 }).success
    ).toBe(false);
  });
});
