import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * W13 — listMyScopeInvocations SELECTs + returns the new `detail` column. A valid
 * structured detail round-trips; a legacy NULL or garbage value comes back as
 * `detail: null` so the view falls back to the scope · endpoint rendering.
 */

const { mockDbRead } = vi.hoisted(() => ({
  mockDbRead: {
    blockScopeInvocation: { findMany: vi.fn<(...args: any[]) => Promise<any>>() },
  },
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: {} }));
vi.mock('~/server/logging/client', () => ({ logToAxiom: vi.fn(async () => undefined) }));

import { listMyScopeInvocations } from '~/server/services/blocks/user-app-surface.service';

function row(over: Record<string, unknown> = {}) {
  return {
    id: 1n,
    invokedAt: new Date('2026-07-16T00:00:00Z'),
    appBlockId: 'apb_1',
    blockInstanceId: 'bki_1',
    scope: 'social:tip:self',
    endpoint: 'tip',
    statusCode: 200,
    detail: null,
    appBlock: { blockId: 'my-app', manifest: { name: 'My App' } },
    ...over,
  };
}

describe('listMyScopeInvocations — detail round-trip', () => {
  beforeEach(() => vi.clearAllMocks());

  it('selects the detail column', async () => {
    mockDbRead.blockScopeInvocation.findMany.mockResolvedValueOnce([]);
    await listMyScopeInvocations({ userId: 42 });
    const args = mockDbRead.blockScopeInvocation.findMany.mock.calls[0][0];
    expect(args.select.detail).toBe(true);
  });

  it('returns a valid structured detail unchanged', async () => {
    const detail = { action: 'tip', amount: 500, toUserId: 7, outcome: 'ok' };
    mockDbRead.blockScopeInvocation.findMany.mockResolvedValueOnce([row({ detail })]);
    const { items } = await listMyScopeInvocations({ userId: 42 });
    expect(items[0].detail).toEqual(detail);
  });

  it('coerces a legacy NULL detail to null', async () => {
    mockDbRead.blockScopeInvocation.findMany.mockResolvedValueOnce([row({ detail: null })]);
    const { items } = await listMyScopeInvocations({ userId: 42 });
    expect(items[0].detail).toBeNull();
  });

  it('coerces a garbage (no-action) detail to null', async () => {
    mockDbRead.blockScopeInvocation.findMany.mockResolvedValueOnce([row({ detail: { x: 1 } })]);
    const { items } = await listMyScopeInvocations({ userId: 42 });
    expect(items[0].detail).toBeNull();
  });
});
