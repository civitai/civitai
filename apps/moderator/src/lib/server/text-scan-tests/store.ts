import { sql, type Kysely, type Selectable } from 'kysely';
import type {
  DB as ModeratorDB,
  text_scan_test_case,
  text_scan_test_set,
} from '../moderator-db/types';
import { normaliseLabFields } from '../../text-scan-lab/compose';
import { LAB_ENTITY_TYPES, type LabEntityType, type LabField } from '../../text-scan-lab/types';
import { parseExpected, workspaceOf, type Expected } from '../../text-scan-tests/expected';
import {
  WORKSPACE_NAMES,
  type CaseOrigin,
  type TestCase,
  type TestSet,
  type Workspace,
} from '../../text-scan-tests/types';
import { hashLabFields } from './text-hash';

export class TestSetError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'TestSetError';
  }
}

type Db = Kysely<ModeratorDB>;

export const toTestSet = (r: Selectable<text_scan_test_set>): TestSet => ({
  id: Number(r.id),
  name: r.name,
  description: r.description,
  workspace: r.workspace as Workspace,
  createdBy: r.created_by,
  createdAt: new Date(r.created_at),
  archivedAt: r.archived_at ? new Date(r.archived_at) : null,
});

export const toTestCase = (r: Selectable<text_scan_test_case>): TestCase => ({
  id: Number(r.id),
  setId: Number(r.set_id),
  entityType: r.entity_type as LabEntityType,
  entityId: r.entity_id,
  authorId: r.author_id,
  sourceRef: r.source_ref,
  fields: (r.fields as LabField[] | null) ?? null,
  textHash: r.text_hash,
  expected: (r.expected ?? {}) as Expected,
  note: r.note,
  origin: r.origin as CaseOrigin,
  sourceDeletedAt: r.source_deleted_at ? new Date(r.source_deleted_at) : null,
  addedBy: r.added_by,
  addedAt: new Date(r.added_at),
  updatedBy: r.updated_by,
  updatedAt: new Date(r.updated_at),
});

const isUniqueViolation = (e: unknown) =>
  typeof e === 'object' && e !== null && (e as { code?: unknown }).code === '23505';

export async function createSet(
  db: Db,
  input: { name: string; description: string | null; workspace: Workspace },
  userId: number
): Promise<TestSet> {
  try {
    const row = await db
      .insertInto('text_scan_test_set')
      .values({ ...input, created_by: userId })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toTestSet(row);
  } catch (e) {
    if (isUniqueViolation(e))
      throw new TestSetError(`A test set named "${input.name}" already exists.`, 409);
    throw e;
  }
}

export async function getSet(db: Db, id: number): Promise<TestSet | null> {
  const row = await db
    .selectFrom('text_scan_test_set')
    .selectAll()
    .where('id', '=', String(id))
    .executeTakeFirst();
  return row ? toTestSet(row) : null;
}

export async function requireOpenSet(db: Db, id: number, workspace?: Workspace): Promise<TestSet> {
  const set = await getSet(db, id);
  if (!set) throw new TestSetError(`Test set ${id} not found.`, 404);
  if (set.archivedAt) throw new TestSetError(`Test set "${set.name}" is archived.`, 409);
  if (workspace && set.workspace !== workspace)
    throw new TestSetError(`Test set "${set.name}" belongs to the other workspace.`, 409);
  return set;
}

export async function listSets(
  db: Db,
  workspace: Workspace
): Promise<(TestSet & { caseCount: number })[]> {
  const rows = await db
    .selectFrom('text_scan_test_set as s')
    .selectAll('s')
    .select((eb) =>
      eb
        .selectFrom('text_scan_test_case as c')
        .whereRef('c.set_id', '=', 's.id')
        .select(eb.fn.countAll<string>().as('n'))
        .as('case_count')
    )
    .where('s.workspace', '=', workspace)
    .where('s.archived_at', 'is', null)
    .orderBy('s.name')
    .execute();
  return rows.map((r) => ({ ...toTestSet(r), caseCount: Number(r.case_count ?? 0) }));
}

export async function archiveSet(db: Db, id: number): Promise<void> {
  const res = await db
    .updateTable('text_scan_test_set')
    .set({ archived_at: sql`now()` })
    .where('id', '=', String(id))
    .where('archived_at', 'is', null)
    .executeTakeFirst();
  if (!res.numUpdatedRows)
    throw new TestSetError(`Test set ${id} not found or already archived.`, 404);
}

export type CaseInput = {
  setId: number;
  entityType: LabEntityType;
  entityId: number | null;
  authorId: number | null;
  sourceRef: string | null;
  fields: readonly { heading: string; text?: string | null }[];
  expected: unknown;
  note: string | null;
  origin: CaseOrigin;
};

