import { sql, type Kysely } from 'kysely';
import type { DB as MainDB } from '@civitai/db-schema/kysely';
import type { DB as ModeratorDB } from '../moderator-db/types';
import type { LabEntityType } from '../../text-scan-lab/types';

// Relative imports only: the purge CLI loads this file through tsx, which resolves no `$lib`/`$env`.

/** Ids per main-database lookup, and per wipe. */
export const PURGE_BATCH = 500;

type Source = {
  [T in keyof MainDB]: {
    table: T;
    key: keyof MainDB[T] & string;
    /** Nullable in some tables (system-created rows); a null author is never "deleted". */
    author: keyof MainDB[T] & string;
    softDelete: boolean;
  };
}[keyof MainDB];

/** Where each lab entity type's row lives in the main database. Only Model, ChatMessage and User soft-delete. */
export const SOURCES: Record<LabEntityType, Source> = {
  Model: { table: 'Model', key: 'id', author: 'userId', softDelete: true },
  Article: { table: 'Article', key: 'id', author: 'userId', softDelete: false },
  Post: { table: 'Post', key: 'id', author: 'userId', softDelete: false },
  Bounty: { table: 'Bounty', key: 'id', author: 'userId', softDelete: false },
  BountyEntry: { table: 'BountyEntry', key: 'id', author: 'userId', softDelete: false },
  Challenge: { table: 'Challenge', key: 'id', author: 'createdById', softDelete: false },
  Crucible: { table: 'Crucible', key: 'id', author: 'userId', softDelete: false },
  Collection: { table: 'Collection', key: 'id', author: 'userId', softDelete: false },
  ChatMessage: { table: 'ChatMessage', key: 'id', author: 'userId', softDelete: true },
  Comment: { table: 'Comment', key: 'id', author: 'userId', softDelete: false },
  CommentV2: { table: 'CommentV2', key: 'id', author: 'userId', softDelete: false },
  ResourceReview: { table: 'ResourceReview', key: 'id', author: 'userId', softDelete: false },
  User: { table: 'User', key: 'id', author: 'id', softDelete: true },
  UserProfile: { table: 'UserProfile', key: 'userId', author: 'userId', softDelete: false },
};

export type PurgeDbs = { moderator: Kysely<ModeratorDB>; main: Kysely<MainDB> };

const chunks = <T>(xs: T[], size: number) =>
  Array.from({ length: Math.ceil(xs.length / size) }, (_, i) => xs.slice(i * size, (i + 1) * size));

/** The ids whose row is gone, soft-deleted, or whose author's account is deleted. Primary-key lookups only. */
async function goneIds(main: Kysely<MainDB>, source: Source, ids: number[]): Promise<number[]> {
  const deleted = source.softDelete ? sql`e."deletedAt" IS NOT NULL` : sql`false`;
  const { rows } = await sql<{ id: number; gone: boolean }>`
    SELECT ${sql.ref(`e.${source.key}`)} AS id,
           ${deleted} OR u."deletedAt" IS NOT NULL AS gone
    FROM ${sql.table(source.table)} e
    LEFT JOIN "User" u ON u.id = ${sql.ref(`e.${source.author}`)}
    WHERE ${sql.ref(`e.${source.key}`)} IN (${sql.join(ids)})
  `.execute(main);
  const live = new Set(rows.filter((r) => !r.gone).map((r) => Number(r.id)));
  return ids.filter((id) => !live.has(id));
}

/** Wipes the text of entity cases whose source entity or author account was deleted, keeping the
 *  expectation, hash and note. Free text and synthetic cases are never touched. Idempotent. */
export async function purgeDeletedSources(
  { moderator, main }: PurgeDbs,
  setId?: number
): Promise<{ checked: number; wiped: number }> {
  let q = moderator
    .selectFrom('text_scan_test_case')
    .select(['entity_type', 'entity_id'])
    .where('entity_id', 'is not', null)
    .where('fields', 'is not', null)
    .where('synthetic', '=', false);
  if (setId !== undefined) q = q.where('set_id', '=', String(setId));
  const cases = await q.execute();

  const idsByType = new Map<LabEntityType, Set<number>>();
  for (const c of cases) {
    const type = c.entity_type as LabEntityType;
    // A type the lab no longer knows is left alone rather than guessed at.
    if (!(type in SOURCES)) continue;
    idsByType.set(type, (idsByType.get(type) ?? new Set()).add(c.entity_id!));
  }

  let wiped = 0;
  for (const [type, ids] of idsByType) {
    for (const batch of chunks([...ids], PURGE_BATCH)) {
      const gone = await goneIds(main, SOURCES[type], batch);
      if (!gone.length) continue;
      let wipe = moderator
        .updateTable('text_scan_test_case')
        .set({ fields: null, source_deleted_at: sql`now()`, updated_at: sql`now()` })
        .where('entity_type', '=', type)
        .where('entity_id', 'in', gone)
        .where('fields', 'is not', null)
        .where('synthetic', '=', false);
      if (setId !== undefined) wipe = wipe.where('set_id', '=', String(setId));
      wiped += Number((await wipe.executeTakeFirst()).numUpdatedRows);
    }
  }
  return { checked: cases.length, wiped };
}
