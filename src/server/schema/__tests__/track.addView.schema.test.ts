import { describe, expect, it } from 'vitest';

import { addViewSchema, VIEW_ENTITY_TYPES, VIEW_TYPES } from '~/server/schema/track.schema';

/**
 * `addViewSchema` is the only gate in front of the `views` insert: `TrackView` is typed from it, and a
 * payload the `/api/internal/pulse` beacon rejects gets a 400 that `sendView` never inspects. So drift
 * either way is silent, and both directions cost something. A value the column carries and the schema
 * omits is a surface nobody can instrument — that is how `Collection` sat unreachable. A value the schema
 * accepts and the column lacks is worse: ClickHouse rejects the row downstream of a fire-and-forget
 * dispatch, so the view is simply gone.
 *
 * Hence a snapshot of the columns rather than a scan of `src/server/clickhouse/migrations/`. That
 * directory records the migrations someone remembered to commit, not the columns: `Model3D = 12` is live
 * on both and appears in no file there, so a scan of it would have called this schema complete while
 * silently permitting the reverse direction.
 *
 * ⚠️ The snapshot is the copy that goes stale. Refresh it in the same change that widens the columns:
 *
 *   node .claude/skills/clickhouse-query/query.mjs -q "SELECT name, type FROM system.columns
 *     WHERE database='default' AND table='views' AND name IN ('type','entityType')"
 *
 * Captured 2026-08-21; `daily_views.entityType` read identical in the same query.
 */

const VIEWS_TYPE_COLUMN =
  "Enum8('ProfileView' = 1, 'ImageView' = 2, 'PostView' = 3, 'ModelView' = 4, 'ModelVersionView' = 5, 'ArticleView' = 6, 'CollectionView' = 7, 'BountyView' = 8, 'BountyEntryView' = 9, 'ComicProjectView' = 10, 'ComicChapterView' = 11, 'Model3DView' = 12)";

const VIEWS_ENTITY_TYPE_COLUMN =
  "Enum8('User' = 1, 'Image' = 2, 'Post' = 3, 'Model' = 4, 'ModelVersion' = 5, 'Article' = 6, 'Collection' = 7, 'Bounty' = 8, 'BountyEntry' = 9, 'ComicProject' = 10, 'ComicChapter' = 11, 'Model3D' = 12)";

/** The column's members, ordered by the ordinal it stores. */
function columnMembers(columnType: string) {
  return [...columnType.matchAll(/'([^']+)'\s*=\s*(-?\d+)/g)]
    .map(([, member, ordinal]) => ({ member, ordinal: Number(ordinal) }))
    .sort((a, b) => a.ordinal - b.ordinal)
    .map(({ member }) => member);
}

describe('addViewSchema matches the ClickHouse views columns', () => {
  it.each([
    ['type', VIEWS_TYPE_COLUMN, VIEW_TYPES],
    ['entityType', VIEWS_ENTITY_TYPE_COLUMN, VIEW_ENTITY_TYPES],
  ] as const)(
    'accepts exactly what %s stores, in ordinal order',
    (column, columnType, accepted) => {
      const members = columnMembers(columnType);

      // A snapshot that parsed to nothing would satisfy the comparison below by emptying both sides of it.
      expect(members.length, `no members parsed out of the ${column} snapshot`).toBe(12);

      // Equality, not containment: the direction a containment check misses is the schema accepting a value
      // the column would reject. Order carries the ordinals, which is what makes index + 1 usable.
      expect([...accepted]).toEqual(members);
    }
  );

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
