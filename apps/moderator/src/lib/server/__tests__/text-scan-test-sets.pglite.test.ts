import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The test-set service over the REAL `text-scan-lab/schema.sql`. Whether a re-added entity updates or
 * duplicates is decided by the table's UNIQUE (set_id, entity_type, entity_id), and free text has a null
 * entity_id, which that constraint never matches — only a real table can say both.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(join(HERE, '../../../../text-scan-lab/schema.sql'), 'utf8');

const holder = vi.hoisted(() => ({ pg: null as PGlite | null }));

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$app/server', () => ({ getRequestEvent: vi.fn() }));
vi.mock('../moderator-db', async () => {
  const { Kysely } = await import('kysely');
  const { pgliteDialect } = await import('./abuse-detection-pglite.harness');
  let db: unknown;
  let bound: PGlite | null = null;
  return {
    getModeratorDb: () => {
      if (bound !== holder.pg) {
        bound = holder.pg;
        db = new Kysely({ dialect: pgliteDialect(holder.pg!) });
      }
      return db;
    },
  };
});

const harness = vi.hoisted(() => ({ composeEntities: vi.fn() }));
vi.mock('../text-scan-lab/harness-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../text-scan-lab/harness-client')>()),
  composeEntities: harness.composeEntities,
}));

const {
  TestSetError,
  addCase,
  addEntities,
  archiveSet,
  createSet,
  listCases,
  listSets,
  removeCase,
  updateExpected,
} = await import('../text-scan-lab/test-sets.service');

const MOD = 990001;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

beforeEach(async () => {
  vi.clearAllMocks();
  holder.pg = await PGlite.create();
  await holder.pg.exec(SCHEMA);
});

const newSet = (name = 'calibration') => createSet({ name, description: null }, MOD);
const modelCase = (setId: number, text: string, expected = {}) =>
  addCase(
    {
      setId,
      entityType: 'Model',
      entityId: 42,
      authorId: 7,
      fields: [{ heading: 'Name', text }],
      expected,
      synthetic: false,
      note: null,
    },
    MOD
  );
const freeTextCase = (setId: number, text: string) =>
  addCase(
    {
      setId,
      entityType: 'Comment',
      entityId: null,
      authorId: null,
      fields: [{ heading: 'Comment', text }],
      expected: { scam: true },
      synthetic: true,
      note: null,
    },
    MOD
  );

describe('addCase', () => {
  it('updates the existing case when the same entity is added twice', async () => {
    const set = await newSet();
    const first = await modelCase(set.id, 'first text');
    expect(first.created).toBe(true);
    const second = await modelCase(set.id, 'second text', { nsfw: { min: 'r', max: 'x' } });
    expect(second.created).toBe(false);
    expect(second.case.id).toBe(first.case.id);

    const cases = await listCases(set.id);
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({
      entityId: 42,
      authorId: 7,
      fields: [{ heading: 'Name', text: 'second text' }],
      expected: { nsfw: { min: 'r', max: 'x' } },
      textHash: sha256('## Name\nsecond text'),
    });
  });

  it('always inserts a free-text case', async () => {
    const set = await newSet();
    await freeTextCase(set.id, 'buy followers');
    await freeTextCase(set.id, 'buy followers');
    const cases = await listCases(set.id);
    expect(cases).toHaveLength(2);
    expect(cases.every((c) => c.entityId === null && c.synthetic)).toBe(true);
  });

  it('refuses an expectation for a label the entity type does not scan', async () => {
    const set = await newSet();
    await expect(modelCase(set.id, 'text', { scam: true })).rejects.toThrow(/scam/);
    expect(await listCases(set.id)).toEqual([]);
  });

  it('refuses a case with no text', async () => {
    const set = await newSet();
    await expect(modelCase(set.id, '   ')).rejects.toThrow(TestSetError);
  });

  it('refuses a case for an archived set', async () => {
    const set = await newSet();
    await archiveSet(set.id);
    await expect(modelCase(set.id, 'text')).rejects.toThrow(/archived/);
  });
});

describe('removeCase', () => {
  it('removes the case and its results', async () => {
    const set = await newSet();
    const { case: c } = await modelCase(set.id, 'text');
    await holder.pg!.exec(`
      INSERT INTO text_scan_test_run (id, set_id, version, status, run_by) VALUES (1, ${set.id}, 'active', 'done', ${MOD});
      INSERT INTO text_scan_test_result (run_id, case_id, status) VALUES (1, ${c.id}, 'ok');
    `);
    await removeCase(set.id, c.id);
    expect(await listCases(set.id)).toEqual([]);
    const { rows } = await holder.pg!.query('SELECT count(*)::int AS n FROM text_scan_test_result');
    expect(rows).toEqual([{ n: 0 }]);
  });

  it('throws for a case that is missing or belongs to another set', async () => {
    const set = await newSet();
    const other = await newSet('other');
    const { case: c } = await modelCase(other.id, 'text');
    await expect(removeCase(set.id, 12345)).rejects.toThrow(TestSetError);
    await expect(removeCase(set.id, c.id)).rejects.toThrow(/not found in this set/);
    expect(await listCases(other.id)).toHaveLength(1);
  });
});

