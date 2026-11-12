import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * The pre-publish gate reads base models before publishModelById's transaction. An owner's edit can
 * move a listed draft onto a gated base model in between, so the publish re-reads the listed versions
 * under its lock and refuses one gated now that the gate did not judge.
 */

const { publishModelById, publishPrivateModel } = await import('../model.service');

const MODEL = 1;
const VERSION = 10;
let lockedBaseModel: string;
const REACHED_WRITE = 'reached the write';

const isVersionBaseModelRead = (strings: TemplateStringsArray) =>
  Array.isArray(strings) && /SELECT id, "baseModel" FROM "ModelVersion"/.test(strings.join('?'));

beforeEach(() => {
  vi.clearAllMocks();
  lockedBaseModel = 'Fibo 2.0';
  dbMock.dbWrite.$queryRaw.mockImplementation((async (strings: TemplateStringsArray) =>
    isVersionBaseModelRead(strings) ? [{ id: VERSION, baseModel: lockedBaseModel }] : []) as never);
  // What the gate and the caller read before the edit landed.
  dbMock.dbWrite.modelVersion.findMany.mockResolvedValue([
    {
      id: VERSION,
      baseModel: 'SDXL 1.0',
      publishedAt: null,
      meta: {},
      model: { type: 'LORA', userId: 5 },
    },
  ] as never);
  dbMock.dbWrite.model.findUnique.mockResolvedValue({
    status: 'Draft',
    availability: 'Public',
    meta: {},
  } as never);
  dbMock.dbWrite.model.update.mockRejectedValue(new Error(REACHED_WRITE));
});

const publish = (gateJudgedVersionIds?: number[]) =>
  publishModelById({
    id: MODEL,
    versionIds: [VERSION],
    meta: {},
    enforceModelRules: !!gateJudgedVersionIds,
    gateJudgedVersionIds,
  });

it("refuses an owner's publish of a version moved onto Fibo 2.0 after the gate read it", async () => {
  await expect(publish([])).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(dbMock.dbWrite.model.update).not.toHaveBeenCalled();
});

it('publishes it when the gate judged that version (control)', async () => {
  await expect(publish([VERSION])).rejects.toThrowError(REACHED_WRITE);
});

it('publishes it when the version is still on an ungated base model (control)', async () => {
  lockedBaseModel = 'SDXL 1.0';
  await expect(publish([])).rejects.toThrowError(REACHED_WRITE);
});

it('lets a moderator, who skips the gate, publish it (control)', async () => {
  await expect(publish(undefined)).rejects.toThrowError(REACHED_WRITE);
});

describe('publishPrivateModel', () => {
  // A version on Fibo 2.0 that training published on the private model after the gate read its list.
  const LATE = 11;

  beforeEach(() => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue({
      id: MODEL,
      userId: 5,
      name: 'm',
      description: null,
      availability: 'Private',
      status: 'Published',
      meta: {},
      type: 'LORA',
    } as never);
    dbMock.dbWrite.modelVersion.findMany.mockResolvedValue([
      { id: VERSION, baseModel: 'SDXL 1.0', publishedAt: new Date(), meta: {} },
    ] as never);
    dbMock.dbWrite.$queryRaw.mockImplementation((async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (isVersionBaseModelRead(strings))
        return [
          { id: VERSION, baseModel: 'SDXL 1.0' },
          { id: LATE, baseModel: lockedBaseModel },
        ];
      if (sql.includes('"modelId" = ?')) return [{ id: VERSION }, { id: LATE }];
      if (sql.includes('FOR NO KEY UPDATE') && sql.includes('"ModelVersion"'))
        return [{ id: VERSION }];
      return [];
    }) as never);
    dbMock.dbWrite.post.updateMany.mockRejectedValue(new Error(REACHED_WRITE));
  });

  const goPublic = (gateJudgedVersionIds?: number[]) =>
    publishPrivateModel(
      { modelId: MODEL, publishVersions: false, isModerator: !gateJudgedVersionIds },
      { enforceModelRules: !!gateJudgedVersionIds, gateJudgedVersionIds }
    );

  it('refuses to make public a gated version published after the gate read the list', async () => {
    await expect(goPublic([])).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(dbMock.dbWrite.post.updateMany).not.toHaveBeenCalled();
  });

  it('goes public when the gate judged that version (control)', async () => {
    await expect(goPublic([LATE])).rejects.toThrowError(REACHED_WRITE);
  });

  it('goes public when the late version is on an ungated base model (control)', async () => {
    lockedBaseModel = 'SDXL 1.0';
    await expect(goPublic([])).rejects.toThrowError(REACHED_WRITE);
  });

  it('lets a moderator, who skips the gate, make it public (control)', async () => {
    await expect(goPublic(undefined)).rejects.toThrowError(REACHED_WRITE);
  });
});
