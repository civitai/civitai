import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isFlipt: vi.fn(async () => false),
  backfillScoreTierBatch: vi.fn(async () => ({ users: 0, inserted: 0, lastUserId: null })),
  grantMilestoneCosmeticsBatch: vi.fn(async () => ({ users: 0, inserted: 0, lastUserId: null })),
  previewScoreTierBackfill: vi.fn(async () => ({ users: 1, rows: 2 })),
}));

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: mocks.isFlipt,
}));
vi.mock('~/server/services/creator-milestone-grant.service', async (importOriginal) => ({
  ...(await importOriginal<typeof GrantService>()),
  backfillScoreTierBatch: mocks.backfillScoreTierBatch,
  grantMilestoneCosmeticsBatch: mocks.grantMilestoneCosmeticsBatch,
  previewScoreTierBackfill: mocks.previewScoreTierBackfill,
}));

import type * as FliptClient from '~/server/flipt/client';
import type * as GrantService from '~/server/services/creator-milestone-grant.service';
import handler from '~/pages/api/admin/temp/backfill-creator-milestones';

function call(query: Record<string, string>) {
  let status = 200;
  let body: unknown;
  const res = {
    status(code: number) {
      status = code;
      return res;
    },
    json(payload: unknown) {
      body = payload;
      return res;
    },
    setHeader: () => res,
    end: () => res,
  };
  const req = { method: 'GET', headers: {}, query: { token: 'test-webhook-token', ...query } };
  return (handler as (req: unknown, res: unknown) => Promise<unknown>)(req, res).then(() => ({
    status,
    body,
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isFlipt.mockResolvedValue(false);
});

describe('backfill-creator-milestones while Creator Journey is not public', () => {
  it('refuses to write tier grants', async () => {
    const { status } = await call({ dryRun: 'false' });
    expect(status).toBe(409);
    expect(mocks.backfillScoreTierBatch).not.toHaveBeenCalled();
  });

  it('still answers a dry run', async () => {
    const { status, body } = await call({});
    expect(status).toBe(200);
    expect(body).toMatchObject({ wouldGrant: { users: 1, rows: 2 } });
  });

  it('does not block granting cosmetics to existing holders', async () => {
    const { status } = await call({ action: 'cosmetics', dryRun: 'false' });
    expect(status).toBe(200);
    expect(mocks.grantMilestoneCosmeticsBatch).toHaveBeenCalled();
  });

  // The write path below this guard is the score-tier backfill, so falling through would run that.
  it('refuses to write activity grants itself, even with the flag public', async () => {
    mocks.isFlipt.mockResolvedValue(true);
    const { status } = await call({ action: 'activity', dryRun: 'false' });
    expect(status).toBe(400);
    expect(mocks.backfillScoreTierBatch).not.toHaveBeenCalled();
    expect(mocks.grantMilestoneCosmeticsBatch).not.toHaveBeenCalled();
  });

  it('writes tier grants once the flag is public', async () => {
    mocks.isFlipt.mockResolvedValue(true);
    const { status } = await call({ dryRun: 'false' });
    expect(status).toBe(200);
    expect(mocks.backfillScoreTierBatch).toHaveBeenCalled();
  });
});
