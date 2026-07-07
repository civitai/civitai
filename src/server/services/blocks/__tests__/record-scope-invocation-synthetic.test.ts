import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PHASE 2 — durable per-spend audit for PRE-APPROVAL dev-tunnel spends.
 *
 * recordScopeInvocation writes one BlockScopeInvocation row per scope-gated call.
 * A pre-approval dev-tunnel token carries a SYNTHETIC, non-FK `appBlockId`
 * (`ephemeral-<slug>`) that FK-fails the INSERT. With `dev:true` the write RETRIES
 * with `appBlockId: null` + `syntheticAppId`, so the audit row PERSISTS instead of
 * being swallowed. A non-dev FK orphan keeps the historical "log, no row" path.
 */

const { mockDbWrite, mockLog } = vi.hoisted(() => ({
  mockDbWrite: {
    blockScopeInvocation: { create: vi.fn<(...args: any[]) => Promise<any>>() },
  },
  mockLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('~/server/db/client', () => ({ dbRead: {}, dbWrite: mockDbWrite }));
vi.mock('~/server/logging/client', () => ({ logToAxiom: mockLog }));

import { recordScopeInvocation } from '~/server/services/blocks/user-app-surface.service';

// Mimic a Prisma FK violation (P2003).
function fkError() {
  return Object.assign(new Error('FK violation'), { code: 'P2003' });
}

const BASE = {
  userId: 99,
  blockInstanceId: 'page_ephemeral-my-app',
  scope: 'ai:write:budgeted',
  endpoint: 'workflow:submit:wf_1',
  statusCode: 200,
};

describe('recordScopeInvocation — synthetic pre-approval dev spend', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('a REAL appBlockId writes once with the FK value (no retry, no synthetic column)', async () => {
    mockDbWrite.blockScopeInvocation.create.mockResolvedValueOnce({});
    await recordScopeInvocation({ ...BASE, appBlockId: 'apb_real', dev: true });
    expect(mockDbWrite.blockScopeInvocation.create).toHaveBeenCalledTimes(1);
    const data = mockDbWrite.blockScopeInvocation.create.mock.calls[0][0].data;
    expect(data.appBlockId).toBe('apb_real');
    expect(data.syntheticAppId).toBeUndefined();
  });

  it('dev token + synthetic appBlockId FK-fails → RETRIES with appBlockId:null + syntheticAppId (row persists)', async () => {
    mockDbWrite.blockScopeInvocation.create
      .mockRejectedValueOnce(fkError()) // first attempt: FK violation on the synthetic id
      .mockResolvedValueOnce({}); // retry: persists
    await recordScopeInvocation({ ...BASE, appBlockId: 'ephemeral-my-app', dev: true });
    expect(mockDbWrite.blockScopeInvocation.create).toHaveBeenCalledTimes(2);
    const retry = mockDbWrite.blockScopeInvocation.create.mock.calls[1][0].data;
    expect(retry.appBlockId).toBeNull();
    expect(retry.syntheticAppId).toBe('ephemeral-my-app');
    expect(retry.scope).toBe('ai:write:budgeted');
    // The audit log is NOT fired — the retry succeeded.
    expect(mockLog).not.toHaveBeenCalled();
  });

  it('NON-dev FK orphan does NOT retry — historical "log, no row" behaviour is preserved', async () => {
    mockDbWrite.blockScopeInvocation.create.mockRejectedValueOnce(fkError());
    await recordScopeInvocation({ ...BASE, appBlockId: 'apb_deleted', dev: false });
    expect(mockDbWrite.blockScopeInvocation.create).toHaveBeenCalledTimes(1);
    expect(mockLog).toHaveBeenCalledTimes(1);
  });

  it('dev token whose synthetic RETRY also fails → best-effort log, never throws', async () => {
    mockDbWrite.blockScopeInvocation.create
      .mockRejectedValueOnce(fkError())
      .mockRejectedValueOnce(new Error('db down'));
    await expect(
      recordScopeInvocation({ ...BASE, appBlockId: 'ephemeral-my-app', dev: true })
    ).resolves.toBeUndefined();
    expect(mockDbWrite.blockScopeInvocation.create).toHaveBeenCalledTimes(2);
    expect(mockLog).toHaveBeenCalledTimes(1);
  });
});
