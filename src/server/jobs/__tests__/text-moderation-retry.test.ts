import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ModerationAdapters from '~/server/services/moderation-adapters';
import type * as PromptModule from '~/server/services/text-scan/prompt';

vi.mock('~/server/services/moderation-adapters', async (importOriginal) => ({
  ...(await importOriginal<typeof ModerationAdapters>()),
  getModerationAdapter: vi.fn(),
}));
vi.mock('~/server/services/text-scan/prompt', async (importOriginal) => ({
  ...(await importOriginal<typeof PromptModule>()),
  getActiveTextScanPrompts: vi.fn(),
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { retryFailedTextModeration } from '~/server/jobs/text-moderation-retry';
import { TEXT_MODERATION_RETRY_LIMIT } from '~/server/jobs/text-moderation-retry.constants';
import { getModerationAdapter } from '~/server/services/moderation-adapters';
import {
  TEXT_SCAN_ENTITY_GONE,
  TEXT_SCAN_ENTITY_NOT_PUBLIC,
} from '~/server/services/text-scan/route';
import { resetTextScanRolloutCache } from '~/server/services/text-scan/mode';
import { getActiveTextScanPrompts } from '~/server/services/text-scan/prompt';

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

  // A rating floor reads the row's verdict whatever its status, so a not-public entity keeps it.
  it('keeps the row of a not-public entity and stops retrying it, without touching its verdict', async () => {
    submit.mockImplementation(async ({ entityId }) =>
      entityId === 1 ? TEXT_SCAN_ENTITY_NOT_PUBLIC : { id: 'wf-2' }
    );

    expect(await run()).toMatchObject({ retried: 1, missing: 0, notPublic: 1, errors: 0 });
    expect(dbMock.dbWrite.entityModeration.deleteMany).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.entityModeration.updateMany).toHaveBeenLastCalledWith({
      where: { id: { in: [101] } },
      data: { retryCount: 9, status: 'Failed' },
    });
  });

  it('deletes the row of an entity the resolver omits', async () => {
    adapter.resolveContent.mockResolvedValueOnce(new Map([[2, 'text']]));
    submit.mockResolvedValue({ id: 'wf-2' });

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

describe('review text while its scan cannot ask every label (civitai/civitai#10118)', () => {
  type Row = {
    id: number;
    entityType: string;
    entityId: number;
    status: string;
    retryCount: number;
  };
  let rows: Row[];
  /** A refused review-text submit spends one retry on its row, as the scan's skip path does. */
  let refused: boolean;

  const askable = (cause?: 'gate closed' | 'prompts unreadable') => {
    vi.mocked(getActiveTextScanPrompts).mockResolvedValue({
      'label:csam': { id: 3, key: 'label:csam', content: 'CSAM DEF' },
    } as never);
    if (cause === 'prompts unreadable')
      vi.mocked(getActiveTextScanPrompts).mockRejectedValue(new Error('down'));
    redisMock.sysRedis.hGetAll.mockResolvedValue(
      (cause === 'gate closed' ? {} : { csam: 'review' }) as never
    );
    resetTextScanRolloutCache();
    refused = !!cause;
  };
  const said = () =>
    loggingMock.logToAxiom.mock.calls.filter(([entry]) =>
      String((entry as { message?: string }).message).startsWith('review text scan cannot ask')
    );

  beforeEach(() => {
    rows = [
      { id: 201, entityType: 'ServiceDealReview', entityId: 7, status: 'Failed', retryCount: 1 },
      { id: 202, entityType: 'Model', entityId: 3, status: 'Failed', retryCount: 1 },
      // Pending past its timeout: the job spends a retry on it before submitting, unless skipped.
      {
        id: 203,
        entityType: 'ServiceDealReviewReply',
        entityId: 8,
        status: 'Pending',
        retryCount: 1,
      },
    ];
    dbMock.dbRead.entityModeration.findMany.mockImplementation((async () =>
      rows
        .filter((r) => r.retryCount < TEXT_MODERATION_RETRY_LIMIT)
        .map(({ retryCount: _, ...r }) => r)) as never);
    dbMock.dbWrite.entityModeration.updateMany.mockImplementation((async (args: {
      where: { id: { in: number[] } };
      data: { retryCount: number | { increment: number }; status?: string };
    }) => {
      for (const row of rows.filter((r) => args.where.id.in.includes(r.id))) {
        const { retryCount, status } = args.data;
        row.retryCount =
          typeof retryCount === 'number' ? retryCount : row.retryCount + retryCount.increment;
        if (status) row.status = status;
      }
      return { count: args.where.id.in.length };
    }) as never);
    submit.mockImplementation(async ({ entityId }: { entityId: number }) => {
      const row = rows.find((r) => r.entityId === entityId)!;
      if (row.entityType !== 'Model' && refused) {
        row.retryCount++;
        return null;
      }
      return { id: `wf-${entityId}` };
    });
  });

  it.each(['gate closed', 'prompts unreadable'] as const)(
    '%s for more passes than the retry limit: other text is still retried, and the review text is retried once the labels return',
    async (cause) => {
      askable(cause);
      for (let pass = 0; pass < TEXT_MODERATION_RETRY_LIMIT + 2; pass++) {
        submit.mockClear();
        loggingMock.logToAxiom.mockClear();
        expect(await run()).toMatchObject({ retried: 1, skipped: 2 });
        expect(submit.mock.calls.map(([args]) => args.entityId)).toEqual([3]);
        expect(said()).toHaveLength(1);
      }
      askable();
      submit.mockClear();
      expect(rows.map((r) => r.retryCount)).toEqual([1, 1, 1]);
      expect(await run()).toMatchObject({ retried: 3, skipped: 0 });
      expect(submit.mock.calls.map(([args]) => args.entityId).sort()).toEqual([3, 7, 8]);
    }
  );
});