function validCase(input: CaseInput) {
  if (!(LAB_ENTITY_TYPES as readonly string[]).includes(input.entityType))
    throw new TestSetError(`Unknown entity type ${input.entityType}.`, 400);
  const fields = normaliseLabFields(input.fields);
  if (typeof fields === 'string') throw new TestSetError(fields, 400);
  if (!fields.length) throw new TestSetError('A test case needs some text.', 400);
  const expected = parseExpected(input.expected, input.entityType);
  if (typeof expected === 'string') throw new TestSetError(expected, 400);
  return { fields, expected };
}

/** Upserts on the entity, else the source ref, else the text hash of a free text in this set. */
export async function upsertCase(
  db: Db,
  input: CaseInput,
  userId: number
): Promise<{ case: TestCase; created: boolean }> {
  const set = await requireOpenSet(db, input.setId);
  const { fields, expected } = validCase(input);
  if (workspaceOf(input.entityType) !== set.workspace)
    throw new TestSetError(
      `Test set "${set.name}" belongs to ${WORKSPACE_NAMES[set.workspace]}, which does not score ${
        input.entityType
      } cases.`,
      400
    );
  const values = {
    set_id: String(input.setId),
    entity_type: input.entityType,
    entity_id: input.entityId,
    author_id: input.authorId,
    source_ref: input.sourceRef,
    fields: JSON.stringify(fields),
    text_hash: hashLabFields(fields),
    expected: JSON.stringify(expected),
    note: input.note,
    origin: input.origin,
    added_by: userId,
    updated_by: userId,
  };
  const refresh = {
    author_id: values.author_id,
    fields: values.fields,
    text_hash: values.text_hash,
    expected: values.expected,
    note: values.note,
    source_deleted_at: null,
    updated_by: userId,
    updated_at: sql<Date>`now()`,
  };

  const q = db
    .insertInto('text_scan_test_case')
    .values(values)
    .onConflict((oc) =>
      input.entityId !== null
        ? oc.columns(['set_id', 'entity_type', 'entity_id']).doUpdateSet(refresh)
        : input.sourceRef !== null
        ? oc.columns(['set_id', 'source_ref']).doUpdateSet(refresh)
        : oc
            // The predicate must repeat text_scan_test_case_free_text_key's WHERE, or Postgres finds no index.
            .columns(['set_id', 'entity_type', 'text_hash'])
            .where('entity_id', 'is', null)
            .where('source_ref', 'is', null)
            .doUpdateSet(refresh)
    );
  try {
    const row = await q
      .returningAll()
      // xmax is 0 only on a freshly inserted row version.
      .returning(sql<boolean>`(xmax = 0)`.as('inserted'))
      .executeTakeFirstOrThrow();
    return { case: toTestCase(row), created: row.inserted };
  } catch (e) {
    if (isUniqueViolation(e))
      throw new TestSetError('Another case in this set already uses that entity or source.', 409);
    throw e;
  }
}

export async function listCases(db: Db, setId: number): Promise<TestCase[]> {
  const rows = await db
    .selectFrom('text_scan_test_case')
    .selectAll()
    .where('set_id', '=', String(setId))
    .orderBy('id')
    .execute();
  return rows.map(toTestCase);
}

const caseNotFound = (caseId: number) =>
  new TestSetError(`Test case ${caseId} not found in this set.`, 404);

export async function updateExpectation(
  db: Db,
  setId: number,
  caseId: number,
  expectedJson: unknown,
  note: string | null,
  userId: number
): Promise<TestCase> {
  await requireOpenSet(db, setId);
  const existing = await db
    .selectFrom('text_scan_test_case')
    .select('entity_type')
    .where('id', '=', String(caseId))
    .where('set_id', '=', String(setId))
    .executeTakeFirst();
  if (!existing) throw caseNotFound(caseId);
  const expected = parseExpected(expectedJson, existing.entity_type as LabEntityType);
  if (typeof expected === 'string') throw new TestSetError(expected, 400);
  const row = await db
    .updateTable('text_scan_test_case')
    .set({ expected: JSON.stringify(expected), note, updated_by: userId, updated_at: sql`now()` })
    .where('id', '=', String(caseId))
    .where('set_id', '=', String(setId))
    .returningAll()
    .executeTakeFirst();
  if (!row) throw caseNotFound(caseId);
  return toTestCase(row);
}

/** Its results go with it (ON DELETE CASCADE). */
export async function removeCase(db: Db, setId: number, caseId: number): Promise<void> {
  await requireOpenSet(db, setId);
  const res = await db
    .deleteFrom('text_scan_test_case')
    .where('id', '=', String(caseId))
    .where('set_id', '=', String(setId))
    .executeTakeFirst();
  if (!res.numDeletedRows) throw caseNotFound(caseId);
}
