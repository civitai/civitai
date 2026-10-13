import { sql, type Kysely } from 'kysely';
import type { DB as MainDB } from '@civitai/db-schema/kysely';
import type { DB as ModeratorDB } from '../moderator-db/types';
import { chunk } from '../../text-scan-lab/chunk';
import type { LabEntityType } from '../../text-scan-lab/types';

type Source = {
  [T in keyof MainDB]: {
    table: T;
    key: keyof MainDB[T] & string;
    /** Nullable on system-created rows; a null author is only checked for the row itself. */
    author: keyof MainDB[T] & string;
    softDelete: boolean;
  };
}[keyof MainDB];

export const SOURCES: Record<LabEntityType, Source> = {
  Model: { table: 'Model', key: 'id', author: 'userId', softDelete: true },
  ModelRules: { table: 'Model', key: 'id', author: 'userId', softDelete: true },
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

export const SOURCE_BATCH = 500;

export type SourceRef = { caseId: number; entityType: LabEntityType; entityId: number };

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

/** Cases whose source row is gone, soft-deleted, or written by a deleted account. Primary-key lookups. */
export async function goneCaseIds(
  main: Kysely<MainDB>,
  refs: readonly SourceRef[]
): Promise<Set<number>> {
  const byType = new Map<LabEntityType, Map<number, number[]>>();
  for (const ref of refs) {
    if (!(ref.entityType in SOURCES)) continue;
    const byId = byType.get(ref.entityType) ?? new Map<number, number[]>();
    byType.set(ref.entityType, byId);
    byId.set(ref.entityId, [...(byId.get(ref.entityId) ?? []), ref.caseId]);
  }
  const gone = new Set<number>();
  for (const [type, byId] of byType)
    for (const batch of chunk([...byId.keys()], SOURCE_BATCH))
      for (const id of await goneIds(main, SOURCES[type], batch))
        for (const caseId of byId.get(id) ?? []) gone.add(caseId);
  return gone;
}

/** Nulls the text and every stored verdict of these cases: a verdict's reason can quote the text. */
export async function wipeCases(
  db: Kysely<ModeratorDB>,
  caseIds: readonly number[]
): Promise<number> {
  let wiped = 0;
  for (const batch of chunk(caseIds.map(String), SOURCE_BATCH)) {
    const rows = await db
      .updateTable('text_scan_test_case')
      .set({ fields: null, source_deleted_at: sql`now()`, updated_at: sql`now()` })
      .where('id', 'in', batch)
      .where('fields', 'is not', null)
      .returning('id')
      .execute();
    wiped += rows.length;
    await db
      .updateTable('text_scan_test_result')
      .set({ output: null })
      .where('case_id', 'in', batch)
      .where('output', 'is not', null)
      .execute();
  }
  return wiped;
}

/** Imported rows can carry an author but no entity id; those are gone once the author is. */
async function goneAuthorCaseIds(
  main: Kysely<MainDB>,
  refs: readonly { caseId: number; authorId: number }[]
): Promise<number[]> {
  const byAuthor = new Map<number, number[]>();
  for (const ref of refs)
    byAuthor.set(ref.authorId, [...(byAuthor.get(ref.authorId) ?? []), ref.caseId]);
  const gone: number[] = [];
  for (const batch of chunk([...byAuthor.keys()], SOURCE_BATCH)) {
    const { rows } = await sql<{ id: number; gone: boolean }>`
      SELECT id, "deletedAt" IS NOT NULL AS gone FROM "User" WHERE id IN (${sql.join(batch)})
    `.execute(main);
    const live = new Set(rows.filter((r) => !r.gone).map((r) => Number(r.id)));
    for (const id of batch) if (!live.has(id)) gone.push(...(byAuthor.get(id) ?? []));
  }
  return gone;
}

export async function purgeDeletedSources(
  db: Kysely<ModeratorDB>,
  main: Kysely<MainDB>
): Promise<{ checked: number; wiped: number }> {
  const cases = await db
    .selectFrom('text_scan_test_case')
    .select(['id', 'entity_type', 'entity_id', 'author_id'])
    .where((eb) => eb.or([eb('entity_id', 'is not', null), eb('author_id', 'is not', null)]))
    .where('fields', 'is not', null)
    .execute();
  const refs = cases.flatMap((c) =>
    c.entity_id !== null
      ? [
          {
            caseId: Number(c.id),
            entityType: c.entity_type as LabEntityType,
            entityId: c.entity_id,
          },
        ]
      : []
  );
  const authorOnly = cases.flatMap((c) =>
    c.entity_id === null && c.author_id !== null
      ? [{ caseId: Number(c.id), authorId: c.author_id }]
      : []
  );
  const gone = [...(await goneCaseIds(main, refs)), ...(await goneAuthorCaseIds(main, authorOnly))];
  const wiped = await wipeCases(db, gone);
  // Swept for every wiped case, not only those wiped now: a run can write a verdict while its case is wiped.
  await db
    .updateTable('text_scan_test_result')
    .set({ output: null })
    .where('output', 'is not', null)
    .where(
      'case_id',
      'in',
      db.selectFrom('text_scan_test_case').select('id').where('source_deleted_at', 'is not', null)
    )
    .execute();
  return { checked: refs.length + authorOnly.length, wiped };
}

/** Draft results past `expires_at` go; the run row and its cached totals stay, as do all baselines. */
export async function expireDraftResults(
  db: Kysely<ModeratorDB>
): Promise<{ runs: number; results: number }> {
  const expired = await db
    .selectFrom('text_scan_test_run as r')
    .select('r.id')
    .where('r.kind', '=', 'draft')
    .where('r.expires_at', '<', sql<Date>`now()`)
    .where(({ exists, selectFrom }) =>
      exists(
        selectFrom('text_scan_test_result as x')
          .select('x.case_id')
          .whereRef('x.run_id', '=', 'r.id')
      )
    )
    .execute();
  if (!expired.length) return { runs: 0, results: 0 };
  const res = await db
    .deleteFrom('text_scan_test_result')
    .where(
      'run_id',
      'in',
      expired.map((r) => r.id)
    )
    .executeTakeFirst();
  return { runs: expired.length, results: Number(res.numDeletedRows) };
}
