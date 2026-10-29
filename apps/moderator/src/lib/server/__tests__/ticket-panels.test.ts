import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('../user-lookup.service', () => ({ getIdentity: vi.fn() }));
vi.mock('../user-actions.service', () => ({ getTimedMute: vi.fn() }));

const { loadPanels } = await import('../tickets/panels');

const account = vi.fn();
const appeals = vi.fn();
const loaders = {
  account: (...a: unknown[]) => account(...a),
  appeals: (...a: unknown[]) => appeals(...a),
} as never;
const all = () => true;

const ticket = {
  view: 'moderation' as const,
  cfFeature: 'Account Restriction or Banned Account' as string | null,
  routerTopic: null as string | null,
  civitaiUserId: 7 as number | null,
};

beforeEach(() => {
  account.mockReset().mockResolvedValue({ status: 'ok', userId: 7 });
  appeals.mockReset().mockResolvedValue({ status: 'ok', userId: 7, appeals: [], truncated: false });
});

describe('loadPanels', () => {
  it('loads a panel that applies, for the linked user', async () => {
    const res = await loadPanels(ticket, all, loaders);
    expect(res.account).toEqual({ status: 'ok', userId: 7 });
    expect(account).toHaveBeenCalledWith({ ...ticket, civitaiUserId: 7 }, all);
  });

  it('leaves out a panel the viewer holds no read grant for, without loading it', async () => {
    const canRead = (p: string) => p !== '/retool/user-lookup';
    const res = await loadPanels(ticket, canRead, loaders);
    expect(res).not.toHaveProperty('account');
    expect(account).not.toHaveBeenCalled();
  });

  it('leaves out tickets the panel does not apply to: other features and the support view', async () => {
    const decision = await loadPanels(
      { ...ticket, cfFeature: 'Moderation Decision' },
      all,
      loaders
    );
    expect(decision).not.toHaveProperty('account');
    expect(await loadPanels({ ...ticket, view: 'support' }, all, loaders)).toEqual({});
    expect(account).not.toHaveBeenCalled();
  });

  it('says only that no user is linked, without loading', async () => {
    expect(await loadPanels({ ...ticket, civitaiUserId: null }, all, loaders)).toEqual({
      account: { status: 'unlinked' },
      appeals: { status: 'unlinked' },
    });
    expect(account).not.toHaveBeenCalled();
    expect(appeals).not.toHaveBeenCalled();
  });

  it('turns a failing loader into an unavailable panel instead of failing the ticket', async () => {
    account.mockRejectedValue(new Error('db down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await loadPanels(ticket, all, loaders);
    expect(res.account).toEqual({ status: 'unavailable', userId: 7 });
    expect(res.appeals).toMatchObject({ status: 'ok' });
  });
});

describe('the appeals panel', () => {
  const decision = { ...ticket, cfFeature: 'Moderation Decision', text: 'civitai.com/images/1' };

  it('shows for both moderation features, handing the loader the ticket text', async () => {
    expect(await loadPanels(decision, all, loaders)).toHaveProperty('appeals');
    expect(appeals).toHaveBeenLastCalledWith({ ...decision, civitaiUserId: 7 }, all);
    expect(await loadPanels(ticket, all, loaders)).toHaveProperty('appeals');
  });

  it('is left out of other features, other topics and the support view', async () => {
    const other = { ...decision, cfFeature: 'Billing' };
    expect(await loadPanels(other, all, loaders)).toEqual({});
    expect(
      await loadPanels({ ...other, routerTopic: 'account-issue' }, all, loaders)
    ).toHaveProperty('account');
    expect(
      await loadPanels({ ...other, routerTopic: 'account-issue' }, all, loaders)
    ).not.toHaveProperty('appeals');
    expect(await loadPanels({ ...decision, view: 'support' }, all, loaders)).toEqual({});
    expect(appeals).not.toHaveBeenCalled();
  });

  it('shows for a ticket with no feature whose router topic is an appeal topic', async () => {
    for (const routerTopic of ['image-moderation-appeal', 'nsfw-moderation']) {
      appeals.mockClear();
      const res = await loadPanels({ ...decision, cfFeature: null, routerTopic }, all, loaders);
      expect(res).toHaveProperty('appeals');
      expect(appeals).toHaveBeenCalledTimes(1);
    }
    expect(
      await loadPanels({ ...decision, cfFeature: null, routerTopic: 'billing' }, all, loaders)
    ).toEqual({});
  });

  it('says only that no user is linked for a Moderation Decision with none', async () => {
    expect(await loadPanels({ ...decision, civitaiUserId: null }, all, loaders)).toEqual({
      appeals: { status: 'unlinked' },
    });
  });

  it('is hidden from a viewer who holds no appeal queue, and shown to one who holds any', async () => {
    const none = (p: string) =>
      !p.startsWith('/images/') && !p.startsWith('/models/') && !p.startsWith('/appeals/');
    expect(await loadPanels(decision, none, loaders)).toEqual({});
    const one = (p: string) => p === '/appeals/other';
    expect(await loadPanels(decision, one, loaders)).toHaveProperty('appeals');
  });

  it('becomes unavailable when its read fails, leaving the account panel alone', async () => {
    appeals.mockRejectedValue(new Error('db down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await loadPanels(ticket, all, loaders);
    expect(res.appeals).toEqual({ status: 'unavailable', userId: 7 });
    expect(res.account).toMatchObject({ status: 'ok' });
  });
});
