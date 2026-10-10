import { beforeEach, describe, expect, it, vi } from 'vitest';

import { reopenAppeal } from '~/server/services/report.service';
import { AppealStatus, EntityType } from '~/shared/utils/prisma/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';
const mockUpdate = dbMock.dbWrite.appeal.update;

type UpdateArgs = { where: unknown; data: Record<string, unknown> };

const reopen = () => reopenAppeal({ id: 41, message: 'Asking again.' });

const updateArgs = () => mockUpdate.mock.calls[0][0] as UpdateArgs;

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdate.mockResolvedValue({ id: 1 });
});

describe('reopenAppeal', () => {
  it('stamps createdAt so the re-request queues behind fresher work, not ahead of it', async () => {
    const before = Date.now();

    await reopen();

    const { createdAt } = updateArgs().data;
    expect(createdAt).toBeInstanceOf(Date);
    expect((createdAt as Date).getTime()).toBeGreaterThanOrEqual(before);
  });

  it('updates the row the owner already has instead of creating a second one', async () => {
    await reopen();

    expect(updateArgs().where).toMatchObject({ id: 41 });
  });

  // Deliberate: image appeals are opened only by `createEntityAppeal`, which refuses an image under
  // the moderator-only review flag. Dropping this filter lets a reopen put a Pending appeal beside it.
  it('never reopens an image appeal', async () => {
    await reopen();

    expect(updateArgs().where).toEqual({ id: 41, entityType: { not: EntityType.Image } });
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

  // The update returns the row to the appellant, and a stale label would count a Pending row as ruled.
  it("clears the prior ruling's reason and moderator note", async () => {
    await reopen();

    expect(updateArgs().data).toMatchObject({ resolvedReason: null, internalNotes: null });
  });
});
