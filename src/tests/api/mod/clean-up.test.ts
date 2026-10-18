import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const { mockCreateModelFileScanRequest } = vi.hoisted(() => ({
  mockCreateModelFileScanRequest: vi.fn(),
}));

vi.mock('~/server/utils/endpoint-helpers', () => ({
  ModEndpoint: (handler: unknown) => handler,
}));
// The real orchestrator module runs env validation on import.
vi.mock('~/server/services/orchestrator/orchestrator.service', () => ({
  createModelFileScanRequest: mockCreateModelFileScanRequest,
  ModelFileScanSubmissionError: class extends Error {},
}));

import handler from '~/pages/api/mod/clean-up';
import { dbMock } from '~/__tests__/mocks/db.mock';

function createMocks(query: Record<string, string>) {
  const req = { method: 'GET', query } as unknown as NextApiRequest;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as NextApiResponse;
  return { req, res };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('mod/clean-up', () => {
  // Low-priority model-file scans fail before a worker claims them, so a re-queue at
  // low never completes.
  it('re-queues model file scans at normal priority', async () => {
    dbMock.dbRead.modelFile.findMany.mockResolvedValue([
      {
        id: 1,
        url: 's3://k1',
        modelVersion: { id: 10, baseModel: 'SDXL', model: { id: 100, type: 'LORA' } },
      },
    ]);
    mockCreateModelFileScanRequest.mockResolvedValue(undefined);
    const { req, res } = createMocks({ modelFileIds: '1', wait: 'true' });

    await (handler as (req: NextApiRequest, res: NextApiResponse) => Promise<void>)(req, res);

    expect(mockCreateModelFileScanRequest).toHaveBeenCalledWith({
      fileId: 1,
      modelVersionId: 10,
      modelId: 100,
      modelType: 'LORA',
      baseModel: 'SDXL',
      url: 's3://k1',
      priority: 'normal',
    });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  // One call used to submit every match: `after=<old date>` re-queued every file since then,
  // settled ones included, at 20-way concurrency into the pool new uploads share.
  describe('bounded re-queue', () => {
    const run = (query: Record<string, string>) => {
      const { req, res } = createMocks({ wait: 'true', ...query });
      return (handler as (req: NextApiRequest, res: NextApiResponse) => Promise<void>)(
        req,
        res
      ).then(() => res);
    };
    const where = () => dbMock.dbRead.modelFile.findMany.mock.calls[0][0].where;
    const fileRows = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: i + 1,
        url: `s3://k${i + 1}`,
        modelVersion: { id: 10, baseModel: 'SDXL', model: { id: 100, type: 'LORA' } },
      }));

    beforeEach(() => {
      dbMock.dbRead.modelFile.findMany.mockResolvedValue([]);
      mockCreateModelFileScanRequest.mockResolvedValue(undefined);
    });

    const NOW = new Date('2026-10-18T12:00:00.000Z');
    const DAY_AGO = new Date('2026-10-17T12:00:00.000Z');
    const waitingForScan = {
      virusScanResult: 'Pending',
      OR: [{ scanRequestedAt: null }, { scanRequestedAt: { lt: DAY_AGO } }],
    };

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(NOW);
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('bulk selection takes only files still waiting for a scan, and not in flight', async () => {
      await run({ after: '2026-01-01' });
      expect(where()).toEqual({
        createdAt: { gte: new Date('2026-01-01') },
        ...waitingForScan,
        type: { not: 'Training Data' },
      });
    });

    it('force=true lifts the bulk filter', async () => {
      await run({ after: '2026-01-01', force: 'true' });
      expect(where()).toEqual({
        createdAt: { gte: new Date('2026-01-01') },
        type: { not: 'Training Data' },
      });
    });

    // Naming files means "re-scan these", settled or not; filtering them to Pending would
    // quietly answer files: 0. Do not move the bulk filter up to the top level.
    it('named files are re-scanned whatever their scan state', async () => {
      await run({ modelFileIds: '7,8' });
      expect(where()).toEqual({ id: { in: [7, 8] }, type: { not: 'Training Data' } });

      vi.clearAllMocks();
      dbMock.dbRead.modelFile.findMany.mockResolvedValue([]);
      await run({ modelVersionIds: '10', after: '2026-01-01' });
      expect(where()).toEqual({
        OR: [
          { modelVersionId: { in: [10] } },
          { createdAt: { gte: new Date('2026-01-01') }, ...waitingForScan },
        ],
        type: { not: 'Training Data' },
      });
    });

    it('stamps the page as requested, and releases a file whose submit fails transiently', async () => {
      dbMock.dbRead.modelFile.findMany.mockResolvedValue(fileRows(2));
      dbMock.dbWrite.modelFile.update.mockResolvedValue({});
      mockCreateModelFileScanRequest
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('orchestrator 503'));

      await run({ after: '2026-01-01' });

      expect(dbMock.dbWrite.modelFile.updateMany).toHaveBeenCalledWith({
        where: { id: { in: [1, 2] } },
        data: { scanRequestedAt: NOW },
      });
      expect(dbMock.dbWrite.modelFile.update).toHaveBeenCalledTimes(1);
      expect(dbMock.dbWrite.modelFile.update).toHaveBeenCalledWith({
        where: { id: 2 },
        data: { scanRequestedAt: null },
      });
    });

    it('submits at most 500 files and returns a cursor for the next page', async () => {
      dbMock.dbRead.modelFile.findMany.mockResolvedValue(fileRows(501));

      const res = await run({ after: '2026-01-01' });

      expect(dbMock.dbRead.modelFile.findMany.mock.calls[0][0]).toMatchObject({
        take: 501,
        orderBy: { id: 'asc' },
      });
      expect(mockCreateModelFileScanRequest).toHaveBeenCalledTimes(500);
      expect(res.json).toHaveBeenCalledWith({
        files: 500,
        capped: true,
        nextAfterId: 500,
        failed: 0,
      });
    });

    it('reports an uncapped page with no cursor', async () => {
      dbMock.dbRead.modelFile.findMany.mockResolvedValue(fileRows(3));

      const res = await run({ after: '2026-01-01' });

      expect(res.json).toHaveBeenCalledWith({
        files: 3,
        capped: false,
        nextAfterId: null,
        failed: 0,
      });
    });

    it('resumes after the cursor without dropping a named-file filter', async () => {
      await run({ modelFileIds: '7,900', afterId: '500' });
      expect(where()).toEqual({
        id: { in: [7, 900] },
        type: { not: 'Training Data' },
        AND: [{ id: { gt: 500 } }],
      });
    });

    // Prisma matches nothing for `OR: []`, so passing the empty list made `all` a silent no-op.
    it('all=true selects without an empty OR', async () => {
      await run({ all: 'true' });
      expect(where()).toEqual({ ...waitingForScan, type: { not: 'Training Data' } });
    });

    it('never has more than 5 submissions in flight', async () => {
      dbMock.dbRead.modelFile.findMany.mockResolvedValue(fileRows(20));
      let inFlight = 0;
      let peak = 0;
      mockCreateModelFileScanRequest.mockImplementation(async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
      });

      await run({ after: '2026-01-01' });

      expect(mockCreateModelFileScanRequest).toHaveBeenCalledTimes(20);
      expect(peak).toBe(5);
    });
  });
});
