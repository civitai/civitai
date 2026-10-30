import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('../user-lookup.service', () => ({ getIdentity: vi.fn() }));
vi.mock('../user-actions.service', () => ({ getTimedMute: vi.fn() }));
const accountSectionFor = vi.fn();
vi.mock('../tickets/account', () => ({
  accountSectionFor: (...a: unknown[]) => accountSectionFor(...a),
}));

const { liveLoaders, loadersFor } = await import('../tickets/panels');

const ticket = {
  view: 'support' as const,
  cfFeature: 'Account Login',
  routerTopic: null,
  civitaiUserId: 7,
};

beforeEach(() => {
  accountSectionFor.mockReset().mockResolvedValue({ status: 'ok', userId: 7 });
});

describe('the live supportAccount loader', () => {
  it('is the only account read that asks for the read-only card', async () => {
    await liveLoaders.account(ticket, () => true);
    expect(accountSectionFor).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ readOnly: true })
    );
    await liveLoaders.supportAccount(ticket, () => true);
    expect(accountSectionFor).toHaveBeenLastCalledWith(
      expect.objectContaining({ readOnly: true, canView: true, civitaiUserId: 7 })
    );
  });

  it("carries the viewer's PII grant to the card, and defaults to none", async () => {
    await liveLoaders.supportAccount(ticket, () => true);
    expect(accountSectionFor).toHaveBeenLastCalledWith(
      expect.objectContaining({ canSeeEmail: false })
    );
    await loadersFor({ canSeeEmail: true }).supportAccount(ticket, () => true);
    expect(accountSectionFor).toHaveBeenLastCalledWith(
      expect.objectContaining({ canSeeEmail: true })
    );
  });
});
