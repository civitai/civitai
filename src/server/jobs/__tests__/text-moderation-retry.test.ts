import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ModerationAdapters from '~/server/services/moderation-adapters';

vi.mock('~/server/services/moderation-adapters', async (importOriginal) => ({
  ...(await importOriginal<typeof ModerationAdapters>()),
  getModerationAdapter: vi.fn(),
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { retryFailedTextModeration } from '~/server/jobs/text-moderation-retry';
import { getModerationAdapter } from '~/server/services/moderation-adapters';
import { TEXT_SCAN_ENTITY_GONE } from '~/server/services/text-scan/route';

const submit = vi.fn();
const adapter = {
  resolveContent: vi.fn(async (ids: number[]) => new Map(ids.map((id) => [id, 'text']))),
  submit,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getModerationAdapter).mockReturnValue(adapter);
  dbMock.dbRead.entityModeration.findMany.mockResolvedValue([
    { id: 101, entityType: 'Model', entityId: 1, status: 'Pending' },
    { id: 102, entityType: 'Model', entityId: 2, status: 'Failed' },
  ]);
});

const run = () => retryFailedTextModeration.run().result;

describe('retryFailedTextModeration', () => {
  it('deletes the row of an entity the scan reports as no longer scannable', async () => {
    submit.mockImplementation(async ({ entityId }) =>
      entityId === 1 ? TEXT_SCAN_ENTITY_GONE : { id: 'wf-2' }
    );

    expect(await run()).toMatchObject({ retried: 1, missing: 1, errors: 0 });
    expect(dbMock.dbWrite.entityModeration.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: [101] } },
    });
  });

  it('still counts a declined submit as an error and keeps its row', async () => {
    submit.mockResolvedValue(null);

    expect(await run()).toMatchObject({ retried: 0, missing: 0, errors: 2 });
    expect(dbMock.dbWrite.entityModeration.deleteMany).not.toHaveBeenCalled();
  });
});
