import { sql, type ExpressionBuilder, type Kysely, type Selectable } from 'kysely';
import type {
  DB as ModeratorDB,
  text_scan_test_case,
  text_scan_test_run,
  text_scan_test_set,
} from '../moderator-db/types';
import { normaliseLabFields } from '../../text-scan-lab/compose';
import { LAB_ENTITY_TYPES, type LabEntityType, type LabField } from '../../text-scan-lab/types';
import { parseExpected, type Expected } from '../../text-scan-tests/expected';
import {
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
export type RunRow = Selectable<text_scan_test_run>;

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

export async function requireSet(db: Db, id: number): Promise<TestSet> {
  const set = await getSet(db, id);
  if (!set) throw new TestSetError(`Test set ${id} not found.`, 404);
  return set;
}

export async function requireOpenSet(db: Db, id: number, workspace?: Workspace): Promise<TestSet> {
  const set = await requireSet(db, id);
  if (set.archivedAt) throw new TestSetError(`Test set "${set.name}" is archived.`, 409);
  if (workspace && set.workspace !== workspace)
    throw new TestSetError(`Test set "${set.name}" belongs to the other workspace.`, 409);
  return set;
}

export async function getRun(db: Db, setId: number, runId: number): Promise<RunRow> {
  const row = await db
    .selectFrom('text_scan_test_run')
    .selectAll()
    .where('id', '=', String(runId))
    .where('set_id', '=', String(setId))
    .executeTakeFirst();
  if (!row) throw new TestSetError(`Run ${runId} not found in this set.`, 404);
  return row;
}

const setCases = (db: Db, setId: number | string) =>
  db.selectFrom('text_scan_test_case as c').where('c.set_id', '=', String(setId));

/** Cases that still have their text: a wiped case is never scanned. */
export const runnableCases = (db: Db, setId: number | string) =>
  setCases(db, setId).where('c.fields', 'is not', null);

export const wipedCases = (db: Db, setId: number | string) =>
  setCases(db, setId).where('c.fields', 'is', null);

/** For a `text_scan_test_case as c` query: the case has no result row in this run. */
export const noResultIn =
  (runId: number | string) =>
  ({ not, exists, selectFrom }: ExpressionBuilder<ModeratorDB & { c: text_scan_test_case }, 'c'>) =>
    not(
      exists(
        selectFrom('text_scan_test_result as r')
          .select('r.case_id')
          .whereRef('r.case_id', '=', 'c.id')
          .where('r.run_id', '=', String(runId))
      )
    );

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

/**
 * Upserts on the entity, else the source ref, else the text hash of a free text in this set.
 * `rescore`: an existing case changed text or expectation, so the set's cached totals are stale.
 */
export async function upsertCase(
  db: Db,
  input: CaseInput,
  userId: number
): Promise<{ case: TestCase; created: boolean; rescore: boolean }> {
  await requireOpenSet(db, input.setId);
  const { fields, expected } = validCase(input);
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
    note: sql<string | null>`coalesce(excluded.note, text_scan_test_case.note)`,
    source_deleted_at: null,
    updated_by: userId,
    updated_at: sql<Date>`now()`,
  };

  const write = async (trx: Db) => {
    const prior = await trx
      .selectFrom('text_scan_test_case')
      .select(['text_hash', 'expected'])
      .where('set_id', '=', values.set_id)
      .where((eb) =>
        input.entityId !== null
          ? eb.and([eb('entity_type', '=', input.entityType), eb('entity_id', '=', input.entityId)])
          : input.sourceRef !== null
          ? eb('source_ref', '=', input.sourceRef)
          : eb.and([
              eb('entity_type', '=', input.entityType),
              eb('text_hash', '=', values.text_hash),
              eb('entity_id', 'is', null),
              eb('source_ref', 'is', null),
            ])
      )
      .forUpdate()
      .executeTakeFirst();
    const row = await trx
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
      )
      .returningAll()
      // xmax is 0 only on a freshly inserted row version.
      .returning(sql<boolean>`(xmax = 0)`.as('inserted'))
      .executeTakeFirstOrThrow();
    const textChanged = !!prior && prior.text_hash !== row.text_hash;
    // A verdict on the old text would pass for the new one: drop it so the baseline tops it up.
    if (textChanged)
      await trx
        .deleteFrom('text_scan_test_result')
        .where('case_id', '=', row.id)
        .where(
          'run_id',
          'in',
          trx
            .selectFrom('text_scan_test_run')
            .select('id')
            .where('set_id', '=', values.set_id)
            .where((eb) =>
              eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', sql<Date>`now()`)])
            )
        )
        .execute();
    return {
      case: toTestCase(row),
      created: row.inserted,
      rescore:
        !!prior && (textChanged || JSON.stringify(prior.expected) !== JSON.stringify(row.expected)),
    };
  };
  try {
    return db.isTransaction ? await write(db) : await db.transaction().execute(write);
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

export async function getCase(db: Db, setId: number, caseId: number): Promise<TestCase | null> {
  const row = await db
    .selectFrom('text_scan_test_case')
    .selectAll()
    .where('set_id', '=', String(setId))
    .where('id', '=', String(caseId))
    .executeTakeFirst();
  return row ? toTestCase(row) : null;
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

export async function removeCase(db: Db, setId: number, caseId: number): Promise<void> {
  await requireOpenSet(db, setId);
  const res = await db
    .deleteFrom('text_scan_test_case')
    .where('id', '=', String(caseId))
    .where('set_id', '=', String(setId))
    .executeTakeFirst();
  if (!res.numDeletedRows) throw caseNotFound(caseId);
}
