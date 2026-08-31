import { beforeEach, describe, expect, it, vi } from 'vitest';

import { reopenModelAppeal } from '~/server/services/report.service';
import { AppealStatus, EntityType } from '~/shared/utils/prisma/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';
const mockUpdate = dbMock.dbWrite.appeal.update;

type UpdateArgs = { where: unknown; data: Record<string, unknown> };

const reopen = () =>
  reopenModelAppeal({ entityId: 2186217, userId: 602767, message: 'Asking again.' });

const updateArgs = () => mockUpdate.mock.calls[0][0] as UpdateArgs;

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdate.mockResolvedValue({ id: 1 });
});

describe('reopenModelAppeal', () => {
  it('stamps createdAt so the re-request queues behind fresher work, not ahead of it', async () => {
    const before = Date.now();

    await reopen();

    const { createdAt } = updateArgs().data;
    expect(createdAt).toBeInstanceOf(Date);
    expect((createdAt as Date).getTime()).toBeGreaterThanOrEqual(before);
  });

  it('updates the row the owner already has instead of creating a second one', async () => {
    await reopen();

    expect(updateArgs().where).toEqual({
      entityType_entityId_userId: {
        entityType: EntityType.Model,
        entityId: 2186217,
        userId: 602767,
      },
    });
  });

  it('clears the prior resolution and reopens as Pending', async () => {
    await reopen();

    expect(updateArgs().data).toMatchObject({
      status: AppealStatus.Pending,
      appealMessage: 'Asking again.',
      resolvedAt: null,
      resolvedBy: null,
      resolvedMessage: null,
    });
  });
});
