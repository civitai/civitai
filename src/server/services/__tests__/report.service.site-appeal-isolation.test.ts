import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  getAppealCount,
  getLatestAppeal,
  reopenAppeal,
  resolveEntityAppeal,
} from '~/server/services/report.service';
import { AppealStatus, EntityType } from '~/shared/utils/prisma/enums';

// The in-app appeal paths key on (entityType, entityId, userId). A site-form appeal on the same
// model shares that key, so each of these must read and write only rows with no category, or a
// form appeal would be reopened as a flag appeal, block one, or count toward the appeal fee.

beforeEach(() => {
  vi.resetAllMocks();
});

describe('in-app appeal paths ignore site-form appeals', () => {
  it('getLatestAppeal', async () => {
    await getLatestAppeal({ entityType: EntityType.Model, entityId: 1, userId: 2 });
    expect(dbMock.dbRead.appeal.findFirst.mock.calls[0][0].where).toEqual({
      entityType: EntityType.Model,
      entityId: 1,
      userId: 2,
      category: null,
    });
  });

  it('reopenAppeal', async () => {
    await reopenAppeal({ id: 5, message: 'again' });
    expect(dbMock.dbWrite.appeal.update.mock.calls[0][0].where).toMatchObject({
      id: 5,
      category: null,
    });
  });

  it('getAppealCount', async () => {
    await getAppealCount({ userId: 2, status: [AppealStatus.Pending] });
    expect(dbMock.dbRead.appeal.count.mock.calls[0][0].where).toMatchObject({ category: null });
  });

  it('resolveEntityAppeal', async () => {
    dbMock.dbWrite.appeal.updateManyAndReturn.mockResolvedValue([] as never);
    await resolveEntityAppeal({
      ids: [1],
      entityType: EntityType.Model,
      status: AppealStatus.Approved,
    } as never);
    expect(dbMock.dbWrite.appeal.updateManyAndReturn.mock.calls[0][0].where).toMatchObject({
      category: null,
    });
  });
});