describe('updateExpected', () => {
  it('replaces the expectation and note', async () => {
    const set = await newSet();
    const { case: c } = await modelCase(set.id, 'text', { poi: true });
    await updateExpected(
      set.id,
      c.id,
      { nsfw: { min: 'none', max: 'pg13' }, minor: false },
      'checked'
    );
    const [saved] = await listCases(set.id);
    expect(saved).toMatchObject({
      expected: { nsfw: { min: 'none', max: 'pg13' }, minor: false },
      note: 'checked',
    });
  });

  it("validates against the case's own entity type", async () => {
    const set = await newSet();
    const { case: c } = await modelCase(set.id, 'text');
    await expect(updateExpected(set.id, c.id, { scam: true }, null)).rejects.toThrow(/scam/);
    await expect(
      updateExpected(set.id, c.id, { nsfw: { min: 'xxx', max: 'none' } }, null)
    ).rejects.toThrow(/min/);
  });
});

describe('addEntities', () => {
  it('adds composed entities with their author and reports the ones that were skipped', async () => {
    const set = await newSet();
    harness.composeEntities.mockResolvedValue([
      { entityId: 1, ok: true, fields: [{ heading: 'Name', text: 'one' }], text: '', userId: 11 },
      { entityId: 2, ok: false, error: 'not found' },
      { entityId: 3, ok: false, error: 'too short' },
    ]);
    const result = await addEntities(set.id, 'Model', [1, 2, 3], MOD);
    expect(harness.composeEntities).toHaveBeenCalledWith('Model', [1, 2, 3]);
    expect(result).toEqual({
      added: 1,
      updated: 0,
      skipped: [
        { entityId: 2, error: 'not found' },
        { entityId: 3, error: 'too short' },
      ],
    });
    const [c] = await listCases(set.id);
    expect(c).toMatchObject({ entityType: 'Model', entityId: 1, authorId: 11, expected: {} });
  });

  it('refreshes the text of an entity already in the set but keeps its expectation', async () => {
    const set = await newSet();
    await modelCase(set.id, 'old text', { poi: true });
    harness.composeEntities.mockResolvedValue([
      { entityId: 42, ok: true, fields: [{ heading: 'Name', text: 'new' }], text: '', userId: 7 },
    ]);
    expect(await addEntities(set.id, 'Model', [42], MOD)).toMatchObject({ added: 0, updated: 1 });
    const cases = await listCases(set.id);
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({
      fields: [{ heading: 'Name', text: 'new' }],
      expected: { poi: true },
    });
  });

  it('stores a composed entity whose optional field came back with null text', async () => {
    const set = await newSet();
    harness.composeEntities.mockResolvedValue([
      {
        entityId: 5,
        ok: true,
        fields: [
          { heading: 'Name', text: 'FAKE MODEL' },
          { heading: 'Description', text: null },
        ],
        text: '',
        userId: 11,
      },
    ]);
    expect(await addEntities(set.id, 'Model', [5], MOD)).toMatchObject({ added: 1 });
    const [c] = await listCases(set.id);
    expect(c).toMatchObject({
      fields: [{ heading: 'Name', text: 'FAKE MODEL' }],
      textHash: sha256('## Name\nFAKE MODEL'),
    });
  });

  it('does not compose for a missing set', async () => {
    await expect(addEntities(999, 'Model', [1], MOD)).rejects.toThrow(TestSetError);
    expect(harness.composeEntities).not.toHaveBeenCalled();
  });
});

describe('listSets', () => {
  it('counts cases and gives the latest run per version', async () => {
    const set = await newSet();
    await modelCase(set.id, 'a');
    await freeTextCase(set.id, 'b');
    await holder.pg!.exec(`
      INSERT INTO text_scan_test_run (set_id, version, status, run_by, started_at)
        VALUES (${set.id}, 'active', 'failed', ${MOD}, '2026-10-01'),
               (${set.id}, 'active', 'done', ${MOD}, '2026-10-03'),
               (${set.id}, '5', 'failed', ${MOD}, '2026-10-02');
    `);
    const [listed] = await listSets();
    expect(listed).toMatchObject({ id: set.id, name: 'calibration', caseCount: 2 });
    expect(listed.lastRuns.map((r) => [r.version, r.status])).toEqual([
      ['active', 'done'],
      ['5', 'failed'],
    ]);
  });

  it('hides archived sets unless asked', async () => {
    const set = await newSet();
    await archiveSet(set.id);
    expect(await listSets()).toEqual([]);
    expect((await listSets({ includeArchived: true })).map((s) => s.id)).toEqual([set.id]);
  });

  it('refuses a duplicate set name', async () => {
    await newSet();
    await expect(newSet()).rejects.toThrow(/already/);
  });
});
