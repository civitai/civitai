import { describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { getEntityOwnerId } from '~/server/services/entity-owner.service';

describe('getEntityOwnerId', () => {
  it.each([
    ['Model', 'model'],
    ['Image', 'image'],
    ['Post', 'post'],
    ['Article', 'article'],
    ['Model3D', 'model3D'],
  ] as const)('reads %s owners from the %s table', async (entityType, table) => {
    dbMock.dbRead[table].findUnique.mockResolvedValueOnce({ userId: 42 });
    await expect(getEntityOwnerId(entityType, 9)).resolves.toBe(42);
    expect(dbMock.dbRead[table].findUnique).toHaveBeenCalledWith({
      where: { id: 9 },
      select: { userId: true },
    });
  });

  it('is null when the entity does not exist', async () => {
    await expect(getEntityOwnerId('Image', 9)).resolves.toBeNull();
  });

  it('reads from the client it is given', async () => {
    dbMock.dbWrite.image.findUnique.mockResolvedValueOnce({ userId: 7 });
    await expect(getEntityOwnerId('Image', 9, dbMock.dbWrite as never)).resolves.toBe(7);
  });
});
