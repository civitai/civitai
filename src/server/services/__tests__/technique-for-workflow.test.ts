import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getTechniqueForWorkflow } from '~/server/services/technique.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

const techniques: Record<string, number> = { img2img: 2, img2vid: 7, ref2vid: 10 };

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.technique.findFirst.mockImplementation(
    ({ where }: { where: { name: { equals: string } } }) => {
      const id = techniques[where.name.equals];
      return Promise.resolve(id ? { id } : null);
    }
  );
});

describe('getTechniqueForWorkflow', () => {
  it('uses the variant when it is a technique of its own', async () => {
    expect(await getTechniqueForWorkflow('img2vid:ref2vid')).toEqual({ id: 10 });
  });

  it('falls back to the base when the variant is not a technique', async () => {
    expect(await getTechniqueForWorkflow('img2img:hires-fix')).toEqual({ id: 2 });
  });

  it('matches a plain key as before', async () => {
    expect(await getTechniqueForWorkflow('img2vid')).toEqual({ id: 7 });
  });
});
