import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The resolve action is bound to `creatorServices.resolveDispute` through the REAL `requiresGrant`, so
 * what is pinned is that this action checks this grant before any Buzz decision is requested.
 */
vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$app/server', () => ({ getRequestEvent: vi.fn() }));

const { resolveDispute, listDisputes, listDealFiles } = vi.hoisted(() => ({
  resolveDispute: vi.fn(),
  listDisputes: vi.fn(),
  listDealFiles: vi.fn(),
}));
vi.mock('$lib/server/creator-services-disputes.service', () => ({
  resolveDispute,
  listDisputes,
  listDealFiles,
}));

const { actions } = await import('../+page.server');

const formEvent = (grants: Record<string, boolean>, fields: Record<string, string>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.append(k, v);
  return {
    request: { formData: async () => data },
    locals: { user: { id: 990000007 }, grants },
  } as unknown as Parameters<(typeof actions)['resolve']>[0];
};

const GRANTED = { 'creatorServices.resolveDispute': true };

beforeEach(() => vi.clearAllMocks());

describe('resolve action', () => {
  it('refuses a moderator without the grant, before reaching the service', async () => {
    const result = await actions.resolve(
      formEvent({ 'user.purge': true }, { dealId: '41', resolution: 'Refund' })
    );

    expect(result).toMatchObject({ status: 403, data: { scope: 'denied' } });
    expect(resolveDispute).not.toHaveBeenCalled();
  });

  it('sends exactly the deal, the resolution and a trimmed note', async () => {
    resolveDispute.mockResolvedValue({ ok: true, status: 'resolved', resolution: 'Refund' });

    const result = await actions.resolve(
      formEvent(GRANTED, { dealId: '41', resolution: 'Refund', note: '  seller never delivered ' })
    );

    expect(resolveDispute).toHaveBeenCalledWith({
      dealId: 41,
      resolution: 'Refund',
      note: 'seller never delivered',
    });
    expect(result).toEqual({
      success: true,
      dealId: 41,
      alreadyResolved: false,
      resolution: 'Refund',
    });
  });

  it('rejects a resolution outside Refund and Release without calling the service', async () => {
    const result = await actions.resolve(formEvent(GRANTED, { dealId: '41', resolution: 'Void' }));

    expect(result).toMatchObject({ status: 400 });
    expect(resolveDispute).not.toHaveBeenCalled();
  });

  it('carries a refused Release back with the server reason, as a failure', async () => {
    resolveDispute.mockResolvedValue({
      ok: false,
      refused: true,
      message:
        'The final files have not passed scanning. Refund, or clear the file in moderation first.',
    });

    const result = await actions.resolve(
      formEvent(GRANTED, { dealId: '41', resolution: 'Release' })
    );

    expect(result).toMatchObject({
      status: 409,
      data: {
        dealId: 41,
        releaseRefused: true,
        error: expect.stringContaining('Refund, or clear'),
      },
    });
  });

  it('reports an already-resolved deal as success with the EXISTING resolution', async () => {
    resolveDispute.mockResolvedValue({
      ok: true,
      status: 'already-resolved',
      resolution: 'Release',
    });

    const result = await actions.resolve(
      formEvent(GRANTED, { dealId: '41', resolution: 'Refund' })
    );

    expect(result).toEqual({
      success: true,
      dealId: 41,
      alreadyResolved: true,
      resolution: 'Release',
    });
  });

  it('reports a Release the payout claim sent back to review as held, not resolved', async () => {
    resolveDispute.mockResolvedValue({
      ok: true,
      status: 'held-for-review',
      reason: 'final_scan_failed',
    });

    const result = await actions.resolve(
      formEvent(GRANTED, { dealId: '41', resolution: 'Release' })
    );

    expect(result).toEqual({ success: true, dealId: 41, heldForReview: 'final_scan_failed' });
  });

  it('still says held when the server gave no reason', async () => {
    resolveDispute.mockResolvedValue({ ok: true, status: 'held-for-review', reason: null });

    const result = await actions.resolve(
      formEvent(GRANTED, { dealId: '41', resolution: 'Release' })
    );

    expect(result).toEqual({ success: true, dealId: 41, heldForReview: 'no reason recorded' });
  });

  it('fails a transport error without claiming success', async () => {
    resolveDispute.mockResolvedValue({ ok: false, error: 'Dispute resolution failed.' });

    const result = await actions.resolve(
      formEvent(GRANTED, { dealId: '41', resolution: 'Refund' })
    );

    expect(result).toMatchObject({ status: 502, data: { error: 'Dispute resolution failed.' } });
  });
});
