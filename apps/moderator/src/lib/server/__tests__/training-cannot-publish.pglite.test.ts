import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../test/pglite';
import { pgliteDialect } from './abuse-detection-pglite.harness';

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));
const syncSearchIndex = vi.fn();

vi.mock('../db', () => ({
  get dbRead() {
    return dbHandle.current;
  },
  get dbWrite() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));
// The service's other imports (orchestrator, ClickHouse, mod endpoints) open connections at load; this
// file only exercises the Model write.
vi.mock('@civitai/orchestration-client', () => ({ getWorkflow: vi.fn() }));
vi.mock('../orchestrator', () => ({}));
vi.mock('../clickhouse', () => ({ getClickhouse: () => ({}) }));
vi.mock('../mod-activity', () => ({ recordModActivity: vi.fn() }));
vi.mock('../axiom', () => ({ logToAxiom: vi.fn() }));
vi.mock('../users.service', () => ({ usersByIds: vi.fn() }));
vi.mock('../user-actions.service', () => ({ callModEndpoint: vi.fn() }));
vi.mock('../training-orchestration.service', () => ({ TRAINING_STEP_TYPES: [] }));
vi.mock('../search-index', () => ({ syncSearchIndex: (...a: unknown[]) => syncSearchIndex(...a) }));

const { setCannotPublish } = await import('../training-moderation.service');

let db: PGlite;

const metaOf = async (id: number) =>
  (
    await db.query<{ meta: Record<string, unknown> | null }>(
      `SELECT meta FROM "Model" WHERE id=$1`,
      [id]
    )
  ).rows[0].meta;

beforeEach(async () => {
  db = await freshPglite();
  await db.exec(
    `CREATE TABLE "Model" ("id" INTEGER PRIMARY KEY, "meta" JSONB, "deletedAt" TIMESTAMP);`
  );
  await db.exec(`
    INSERT INTO "Model" ("id","meta") VALUES (1, NULL), (2, '{"cannotPublish": true, "scan": "kept"}');
    INSERT INTO "Model" ("id","meta","deletedAt") VALUES (3, '{}', now());
  `);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
  syncSearchIndex.mockReset();
});

afterEach(async () => {
  dbHandle.current = null;
  await db.close();
});

describe('setCannotPublish', () => {
  it('writes and syncs the search index when the state differs, keeping the rest of meta', async () => {
    expect(await setCannotPublish(1, true)).toBe(true);
    expect(await metaOf(1)).toEqual({ cannotPublish: true });
    expect(await setCannotPublish(2, false)).toBe(true);
    expect(await metaOf(2)).toEqual({ cannotPublish: false, scan: 'kept' });
    expect(syncSearchIndex).toHaveBeenCalledTimes(2);
    expect(syncSearchIndex).toHaveBeenCalledWith({
      entityType: 'model',
      entityId: 1,
      action: 'update',
    });
  });

  it('changes nothing and syncs nothing when the model is already in that state', async () => {
    expect(await setCannotPublish(2, true)).toBe(false);
    expect(await setCannotPublish(1, false)).toBe(false);
    expect(await metaOf(1)).toBeNull();
    expect(syncSearchIndex).not.toHaveBeenCalled();
  });

  it('lets only one of two writers asking for the same state report the change', async () => {
    const results = [await setCannotPublish(1, true), await setCannotPublish(1, true)];
    expect(results).toEqual([true, false]);
  });

  it('does not touch a deleted or missing model', async () => {
    expect(await setCannotPublish(3, true)).toBe(false);
    expect(await setCannotPublish(99, true)).toBe(false);
    expect(await metaOf(3)).toEqual({});
  });
});
