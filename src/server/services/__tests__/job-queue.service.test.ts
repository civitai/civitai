import { describe, it, expect, vi, beforeEach } from 'vitest';

import { removeImageScanJobQueue } from '~/server/services/job-queue.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { EntityType, JobQueueType } from '~/shared/utils/prisma/enums';
const mockDbWrite = dbMock.dbWrite;

beforeEach(() => {
  mockDbWrite.$executeRaw.mockClear();
});

describe('removeImageScanJobQueue', () => {
  it('deletes only the ImageScan rows for those images', async () => {
    await removeImageScanJobQueue([1, 2, 3]);
    expect(mockDbWrite.$executeRaw).toHaveBeenCalledTimes(1);
    // Tagged-template call: [strings, ...values]. Joining the strings on a placeholder pins
    // which column each value is compared against.
    const [strings, ...values] = mockDbWrite.$executeRaw.mock.calls[0] as [
      TemplateStringsArray,
      ...unknown[]
    ];
    expect(strings.join('?').replace(/\s+/g, ' ').trim()).toBe(
      'DELETE FROM "JobQueue" WHERE type = ?::"JobQueueType" AND "entityType" = ?::"EntityType" AND "entityId" = ANY(?)'
    );
    expect(values).toEqual([JobQueueType.ImageScan, EntityType.Image, [1, 2, 3]]);
  });

  it('no-ops on an empty id list (no DB round-trip)', async () => {
    await removeImageScanJobQueue([]);
    expect(mockDbWrite.$executeRaw).not.toHaveBeenCalled();
  });
});
