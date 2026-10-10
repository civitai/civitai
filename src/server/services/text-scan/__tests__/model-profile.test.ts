import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

const { loadModelScanSubjects } = await import(
  '~/server/services/text-scan/profiles/model.profile'
);
await import('~/server/services/text-scan/profiles/model-rules.profile');
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
});

describe('profiles', () => {
  it('the ModelRules profile loads public text only, and Model does not', async () => {
    await getTextScanProfile('ModelRules')!.load([1]);
    expect(call().where).toHaveProperty('availability');
    findMany.mockClear();
    await getTextScanProfile('Model')!.load([1]);
    expect(call().where).not.toHaveProperty('availability');
  });
});
