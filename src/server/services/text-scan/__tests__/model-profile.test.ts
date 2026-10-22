import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

const { loadModelScanSubjects } = await import(
  '~/server/services/text-scan/profiles/model.profile'
);
const { textScanTextHash } = await import('~/server/services/text-scan/prompt');
const { getTextScanProfile } = await import('~/server/services/text-scan/profiles');

const findMany = dbMock.dbWrite.model.findMany;
const call = () => findMany.mock.calls[0][0];

beforeEach(() => {
  vi.clearAllMocks();
  findMany.mockResolvedValue([]);
});

describe('loadModelScanSubjects', () => {
  it('reads every version of any model by default', async () => {
    await loadModelScanSubjects([1]);
    expect(call().where).toEqual({ id: { in: [1] }, deletedAt: null });
    expect(call().select.modelVersions).not.toHaveProperty('where');
  });

  it('with publicOnly, reads only public models and their public versions', async () => {
    await loadModelScanSubjects([1], { publicOnly: true });
    expect(call().where).toEqual({
      id: { in: [1] },
      deletedAt: null,
      status: { in: ['Published', 'Scheduled'] },
      availability: { not: 'Private' },
    });
    expect(call().select.modelVersions.where).toEqual({
      status: { in: ['Published', 'Scheduled'] },
    });
  });

  it('with publicVersionsOnly, reads any model but only its public versions', async () => {
    await loadModelScanSubjects([1], { publicVersionsOnly: true });
    expect(call().where).toEqual({ id: { in: [1] }, deletedAt: null });
    expect(call().select.modelVersions.where).toEqual({
      status: { in: ['Published', 'Scheduled'] },
    });
  });
});

describe('loadModelScanSubjects with prePublish', () => {
  it('reads the model whatever its status, with the public versions and the ones about to be', async () => {
    await loadModelScanSubjects([1], { prePublish: { versionIds: [5, 6] } });
    expect(call().where).toEqual({ id: { in: [1] } });
    expect(call().select.modelVersions.where).toEqual({
      OR: [{ status: { in: ['Published', 'Scheduled'] } }, { id: { in: [5, 6] } }],
    });
  });
});

describe('pre-publish and post-publish text hash agreement', () => {
  type Version = { id: number; status: string; name: string };
  const versions = (v2Status: string): Version[] => [
    { id: 1, status: 'Published', name: 'v1' },
    { id: 2, status: v2Status, name: 'v2' },
    { id: 3, status: 'Draft', name: 'v3' },
  ];

  const respond = (modelVersions: Version[]) =>
    findMany.mockImplementation(async (args: any) => {
      const match = (v: Version, where: any): boolean =>
        where.OR
          ? where.OR.some((w: any) => match(v, w))
          : (where.status ? where.status.in.includes(v.status) : true) &&
            (where.id ? where.id.in.includes(v.id) : true);
      const where = args.select.modelVersions.where;
      return [
        {
          id: 9,
          userId: 1,
          name: 'Name',
          description: null,
          nsfw: false,
          poi: false,
          minor: false,
          modelVersions: modelVersions
            .filter((v) => (where ? match(v, where) : true))
            .map((v) => ({ name: v.name, description: null, trainedWords: [] })),
        },
      ];
    });

  const hashOf = async (load: Promise<Map<number, any>>) => textScanTextHash((await load).get(9)!);

  it.each([
    ['the versions being published', [2]],
    ['no versions (undefined and empty both publish none)', []],
  ])('hashes alike for %s', async (_label, versionIds) => {
    respond(versions('Draft'));
    const before = await hashOf(loadModelScanSubjects([9], { prePublish: { versionIds } }));

    respond(versions(versionIds.includes(2) ? 'Published' : 'Draft'));
    const after = await hashOf(loadModelScanSubjects([9], { publicOnly: true }));

    expect(before).toBe(after);
  });

  it('would differ if a version that stays unpublished were counted', async () => {
    respond(versions('Draft'));
    const wrong = await hashOf(loadModelScanSubjects([9], { prePublish: { versionIds: [2, 3] } }));
    respond(versions('Published'));
    const after = await hashOf(loadModelScanSubjects([9], { publicOnly: true }));
    expect(wrong).not.toBe(after);
  });
});

describe('profiles', () => {
  it('the Model profile reads only public versions', async () => {
    await getTextScanProfile('Model')!.load([1]);
    expect(call().select.modelVersions.where).toEqual({
      status: { in: ['Published', 'Scheduled'] },
    });
  });
});
