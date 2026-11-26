import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The gift panel's actions are bound to `user.membership.gift.comp` through the REAL `requiresGrant`:
 * holding the revoke/refund gift grant does not open comping.
 */
vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$app/server', () => ({ getRequestEvent: vi.fn() }));

const { previewCompGift, compGift } = vi.hoisted(() => ({
  previewCompGift: vi.fn(async () => ({ ok: true as const, preview: { outcome: 'would-comp' } })),
  compGift: vi.fn(async () => ({ ok: true as const, result: { outcome: 'comped', giftId: 'g1' } })),
}));
vi.mock('$lib/server/user-actions.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/user-actions.service')>()),
  previewCompGift,
  compGift,
}));

const { actions } = await import('../+page.server');

const TARGET = 990100034;
const fields = {
  userId: String(TARGET),
  tier: 'gold',
  months: '3',
  reason: 'Thank-you for community work',
  message: '',
};

const formEvent = (grants: Record<string, boolean>, f: Record<string, string>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(f)) data.append(k, v);
  return {
    request: { formData: async () => data },
    locals: { user: { id: 990000007 }, grants },
  } as unknown as Parameters<(typeof actions)['compGift']>[0];
};

beforeEach(() => vi.clearAllMocks());

describe('comp gift actions', () => {
  it('refuses a moderator holding only user.membership.gift', async () => {
    const result = await actions.compGift(formEvent({ 'user.membership.gift': true }, fields));
    expect(result).toMatchObject({ status: 403, data: { scope: 'denied' } });
    expect(compGift).not.toHaveBeenCalled();
  });

  it('comps with the grant, sending the parsed form', async () => {
    const result = await actions.compGift(
      formEvent({ 'user.membership.gift.comp': true }, { ...fields, anonymous: 'on' })
    );
    expect(result).toMatchObject({ success: true, comped: { giftId: 'g1' } });
    expect(compGift).toHaveBeenCalledWith({
      userId: TARGET,
      tier: 'gold',
      months: 3,
      reason: 'Thank-you for community work',
      message: undefined,
      anonymous: true,
    });
  });

  it('previews without the anonymous box ticked as not anonymous', async () => {
    await actions.previewCompGift(formEvent({ 'user.membership.gift.comp': true }, fields));
    expect(previewCompGift).toHaveBeenCalledWith(expect.objectContaining({ anonymous: false }));
  });

  it('shows the main app refusal instead of reporting success', async () => {
    compGift.mockResolvedValueOnce({ ok: false, error: 'This user is muted.' } as never);
    const result = await actions.compGift(formEvent({ 'user.membership.gift.comp': true }, fields));
    expect(result).toMatchObject({
      status: 400,
      data: { scope: 'compGift', error: 'This user is muted.' },
    });
  });
});
