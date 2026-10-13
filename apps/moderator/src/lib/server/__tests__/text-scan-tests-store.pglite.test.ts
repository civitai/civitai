import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DB as ModeratorDB } from '../moderator-db/types';
import {
  TestSetError,
  archiveSet,
  createSet,
  listCases,
  listSets,
  removeCase,
  updateExpectation,
  upsertCase,
  type CaseInput,
} from '../text-scan-tests/store';
import { MOD, TEST_SETS_SCHEMA, freshTestSetsDb } from './text-scan-tests-pglite.harness';

let pg: PGlite;
let db: Kysely<ModeratorDB>;

beforeEach(async () => {
  ({ pg, db } = await freshTestSetsDb());
});

const input = (setId: number, over: Partial<CaseInput> = {}): CaseInput => ({
  setId,
  entityType: 'CommentV2',
  entityId: 71,
  authorId: 5,
  sourceRef: null,
  fields: [{ heading: 'Comment', text: 'synthetic text one' }],
  expected: { scam: true },
  note: null,
  origin: 'try',
  ...over,
});

const newSet = (name = 'synthetic set', workspace: 'prompts' | 'modelRules' = 'prompts') =>
  createSet(db, { name, description: null, workspace }, MOD);

describe('the schema', () => {
  it('is re-runnable', async () => {
    await expect(pg.exec(TEST_SETS_SCHEMA)).resolves.toBeDefined();
  });

  it('refuses a case with neither text nor a deletion mark', async () => {
    const set = await newSet();
    await expect(
      pg.query(
        `INSERT INTO text_scan_test_case (set_id, entity_type, text_hash, origin, added_by, updated_by)
         VALUES ($1, 'CommentV2', 'h', 'try', 1, 1)`,
        [set.id]
      )
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('sets', () => {
  it('refuses a second set with the same name', async () => {
    await newSet();
    await expect(newSet()).rejects.toMatchObject({ status: 409 });
  });

  it('lists only open sets of the workspace, with their case counts', async () => {
    const a = await newSet('a');
    await newSet('b', 'modelRules');
    const c = await newSet('c');
    await upsertCase(db, input(a.id), MOD);
    await archiveSet(db, c.id);
    expect(await listSets(db, 'prompts')).toEqual([
      expect.objectContaining({ id: a.id, name: 'a', caseCount: 1 }),
    ]);
  });

  it('refuses to archive a set twice', async () => {
    const set = await newSet();
    await archiveSet(db, set.id);
    await expect(archiveSet(db, set.id)).rejects.toMatchObject({ status: 404 });
  });
});

describe('upsertCase', () => {
  it('re-adding the same entity updates its expectation and keeps the case id', async () => {
    const set = await newSet();
    const first = await upsertCase(db, input(set.id), MOD);
    const again = await upsertCase(db, input(set.id, { expected: { scam: false } }), MOD);
    expect(first.created).toBe(true);
    expect(again).toMatchObject({
      created: false,
      case: { id: first.case.id, expected: { scam: false } },
    });
    expect(await listCases(db, set.id)).toHaveLength(1);
  });

  it('dedupes a re-captured free text by its hash', async () => {
    const set = await newSet();
    const free = { entityId: null, authorId: null };
    const first = await upsertCase(db, input(set.id, free), MOD);
    const again = await upsertCase(db, input(set.id, { ...free, note: 'second look' }), MOD);
    expect(again.case.id).toBe(first.case.id);
    expect(again.case.note).toBe('second look');
  });

  it('upserts an imported row on its source ref', async () => {
    const set = await newSet();
    const row = { entityId: null, authorId: null, sourceRef: 'k-1', origin: 'import' as const };
    const first = await upsertCase(db, input(set.id, row), MOD);
    const again = await upsertCase(
      db,
      input(set.id, { ...row, fields: [{ heading: 'Comment', text: 'synthetic text two' }] }),
      MOD
    );
    expect(again.case.id).toBe(first.case.id);
    expect(again.case.fields?.[0].text).toBe('synthetic text two');
  });

  it('refuses an expectation the entity type does not score', async () => {
    const set = await newSet();
    await expect(
      upsertCase(db, input(set.id, { expected: { nsfw: { min: 'r', max: 'r' } } }), MOD)
    ).rejects.toMatchObject({
      status: 400,
      message: 'CommentV2 cases score scam, not nsfw.',
    });
  });

  it('refuses a case with no text', async () => {
    const set = await newSet();
    await expect(
      upsertCase(db, input(set.id, { fields: [{ heading: 'Comment', text: '   ' }] }), MOD)
    ).rejects.toMatchObject({ status: 400 });
  });

  it('refuses a case for an archived set', async () => {
    const set = await newSet();
    await archiveSet(db, set.id);
    await expect(upsertCase(db, input(set.id), MOD)).rejects.toMatchObject({ status: 409 });
  });

  it('clears a deletion mark when the entity is captured again', async () => {
    const set = await newSet();
    const first = await upsertCase(db, input(set.id), MOD);
    await db
      .updateTable('text_scan_test_case')
      .set({ fields: null, source_deleted_at: new Date() })
      .where('id', '=', String(first.case.id))
      .execute();
    const again = await upsertCase(db, input(set.id), MOD);
    expect(again.case).toMatchObject({ sourceDeletedAt: null, fields: [{ heading: 'Comment' }] });
  });
});

describe('updateExpectation and removeCase', () => {
  it('cannot reach a case through another set', async () => {
    const a = await newSet('a');
    const b = await newSet('b');
    const { case: c } = await upsertCase(db, input(a.id), MOD);
    await expect(
      updateExpectation(db, b.id, c.id, { scam: false }, null, MOD)
    ).rejects.toMatchObject({ status: 404 });
    await expect(removeCase(db, b.id, c.id)).rejects.toMatchObject({ status: 404 });
  });

  it('relabels a case and records who did it', async () => {
    const set = await newSet();
    const { case: c } = await upsertCase(db, input(set.id), MOD);
    const updated = await updateExpectation(db, set.id, c.id, { scam: false }, 'looked again', 42);
    expect(updated).toMatchObject({
      expected: { scam: false },
      note: 'looked again',
      updatedBy: 42,
    });
  });

  it('throws TestSetError, which the routes map to fail()', async () => {
    const set = await newSet();
    await expect(removeCase(db, set.id, 999)).rejects.toBeInstanceOf(TestSetError);
  });
});
