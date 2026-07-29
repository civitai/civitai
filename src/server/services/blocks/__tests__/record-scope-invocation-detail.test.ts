import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * W13 — recordScopeInvocation writes the structured `detail` JSON onto the audit
 * row when a mutation handler passes one, and writes a plain (detail-less) row
 * otherwise. A malformed detail is dropped rather than poisoning the INSERT. The
 * detail also rides the synthetic-appId retry path (pre-approval dev spend).
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
import type { BlockActionDetail } from '~/shared/constants/block-action-detail';

function fkError() {
  return Object.assign(new Error('FK violation'), { code: 'P2003' });
}

const BASE = {
  userId: 42,
  appBlockId: 'apb_real',
  blockInstanceId: 'bki_1',
  scope: 'social:tip:self',
  endpoint: 'tip',
  statusCode: 200,
};

describe('recordScopeInvocation — structured detail', () => {
  beforeEach(() => vi.clearAllMocks());

  it('writes the detail JSON when a mutation passes one', async () => {
    mockDbWrite.blockScopeInvocation.create.mockResolvedValueOnce({});
    const detail: BlockActionDetail = { action: 'tip', amount: 500, toUserId: 7, outcome: 'ok' };
    await recordScopeInvocation({ ...BASE, detail });
    const data = mockDbWrite.blockScopeInvocation.create.mock.calls[0][0].data;
    expect(data.detail).toEqual(detail);
  });

  it('omits detail (plain row) when none is passed', async () => {
    mockDbWrite.blockScopeInvocation.create.mockResolvedValueOnce({});
    await recordScopeInvocation({ ...BASE });
    const data = mockDbWrite.blockScopeInvocation.create.mock.calls[0][0].data;
    expect('detail' in data).toBe(false);
  });

  it('drops a malformed detail (no action) → plain row, no throw', async () => {
    mockDbWrite.blockScopeInvocation.create.mockResolvedValueOnce({});
    await recordScopeInvocation({
      ...BASE,
      detail: { foo: 'bar' } as unknown as BlockActionDetail,
    });
    const data = mockDbWrite.blockScopeInvocation.create.mock.calls[0][0].data;
    expect('detail' in data).toBe(false);
  });

  it('carries the detail onto the synthetic-appId retry (pre-approval dev spend)', async () => {
    mockDbWrite.blockScopeInvocation.create
      .mockRejectedValueOnce(fkError()) // synthetic id FK-fails
      .mockResolvedValueOnce({}); // retry persists
    const detail: BlockActionDetail = { action: 'workflow.submit', amount: -120, outcome: 'ok' };
    await recordScopeInvocation({
      ...BASE,
      appBlockId: 'ephemeral-my-app',
      scope: 'ai:write:budgeted',
      endpoint: 'workflow:submit:wf_1',
      dev: true,
      detail,
    });
    expect(mockDbWrite.blockScopeInvocation.create).toHaveBeenCalledTimes(2);
    const retry = mockDbWrite.blockScopeInvocation.create.mock.calls[1][0].data;
    expect(retry.appBlockId).toBeNull();
    expect(retry.syntheticAppId).toBe('ephemeral-my-app');
    expect(retry.detail).toEqual(detail);
  });
});
