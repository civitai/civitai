import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A refund or removal that committed but could not refresh the main app's caches comes back as a
 * success with a `warning`; the action has to hand it to the panel, which shows it.
 */
vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$app/server', () => ({ getRequestEvent: vi.fn() }));

const WARNING = "Refunded. The site's caches didn't refresh.";
const { refundShopPurchase, removeCosmetic } = vi.hoisted(() => ({
  refundShopPurchase: vi.fn(),
  removeCosmetic: vi.fn(),
}));
vi.mock('$lib/server/user-actions.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/user-actions.service')>()),
  refundShopPurchase,
  removeCosmetic,
}));

const { actions } = await import('../+page.server');

const formEvent = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.append(k, v);
  return {
    request: { formData: async () => data },
    // The admin role reaches every page, so `canAccess` lets the action through.
    locals: { user: { id: 990000007, roles: ['moderator:admin'] }, grants: {} },
  } as unknown as Parameters<(typeof actions)['refundPurchase']>[0];
};

beforeEach(() => {
  vi.clearAllMocks();
  refundShopPurchase.mockResolvedValue({ ok: true, warning: WARNING });
  removeCosmetic.mockResolvedValue({ ok: true, warning: WARNING });
});

describe('take-back actions pass the warning to the panel', () => {
  it('refundPurchase', async () => {
    await expect(
      actions.refundPurchase(formEvent({ userId: '8675309', buzzTransactionId: 'tx-1' }))
    ).resolves.toEqual({ success: true, warning: WARNING });
  });

  it('removeCosmetic', async () => {
    await expect(
      actions.removeCosmetic(
        formEvent({ userId: '8675309', cosmeticId: '700', claimKey: 'claimed' })
      )
    ).resolves.toEqual({ success: true, warning: WARNING });
  });
});
