import { beforeEach, describe, expect, it, vi } from 'vitest';

const { callModEndpoint } = vi.hoisted(() => ({ callModEndpoint: vi.fn() }));

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$lib/server/bounty-unpaid-award.service', () => ({
  RESOLVED_WINDOW_DAYS: 30,
  getUnpaidAwards: vi.fn(),
}));
vi.mock('$lib/server/user-actions.service', () => ({ callModEndpoint }));

const { actions } = await import('../+page.server');

const post = (fields: Record<string, string>) => {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return { request: new Request('http://x/bounties/unpaid-awards', { method: 'POST', body }) };
};
type ActionEvent = Parameters<(typeof actions)['resolve']>[0];
type Refusal = { status: number; data: { error: string; bountyId?: number; userId?: number } };
const resolve = (fields: Record<string, string>) =>
  actions.resolve(post(fields) as unknown as ActionEvent) as Promise<Record<string, unknown>>;

const fields = {
  bountyId: '4',
  userId: '5',
  ruling: 'refunded_supporter',
  ledgerReference: '  manual refund  ',
};

beforeEach(() => {
  vi.clearAllMocks();
  callModEndpoint.mockResolvedValue({ ok: true, body: { recorded: true } });
});

describe('unpaid bounty award ruling', () => {
  it('sends the ruling to the main app with the reference trimmed', async () => {
    expect(await resolve(fields)).toEqual({ success: true });
    expect(callModEndpoint).toHaveBeenCalledExactlyOnceWith(
      'bounty-unpaid-award/resolve',
      { bountyId: 4, userId: 5, ruling: 'refunded_supporter', ledgerReference: 'manual refund' },
      'Record ruling'
    );
  });

  it.each([
    ['a blank ledger reference', { ledgerReference: '   ' }, /ledger reference is required/],
    ['no ruling', { ruling: '' }, /Pick a ruling/],
    ['an unknown ruling', { ruling: 'split' }, /Pick a ruling/],
    ['no supporter', { userId: '' }, /Missing supporter id/],
  ])('refuses %s before calling the main app', async (_label, change, message) => {
    const result = (await resolve({ ...fields, ...change })) as unknown as Refusal;
    expect(result.status).toBe(400);
    expect(result.data.error).toMatch(message);
    expect(callModEndpoint).not.toHaveBeenCalled();
  });

  it("shows the main app's refusal against its bounty", async () => {
    callModEndpoint.mockResolvedValue({
      ok: false,
      error: 'Record ruling: That award is already resolved as paid_winner',
    });
    const result = (await resolve(fields)) as unknown as Refusal;
    expect(result.status).toBe(400);
    expect(result.data).toEqual({
      error: 'Record ruling: That award is already resolved as paid_winner',
      bountyId: 4,
      userId: 5,
    });
  });
});
