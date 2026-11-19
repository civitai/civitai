import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { studioWithheldWorkflowIdsSql } from '~/server/services/orchestrator/training/studio-withheld';

const OWNER = 1;
const OTHER = 2;
const MOD = 99;

let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "Model" (
      id int PRIMARY KEY, "userId" int NOT NULL, status text NOT NULL, mode text,
      "deletedBy" int, meta jsonb NOT NULL DEFAULT '{}'
    );
    CREATE TABLE "ModelVersion" (id int PRIMARY KEY, "modelId" int NOT NULL, meta jsonb NOT NULL DEFAULT '{}');
    CREATE TABLE "ModelFile" (
      id serial PRIMARY KEY, "modelVersionId" int NOT NULL, type text NOT NULL, metadata jsonb
    );
  `);
});
afterAll(() => db.close());
beforeEach(() => db.exec(`TRUNCATE "Model", "ModelVersion", "ModelFile"`));

type ModelRow = { id: number; userId?: number; status?: string; mode?: string; deletedBy?: number };

/** A Studio-published model, linked to its run by Model.meta. */
const studioModel = (workflowId: string, m: ModelRow) =>
  db.query(
    `INSERT INTO "Model" (id, "userId", status, mode, "deletedBy", meta) VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      m.id,
      m.userId ?? OWNER,
      m.status ?? 'Published',
      m.mode ?? null,
      m.deletedBy ?? null,
      { trainingStudioWorkflowId: workflowId },
    ]
  );

/** A main-app trainer model, linked to its run by its training file or its version's meta. */
const trainerModel = async (workflowId: string, m: ModelRow, link: 'file' | 'version') => {
  await db.query(
    `INSERT INTO "Model" (id, "userId", status, mode, "deletedBy") VALUES ($1, $2, $3, $4, $5)`,
    [m.id, m.userId ?? OWNER, m.status ?? 'Published', m.mode ?? null, m.deletedBy ?? null]
  );
  await db.query(`INSERT INTO "ModelVersion" (id, "modelId", meta) VALUES ($1, $1, $2)`, [
    m.id,
    link === 'version' ? { trainingWorkflowId: workflowId } : {},
  ]);
  await db.query(
    `INSERT INTO "ModelFile" ("modelVersionId", type, metadata) VALUES ($1, 'Training Data', $2)`,
    [m.id, link === 'file' ? { trainingResults: { workflowId } } : {}]
  );
};

const withheld = async (workflowIds: string[], userId = OWNER) => {
  const sql = studioWithheldWorkflowIdsSql(userId, workflowIds);
  const rows = (await db.query<{ workflowId: string }>(sql.text, sql.values)).rows;
  return rows.map((r) => r.workflowId).sort();
};

describe('studioWithheldWorkflowIds', () => {
  it('withholds a run whose model is taken down', async () => {
    await studioModel('wf-1', { id: 1, mode: 'TakenDown' });
    expect(await withheld(['wf-1'])).toEqual(['wf-1']);
  });

  it.each([
    ['a moderator', MOD],
    ['no recorded actor', undefined],
  ])('withholds a run whose model was deleted by %s', async (_label, deletedBy) => {
    await studioModel('wf-1', { id: 1, status: 'Deleted', deletedBy });
    expect(await withheld(['wf-1'])).toEqual(['wf-1']);
  });

  it('keeps a run whose owner deleted its model', async () => {
    await studioModel('wf-1', { id: 1, status: 'Deleted', deletedBy: OWNER });
    expect(await withheld(['wf-1'])).toEqual([]);
  });

  it('keeps a run whose model is live, and a run with no model', async () => {
    await studioModel('wf-1', { id: 1, status: 'Draft' });
    expect(await withheld(['wf-1', 'wf-none'])).toEqual([]);
  });

  it.each(['file', 'version'] as const)(
    'withholds a main-app trainer run linked through its %s',
    async (link) => {
      await trainerModel('wf-t', { id: 5, mode: 'TakenDown' }, link);
      expect(await withheld(['wf-t'])).toEqual(['wf-t']);
    }
  );

  it("answers only for the caller's own models", async () => {
    await studioModel('wf-1', { id: 1, userId: OTHER, mode: 'TakenDown' });
    expect(await withheld(['wf-1'])).toEqual([]);
  });

  it('answers each run of a batch on its own', async () => {
    await studioModel('wf-1', { id: 1, mode: 'TakenDown' });
    await studioModel('wf-2', { id: 2 });
    await trainerModel('wf-3', { id: 3, status: 'Deleted', deletedBy: MOD }, 'file');
    expect(await withheld(['wf-1', 'wf-2', 'wf-3'])).toEqual(['wf-1', 'wf-3']);
  });
});
