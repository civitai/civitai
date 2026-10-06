import { sql, type Selectable } from 'kysely';
import { getModeratorDb } from '../moderator-db';
import type { text_scan_test_case } from '../moderator-db/types';
import { LabError } from './errors';
import { composeEntities } from './harness-client';
import { hashLabText } from './text-hash';
import { normaliseLabFields } from '$lib/text-scan-lab/compose';
import { InvalidExpectedError, parseExpected } from '$lib/text-scan-lab/expected';
import {
  LAB_ENTITY_TYPES,
  LAB_LABELS,
  type Expected,
  type LabEntityType,
  type LabField,
} from '$lib/text-scan-lab/types';

/** Ids composed per "Add entities" request (sequential harness calls). */
export const MAX_ADD_ENTITIES = 200;

export class TestSetError extends LabError {}

export type TestSetRun = {
  version: string;
  status: string;
  startedAt: Date;
};
export type TestSet = {
  id: number;
  name: string;
  description: string | null;
  createdBy: number;
  createdAt: Date;
  archivedAt: Date | null;
};
export type TestSetSummary = TestSet & { caseCount: number; lastRuns: TestSetRun[] };

export type TestCase = {
  id: number;
  setId: number;
  entityType: LabEntityType;
  entityId: number | null;
  authorId: number | null;
  fields: LabField[] | null;
  textHash: string;
  expected: Expected;
  synthetic: boolean;
  note: string | null;
  sourceDeletedAt: Date | null;
  addedBy: number;
  addedAt: Date;
  updatedAt: Date;
};

export type NewCase = {
  setId: number;
  entityType: LabEntityType;
  /** Null for free text, which is always a new case. */
  entityId: number | null;
  authorId: number | null;
  fields: LabField[];
  expected: unknown;
  synthetic: boolean;
  note: string | null;
};

const toSet = (r: {
  id: string;
  name: string;
  description: string | null;
  created_by: number;
  created_at: Date | string;
  archived_at: Date | string | null;
}): TestSet => ({
  id: Number(r.id),
  name: r.name,
  description: r.description,
  createdBy: r.created_by,
  createdAt: new Date(r.created_at),
  archivedAt: r.archived_at ? new Date(r.archived_at) : null,
});

const toCase = (r: Selectable<text_scan_test_case>): TestCase => ({
  id: Number(r.id),
  setId: Number(r.set_id),
  entityType: r.entity_type as LabEntityType,
  entityId: r.entity_id,
  authorId: r.author_id,
  fields: (r.fields as LabField[] | null) ?? null,
  textHash: r.text_hash,
  expected: (r.expected ?? {}) as Expected,
  synthetic: r.synthetic,
  note: r.note,
  sourceDeletedAt: r.source_deleted_at ? new Date(r.source_deleted_at) : null,
  addedBy: r.added_by,
  addedAt: new Date(r.added_at),
  updatedAt: new Date(r.updated_at),
});

function validExpected(json: unknown, entityType: LabEntityType): Expected {
  try {
    return parseExpected(json, LAB_LABELS[entityType]);
  } catch (e) {
    if (e instanceof InvalidExpectedError) throw new TestSetError(e.message, 400);
    throw e;
  }
}

const isUniqueViolation = (e: unknown) =>
  typeof e === 'object' && e !== null && (e as { code?: unknown }).code === '23505';

export async function listSets({ includeArchived = false } = {}): Promise<TestSetSummary[]> {
  const db = getModeratorDb();
  let q = db
    .selectFrom('text_scan_test_set as s')
    .selectAll('s')
    .select((eb) =>
      eb
        .selectFrom('text_scan_test_case as c')
        .whereRef('c.set_id', '=', 's.id')
        .select(eb.fn.countAll<string>().as('n'))
        .as('case_count')
    )
    .orderBy('s.archived_at', (ob) => ob.desc().nullsFirst())
    .orderBy('s.name');
  if (!includeArchived) q = q.where('s.archived_at', 'is', null);
  const sets = await q.execute();
  if (!sets.length) return [];

  const runs = await db
    .selectFrom('text_scan_test_run')
    .distinctOn(['set_id', 'version'])
    .select(['set_id', 'version', 'status', 'started_at'])
    .where(
      'set_id',
      'in',
      sets.map((s) => s.id)
    )
    .orderBy('set_id')
    .orderBy('version')
    .orderBy('started_at', 'desc')
    .execute();

  return sets.map((s) => ({
    ...toSet(s),
    caseCount: Number(s.case_count ?? 0),
    lastRuns: runs
      .filter((r) => r.set_id === s.id)
      .map((r) => ({
        version: r.version,
        status: r.status,
        startedAt: new Date(r.started_at),
      }))
      // Active first, then drafts newest-run first.
      .sort((a, b) =>
        a.version === 'active'
          ? -1
          : b.version === 'active'
          ? 1
          : b.startedAt.getTime() - a.startedAt.getTime()
      ),
  }));
}

export async function getSet(id: number): Promise<TestSet | null> {
  const row = await getModeratorDb()
    .selectFrom('text_scan_test_set')
    .selectAll()
    .where('id', '=', String(id))
    .executeTakeFirst();
  return row ? toSet(row) : null;
}

export async function createSet(
  input: { name: string; description: string | null },
  userId: number
): Promise<TestSet> {
  try {
    const row = await getModeratorDb()
      .insertInto('text_scan_test_set')
      .values({ name: input.name, description: input.description, created_by: userId })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toSet(row);
  } catch (e) {
    if (isUniqueViolation(e))
      throw new TestSetError(`A test set named "${input.name}" already exists.`, 409);
    throw e;
  }
}

