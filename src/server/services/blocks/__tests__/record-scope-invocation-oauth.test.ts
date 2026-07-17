import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unified scope-usage audit — `recordScopeInvocation` external-OAuth arm.
 *
 * An external OAuth access token's scope-gated call records into the SAME table
 * as an App-Block block-token, tagged `source: 'external-oauth'` with the acting
 * `oauthClientId` (and NO appBlockId / blockInstanceId — a pure OAuth app has no
 * block). The existing block-token call site must stay byte-identical (no new
 * keys; `source` falls to the DB default), so consumers of block rows are
 * unaffected and there is no double-emit.
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

describe('recordScopeInvocation — external OAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbWrite.blockScopeInvocation.create.mockResolvedValue({});
  });

  it('writes ONE external-oauth row: oauthClientId + source, no appBlock/blockInstance keys', async () => {
    await recordScopeInvocation({
      userId: 42,
      oauthClientId: 'appblk-my-app',
      scope: 'ModelsRead',
      endpoint: 'model.getById',
      statusCode: 200,
      source: 'external-oauth',
    });
    expect(mockDbWrite.blockScopeInvocation.create).toHaveBeenCalledTimes(1);
    const data = mockDbWrite.blockScopeInvocation.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      userId: 42,
      oauthClientId: 'appblk-my-app',
      source: 'external-oauth',
      scope: 'ModelsRead',
      endpoint: 'model.getById',
      statusCode: 200,
    });
    // No block identifiers for a pure-OAuth invocation.
    expect(data.appBlockId).toBeUndefined();
    expect(data.blockInstanceId).toBeUndefined();
    expect(data.syntheticAppId).toBeUndefined();
    // Best-effort write succeeded → no failure log.
    expect(mockLog).not.toHaveBeenCalled();
  });

  it('the block-token call site is byte-identical (no oauthClientId / source keys)', async () => {
    await recordScopeInvocation({
      userId: 42,
      appBlockId: 'apb_1',
      blockInstanceId: 'bki_1',
      scope: 'user:read:self',
      endpoint: '/api/v1/blocks/me',
      statusCode: 200,
    });
    expect(mockDbWrite.blockScopeInvocation.create).toHaveBeenCalledWith({
      data: {
        userId: 42,
        appBlockId: 'apb_1',
        blockInstanceId: 'bki_1',
        scope: 'user:read:self',
        endpoint: '/api/v1/blocks/me',
        statusCode: 200,
      },
    });
  });

  it('swallows a sink failure so the API call is never affected', async () => {
    mockDbWrite.blockScopeInvocation.create.mockRejectedValueOnce(new Error('db down'));
    await expect(
      recordScopeInvocation({
        userId: 42,
        oauthClientId: 'appblk-my-app',
        scope: 'ModelsRead',
        endpoint: 'model.getById',
        statusCode: 200,
        source: 'external-oauth',
      })
    ).resolves.toBeUndefined();
    // A non-dev, non-synthetic failure logs once and does not retry.
    expect(mockDbWrite.blockScopeInvocation.create).toHaveBeenCalledTimes(1);
    expect(mockLog).toHaveBeenCalledTimes(1);
  });
});
