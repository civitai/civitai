import { sql, type Kysely } from 'kysely';
import type { DB as MainDB } from '@civitai/db-schema/kysely';
import type { DB as ModeratorDB } from '../moderator-db/types';
import { chunk } from '../../text-scan-lab/chunk';
import type { LabEntityType } from '../../text-scan-lab/types';

// Relative imports only: the purge CLI loads this file through tsx, which resolves no `$lib`/`$env`.

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
  // Bounty, BountyEntry and Challenge authors are nullable (system-created rows); a null author is
  // only checked for existence.
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

// Primary-key lookups only.
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

/** The rows a case's text came from: every message of a ChatMessage window, else the entity itself. */
function sourceIdsOf(entityId: number, sourceIds: unknown): number[] {
  const ids = Array.isArray(sourceIds) ? sourceIds.filter((id) => Number.isInteger(id)) : [];
  return ids.length ? ids : [entityId];
}

// Free text (no entity id) is never touched.
export async function purgeDeletedSources(
  { moderator, main }: PurgeDbs,
  setId?: number
): Promise<{ checked: number; wiped: number }> {
  let q = moderator
    .selectFrom('text_scan_test_case')
    .select(['id', 'entity_type', 'entity_id', 'source_ids'])
    .where('entity_id', 'is not', null)
    .where('fields', 'is not', null);
  if (setId !== undefined) q = q.where('set_id', '=', String(setId));
  const cases = await q.execute();

  const casesBySource = new Map<LabEntityType, Map<number, string[]>>();
  let checked = 0;
  for (const c of cases) {
    const type = c.entity_type as LabEntityType;
    // A type the lab no longer knows is left alone rather than guessed at.
    if (!(type in SOURCES)) continue;
    checked++;
    const byId = casesBySource.get(type) ?? new Map<number, string[]>();
    casesBySource.set(type, byId);
    for (const id of sourceIdsOf(c.entity_id!, c.source_ids))
      byId.set(id, [...(byId.get(id) ?? []), c.id]);
  }

  const goneCases = new Set<string>();
  for (const [type, byId] of casesBySource) {
    for (const batch of chunk([...byId.keys()], PURGE_BATCH)) {
      for (const id of await goneIds(main, SOURCES[type], batch))
        for (const caseId of byId.get(id)!) goneCases.add(caseId);
    }
  }

  let wiped = 0;
  for (const batch of chunk([...goneCases], PURGE_BATCH)) {
    const rows = await moderator
      .updateTable('text_scan_test_case')
      .set({ fields: null, source_deleted_at: sql`now()`, updated_at: sql`now()` })
      .where('id', 'in', batch)
      .where('fields', 'is not', null)
      .returning('id')
      .execute();
    wiped += rows.length;
  }
  // A stored output's `reason` can quote the text. Swept for every wiped case, not only those wiped
  // now, so a result a run wrote while its case was being wiped is caught on the next purge.
  let wipedResults = moderator
    .selectFrom('text_scan_test_case')
    .select('id')
    .where('source_deleted_at', 'is not', null);
  if (setId !== undefined) wipedResults = wipedResults.where('set_id', '=', String(setId));
  await moderator
    .updateTable('text_scan_test_result')
    .set({ output: null })
    .where('output', 'is not', null)
    .where('case_id', 'in', wipedResults)
    .execute();
  return { checked, wiped };
}