export async function archiveSet(id: number): Promise<void> {
  const res = await getModeratorDb()
    .updateTable('text_scan_test_set')
    .set({ archived_at: sql`now()` })
    .where('id', '=', String(id))
    .where('archived_at', 'is', null)
    .executeTakeFirst();
  if (!res.numUpdatedRows)
    throw new TestSetError(`Test set ${id} not found or already archived.`, 404);
}

export async function listCases(setId: number): Promise<TestCase[]> {
  const rows = await getModeratorDb()
    .selectFrom('text_scan_test_case')
    .selectAll()
    .where('set_id', '=', String(setId))
    .orderBy('id')
    .execute();
  return rows.map(toCase);
}

const caseNotFound = (caseId: number) =>
  new TestSetError(`Test case ${caseId} not found in this set.`, 404);

async function requireOpenSet(setId: number): Promise<TestSet> {
  const set = await getSet(setId);
  if (!set) throw new TestSetError(`Test set ${setId} not found.`, 404);
  if (set.archivedAt) throw new TestSetError(`Test set "${set.name}" is archived.`, 409);
  return set;
}

async function insertCase(
  input: NewCase,
  userId: number,
  { keepExpectation = false } = {}
): Promise<{ case: TestCase; created: boolean }> {
  if (!(LAB_ENTITY_TYPES as readonly string[]).includes(input.entityType))
    throw new TestSetError(`Unknown entity type ${input.entityType}.`, 400);
  const fields = normaliseLabFields(input.fields);
  if (typeof fields === 'string') throw new TestSetError(fields, 400);
  if (!fields.length) throw new TestSetError('A test case needs some text.', 400);
  const expected = validExpected(input.expected, input.entityType);
  const textHash = hashLabText(fields);

  const values = {
    set_id: String(input.setId),
    entity_type: input.entityType,
    entity_id: input.entityId,
    author_id: input.authorId,
    fields: JSON.stringify(fields),
    text_hash: textHash,
    expected: JSON.stringify(expected),
    synthetic: input.synthetic,
    note: input.note,
    added_by: userId,
  };
  let q = getModeratorDb().insertInto('text_scan_test_case').values(values);
  // A null entity_id never conflicts (NULLs are distinct), so free text always inserts.
  if (input.entityId !== null)
    q = q.onConflict((oc) =>
      oc.columns(['set_id', 'entity_type', 'entity_id']).doUpdateSet({
        author_id: values.author_id,
        fields: values.fields,
        text_hash: values.text_hash,
        synthetic: values.synthetic,
        ...(keepExpectation ? {} : { expected: values.expected, note: values.note }),
        source_deleted_at: null,
        updated_at: sql`now()`,
      })
    );
  const row = await q
    .returningAll()
    // xmax is 0 only on a freshly inserted row version.
    .returning(sql<boolean>`(xmax = 0)`.as('inserted'))
    .executeTakeFirstOrThrow();
  return { case: toCase(row), created: row.inserted };
}

export async function addCase(input: NewCase, userId: number) {
  await requireOpenSet(input.setId);
  return insertCase(input, userId);
}

/** Case ids are scoped to the set the page shows, so a stale or edited form cannot reach another set. */
export async function updateExpected(
  setId: number,
  caseId: number,
  expectedJson: unknown,
  note: string | null
): Promise<TestCase> {
  await requireOpenSet(setId);
  const db = getModeratorDb();
  const existing = await db
    .selectFrom('text_scan_test_case')
    .select('entity_type')
    .where('id', '=', String(caseId))
    .where('set_id', '=', String(setId))
    .executeTakeFirst();
  if (!existing) throw caseNotFound(caseId);
  const expected = validExpected(expectedJson, existing.entity_type as LabEntityType);
  const row = await db
    .updateTable('text_scan_test_case')
    .set({ expected: JSON.stringify(expected), note, updated_at: sql`now()` })
    .where('id', '=', String(caseId))
    .where('set_id', '=', String(setId))
    .returningAll()
    .executeTakeFirst();
  if (!row) throw caseNotFound(caseId);
  return toCase(row);
}

/** Its results go with it (ON DELETE CASCADE). */
export async function removeCase(setId: number, caseId: number): Promise<void> {
  await requireOpenSet(setId);
  const res = await getModeratorDb()
    .deleteFrom('text_scan_test_case')
    .where('id', '=', String(caseId))
    .where('set_id', '=', String(setId))
    .executeTakeFirst();
  if (!res.numDeletedRows) throw caseNotFound(caseId);
}

/** A case already in the set gets the fresh text and keeps its expectation and note. Ids the harness
 *  can't compose come back in `skipped`. */
export async function addEntities(
  setId: number,
  entityType: LabEntityType,
  ids: number[],
  userId: number
): Promise<{ added: number; updated: number; skipped: { entityId: number; error: string }[] }> {
  if (ids.length > MAX_ADD_ENTITIES)
    throw new TestSetError(
      `${ids.length} ids exceeds the limit of ${MAX_ADD_ENTITIES} per request.`,
      400
    );
  await requireOpenSet(setId);
  const composed = await composeEntities(entityType, ids);
  let added = 0;
  let updated = 0;
  const skipped: { entityId: number; error: string }[] = [];
  for (const c of composed) {
    if (!c.ok) {
      skipped.push({ entityId: c.entityId, error: c.error });
      continue;
    }
    const { created } = await insertCase(
      {
        setId,
        entityType,
        entityId: c.entityId,
        authorId: c.userId,
        fields: c.fields,
        expected: {},
        synthetic: false,
        note: null,
      },
      userId,
      { keepExpectation: true }
    );
    if (created) added++;
    else updated++;
  }
  return { added, updated, skipped };
}
