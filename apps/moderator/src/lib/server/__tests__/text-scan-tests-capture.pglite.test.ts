import type { Kysely } from 'kysely';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB as ModeratorDB } from '../moderator-db/types';
import type { CaptureInput } from '../text-scan-tests/capture';
import { MOD, useTestSetsDb, seedSet } from './text-scan-tests-pglite.harness';

vi.mock('../user-actions.service', () => ({ callModEndpoint: vi.fn() }));
// $lib/server/query reaches the main-app DB client through users.service.
vi.mock('../db', () => ({ dbRead: {}, dbWrite: {} }));

const { captureCase: captureParsed } = await import('../text-scan-tests/capture');
// Plain objects stand in for captureSchema output, which types the optional fields as present.
const captureCase = (
  deps: Parameters<typeof captureParsed>[0],
  input: Record<string, unknown>,
  userId: number
) => captureParsed(deps, input as CaptureInput, userId);
const { listCases, listSets } = await import('../text-scan-tests/store');

let db: Kysely<ModeratorDB>;
const compose = vi.fn();

const sets = useTestSetsDb();

beforeEach(async () => {
  ({ db } = sets);
  compose.mockReset();
  compose.mockResolvedValue([
    {
      entityId: 71,
      ok: true,
      fields: [{ heading: 'Comment', text: 'synthetic stored text' }],
      text: 'synthetic stored text',
      userId: 5,
    },
  ]);
});

const base = {
  workspace: 'prompts' as const,
  entityType: 'CommentV2' as const,
  expected: { scam: true },
  note: null,
  origin: 'try' as const,
};

describe('captureCase', () => {
  it('re-composes an entity server side and ignores posted text', async () => {
    const setId = await seedSet(db);
    const saved = await captureCase(
      { db, compose },
      { ...base, setId, entityId: 71, fields: [{ heading: 'Comment', text: 'posted text' }] },
      MOD
    );
    expect(compose).toHaveBeenCalledWith('CommentV2', [71]);
    const [stored] = await listCases(db, setId);
    expect(stored).toMatchObject({
      id: saved.caseId,
      entityId: 71,
      authorId: 5,
      origin: 'try',
      fields: [{ heading: 'Comment', text: 'synthetic stored text' }],
    });
  });

  it('saves free text as posted, normalised, and dedupes a re-capture', async () => {
    const setId = await seedSet(db);
    const input = {
      ...base,
      setId,
      fields: [{ heading: '  Comment ', text: 'synthetic free text' }],
    };
    const first = await captureCase({ db, compose }, input, MOD);
    const again = await captureCase({ db, compose }, { ...input, expected: { scam: false } }, MOD);
    expect(compose).not.toHaveBeenCalled();
    expect(again).toMatchObject({ caseId: first.caseId, created: false, rescore: true });
    expect(await listCases(db, setId)).toEqual([
      expect.objectContaining({
        fields: [{ heading: 'Comment', text: 'synthetic free text' }],
        expected: { scam: false },
      }),
    ]);
  });

  it('creates the named set in the workspace the capture came from', async () => {
    const saved = await captureCase(
      { db, compose },
      { ...base, newSetName: 'synthetic new set', entityId: 71 },
      MOD
    );
    expect(saved.setCreated).toBe(true);
    expect(await listSets(db, 'prompts')).toEqual([
      expect.objectContaining({ id: saved.setId, name: 'synthetic new set' }),
    ]);
  });

  it('creates no set when the entity cannot be loaded or the expectation is invalid', async () => {
    compose.mockResolvedValue([{ entityId: 71, ok: false, error: 'not found' }]);
    await expect(
      captureCase({ db, compose }, { ...base, newSetName: 'never', entityId: 71 }, MOD)
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      captureCase(
        { db, compose },
        { ...base, newSetName: 'never', entityId: 71, expected: { nsfw: {} } },
        MOD
      )
    ).rejects.toMatchObject({ status: 400 });
    expect(await listSets(db, 'prompts')).toEqual([]);
  });

  it('refuses a set stored under the retired Model rules workspace', async () => {
    const setId = await seedSet(db, { workspace: 'modelRules' });
    await expect(
      captureCase({ db, compose }, { ...base, setId, entityId: 71 }, MOD)
    ).rejects.toMatchObject({ status: 409 });
  });
});
