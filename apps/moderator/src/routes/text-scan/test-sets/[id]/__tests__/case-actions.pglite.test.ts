import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The set page's write actions over real rows. They are also what the playground's "Save as test
 * case" posts to, so the form shape that page sends is exercised here.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(join(HERE, '../../../../../../text-scan-lab/schema.sql'), 'utf8');

const holder = vi.hoisted(() => ({ pg: null as PGlite | null }));

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$app/server', () => ({ getRequestEvent: vi.fn() }));
vi.mock('$lib/server/moderator-db', async () => {
  const { Kysely } = await import('kysely');
  const { pgliteDialect } = await import('$lib/server/__tests__/abuse-detection-pglite.harness');
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
vi.mock('$lib/server/text-scan-lab/harness-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/text-scan-lab/harness-client')>()),
  composeEntities: harness.composeEntities,
}));

const { actions } = await import('../+page.server');
const { createSet, listCases } = await import('$lib/server/text-scan-lab/test-sets.service');

const MOD = 990001;
const EDIT = { 'textScan.testSet.edit': true };

type ActionName = keyof typeof actions;
const act = (
  name: ActionName,
  setId: number,
  grants: Record<string, boolean>,
  fields: Record<string, string>
) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.append(k, v);
  const event = {
    request: { formData: async () => data },
    params: { id: String(setId) },
    locals: { user: { id: MOD }, grants },
  } as unknown as Parameters<(typeof actions)[ActionName]>[0];
  return actions[name](event) as Promise<Record<string, unknown>>;
};

const playgroundSave = (extra: Record<string, string> = {}) => ({
  entityType: 'Model',
  entityId: '42',
  authorId: '7',
  fields: JSON.stringify([{ heading: 'Name', text: 'my lora' }]),
  expected: JSON.stringify({ nsfw: { min: 'r', max: 'r' }, poi: false }),
  note: '',
  ...extra,
});

let setId: number;
beforeEach(async () => {
  vi.clearAllMocks();
  holder.pg = await PGlite.create();
  await holder.pg.exec(SCHEMA);
  setId = (await createSet({ name: 'set', description: null }, MOD)).id;
});

describe('without textScan.testSet.edit', () => {
  it('refuses every write with 403 and writes nothing', async () => {
    for (const name of ['addCase', 'updateExpected', 'removeCase', 'addEntities'] as const) {
      expect(await act(name, setId, {}, playgroundSave({ caseId: '1', ids: '1' }))).toMatchObject({
        status: 403,
      });
    }
    expect(await listCases(setId)).toEqual([]);
    expect(harness.composeEntities).not.toHaveBeenCalled();
  });
});

describe('addCase (the playground save)', () => {
  it('stores an entity case with its author, and replaces it on a second save', async () => {
    expect(await act('addCase', setId, EDIT, playgroundSave())).toMatchObject({ created: true });
    expect(
      await act('addCase', setId, EDIT, playgroundSave({ expected: '{"poi":true}', note: 'fixed' }))
    ).toMatchObject({ created: false });
    const cases = await listCases(setId);
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({
      entityId: 42,
      authorId: 7,
      synthetic: false,
      expected: { poi: true },
      note: 'fixed',
    });
  });

  it('stores free text as a synthetic case with no entity', async () => {
    await act('addCase', setId, EDIT, playgroundSave({ entityId: '', authorId: '' }));
    const [c] = await listCases(setId);
    expect(c).toMatchObject({ entityId: null, authorId: null, synthetic: true });
  });

  it('refuses min above max', async () => {
    const res = await act(
      'addCase',
      setId,
      EDIT,
      playgroundSave({ expected: JSON.stringify({ nsfw: { min: 'xxx', max: 'pg13' } }) })
    );
    expect(res).toMatchObject({ status: 400 });
    expect(await listCases(setId)).toEqual([]);
  });
});

describe('addEntities', () => {
  it('refuses a non-id token before composing', async () => {
    expect(
      await act('addEntities', setId, EDIT, { entityType: 'Model', ids: '1, two' })
    ).toMatchObject({ status: 400, data: { error: 'Not an id: two.' } });
    expect(harness.composeEntities).not.toHaveBeenCalled();
  });
});
