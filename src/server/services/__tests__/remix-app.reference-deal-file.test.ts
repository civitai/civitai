import { beforeEach, describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loadReference } from '~/server/services/remix-app.service';

const OWNER = 7;
const caller = { user: { id: OWNER } } as Parameters<typeof loadReference>[1];

beforeEach(() => {
  dbMock.dbRead.image.findUnique.mockResolvedValue({ userId: OWNER } as never);
});

describe('loadReference', () => {
  it("refuses the caller's own image when it is a deal file's scan copy", async () => {
    dbMock.dbWrite.$queryRaw.mockImplementationOnce((async (strings: TemplateStringsArray) =>
      [...strings].join('').includes('ServiceDealFile') ? [{ dealFileImage: true }] : []) as never);
    await expect(loadReference(1, caller)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
