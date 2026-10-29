import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('../user-lookup.service', () => ({ getIdentity: vi.fn() }));
vi.mock('../user-actions.service', () => ({ getTimedMute: vi.fn() }));

const { loadPanels } = await import('../tickets/panels');

const account = vi.fn();
const loaders = { account: (...a: unknown[]) => account(...a) } as never;
const all = () => true;

const ticket = {
  view: 'moderation' as const,
  cfFeature: 'Account Restriction or Banned Account' as string | null,
  routerTopic: null as string | null,
  civitaiUserId: 7 as number | null,
};

beforeEach(() => {
  account.mockReset().mockResolvedValue({ status: 'ok', userId: 7 });
});

describe('loadPanels', () => {
  it('loads a panel that applies, for the linked user', async () => {
    expect(await loadPanels(ticket, all, loaders)).toEqual({
      account: { status: 'ok', userId: 7 },
    });
    expect(account).toHaveBeenCalledWith({ ...ticket, civitaiUserId: 7 }, all);
  });

  it('leaves out a panel the viewer holds no read grant for, without loading it', async () => {
    const canRead = (p: string) => p !== '/retool/user-lookup';
    expect(await loadPanels(ticket, canRead, loaders)).toEqual({});
    expect(account).not.toHaveBeenCalled();
  });

  it('leaves out tickets the panel does not apply to: other features and the support view', async () => {
    expect(await loadPanels({ ...ticket, cfFeature: 'Moderation Decision' }, all, loaders)).toEqual(
      {}
    );
    expect(await loadPanels({ ...ticket, view: 'support' }, all, loaders)).toEqual({});
    expect(account).not.toHaveBeenCalled();
  });

  it('says only that no user is linked, without loading', async () => {
    expect(await loadPanels({ ...ticket, civitaiUserId: null }, all, loaders)).toEqual({
      account: { status: 'unlinked' },
    });
    expect(account).not.toHaveBeenCalled();
  });

  it('turns a failing loader into an unavailable panel instead of failing the ticket', async () => {
    account.mockRejectedValue(new Error('db down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await loadPanels(ticket, all, loaders)).toEqual({
      account: { status: 'unavailable', userId: 7 },
    });
  });
});
