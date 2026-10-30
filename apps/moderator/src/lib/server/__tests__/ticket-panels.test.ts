import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('../user-lookup.service', () => ({ getIdentity: vi.fn() }));
vi.mock('../user-actions.service', () => ({ getTimedMute: vi.fn() }));

const { loadPanels } = await import('../tickets/panels');

const account = vi.fn();
const appeals = vi.fn();
const history = vi.fn();
const ratingDisputes = vi.fn();
const contentIssue = vi.fn();
const generator = vi.fn();
const lora = vi.fn();
const supportAccount = vi.fn();
const membership = vi.fn();
const loaders = {
  account: (...a: unknown[]) => account(...a),
  appeals: (...a: unknown[]) => appeals(...a),
  history: (...a: unknown[]) => history(...a),
  ratingDisputes: (...a: unknown[]) => ratingDisputes(...a),
  contentIssue: (...a: unknown[]) => contentIssue(...a),
  generator: (...a: unknown[]) => generator(...a),
  lora: (...a: unknown[]) => lora(...a),
  supportAccount: (...a: unknown[]) => supportAccount(...a),
  membership: (...a: unknown[]) => membership(...a),
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
  history.mockReset().mockResolvedValue({ status: 'ok', userId: 7 });
  ratingDisputes
    .mockReset()
    .mockResolvedValue({ status: 'ok', userId: 7, disputes: [], truncated: false });
  contentIssue.mockReset().mockResolvedValue({ status: 'ok', userId: 7 });
  generator.mockReset().mockResolvedValue({ status: 'ok', userId: 7 });
  lora.mockReset().mockResolvedValue({ status: 'ok', userId: 7 });
  supportAccount.mockReset().mockResolvedValue({ status: 'ok', userId: 7 });
  membership.mockReset().mockResolvedValue({ status: 'ok', userId: 7, subscription: null });
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

  it('shows the content panel on a support Content Related Issue ticket only', async () => {
    const content = { ...ticket, view: 'support' as const, cfFeature: 'Content Related Issue' };
    const res = await loadPanels(content, all, loaders);
    expect(Object.keys(res)).toEqual(['contentIssue']);
    expect(contentIssue).toHaveBeenCalledWith({ ...content, civitaiUserId: 7 }, all);
    expect(await loadPanels({ ...content, view: 'moderation' }, all, loaders)).toEqual({});
    expect(await loadPanels({ ...content, civitaiUserId: null }, all, loaders)).toEqual({
      contentIssue: { status: 'unlinked' },
    });
  });

  it('holds the content panel back from a viewer with neither of its page grants', async () => {
    const content = { ...ticket, view: 'support' as const, cfFeature: 'Content Related Issue' };
    const none = (p: string) => p !== '/reports/user' && p !== '/retool/user-lookup';
    expect(await loadPanels(content, none, loaders)).toEqual({});
    expect(await loadPanels(content, (p) => p === '/reports/user', loaders)).toHaveProperty(
      'contentIssue'
    );
    expect(await loadPanels(content, (p) => p === '/retool/user-lookup', loaders)).toHaveProperty(
      'contentIssue'
    );
  });

  it('shows the generator panel on a support Image Generator ticket only', async () => {
    const gen = { ...ticket, view: 'support' as const, cfFeature: 'Image Generator' };
    const res = await loadPanels(gen, all, loaders);
    expect(Object.keys(res)).toEqual(['generator']);
    expect(generator).toHaveBeenCalledWith({ ...gen, civitaiUserId: 7 }, all);
    expect(await loadPanels({ ...gen, view: 'moderation' }, all, loaders)).toEqual({});
    expect(await loadPanels({ ...gen, civitaiUserId: null }, all, loaders)).toEqual({
      generator: { status: 'unlinked' },
    });
  });

  it('holds the generator panel back from a viewer with neither of its page grants', async () => {
    const gen = { ...ticket, view: 'support' as const, cfFeature: 'Image Generator' };
    const none = (p: string) =>
      p !== '/audit/generator-restrictions' && p !== '/retool/user-lookup';
    expect(await loadPanels(gen, none, loaders)).toEqual({});
    expect(
      await loadPanels(gen, (p) => p === '/audit/generator-restrictions', loaders)
    ).toHaveProperty('generator');
    expect(await loadPanels(gen, (p) => p === '/retool/user-lookup', loaders)).toHaveProperty(
      'generator'
    );
  });

  it('shows the LoRA panel on a support LoRA Trainer ticket only, under the training models grant', async () => {
    const lt = { ...ticket, view: 'support' as const, cfFeature: 'LoRA Trainer' };
    const res = await loadPanels(lt, all, loaders);
    expect(Object.keys(res)).toEqual(['lora']);
    expect(lora).toHaveBeenCalledWith({ ...lt, civitaiUserId: 7 }, all);
    expect(await loadPanels({ ...lt, view: 'moderation' }, all, loaders)).toEqual({});
    expect(await loadPanels({ ...lt, civitaiUserId: null }, all, loaders)).toEqual({
      lora: { status: 'unlinked' },
    });
    expect(await loadPanels(lt, (p) => p !== '/audit/training-models', loaders)).toEqual({});
    expect(lora).toHaveBeenCalledTimes(1);
  });

  it.each(['Account Login', 'Email Change'])(
    'shows only the read-only account panel on a support %s ticket, under the User Lookup grant',
    async (cfFeature) => {
      const t = { ...ticket, view: 'support' as const, cfFeature };
      const res = await loadPanels(t, all, loaders);
      expect(Object.keys(res)).toEqual(['supportAccount']);
      expect(supportAccount).toHaveBeenCalledWith({ ...t, civitaiUserId: 7 }, all);
      expect(account).not.toHaveBeenCalled();
      expect(await loadPanels({ ...t, view: 'moderation' }, all, loaders)).toEqual({});
      expect(await loadPanels({ ...t, civitaiUserId: null }, all, loaders)).toEqual({
        supportAccount: { status: 'unlinked' },
      });
      expect(await loadPanels(t, (p) => p !== '/retool/user-lookup', loaders)).toEqual({});
    }
  );

  it('shows only the membership panel on a support Billing or Membership ticket, under the User Lookup grant', async () => {
    const t = { ...ticket, view: 'support' as const, cfFeature: 'Billing or Membership' };
    const res = await loadPanels(t, all, loaders);
    expect(Object.keys(res)).toEqual(['membership']);
    expect(membership).toHaveBeenCalledWith({ ...t, civitaiUserId: 7 }, all);
    expect(await loadPanels({ ...t, view: 'moderation' }, all, loaders)).toEqual({});
    expect(await loadPanels({ ...t, civitaiUserId: null }, all, loaders)).toEqual({
      membership: { status: 'unlinked' },
    });
    expect(await loadPanels(t, (p) => p !== '/retool/user-lookup', loaders)).toEqual({});
    expect(membership).toHaveBeenCalledTimes(1);
  });

  it('says only that no user is linked, without loading', async () => {
    expect(await loadPanels({ ...ticket, civitaiUserId: null }, all, loaders)).toEqual({
      account: { status: 'unlinked' },
      appeals: { status: 'unlinked' },
      history: { status: 'unlinked' },
      ratingDisputes: { status: 'unlinked' },
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
      history: { status: 'unlinked' },
      ratingDisputes: { status: 'unlinked' },
    });
  });

  it('is hidden from a viewer who holds no appeal queue, and shown to one who holds any', async () => {
    const none = (p: string) =>
      !p.startsWith('/images/') &&
      !p.startsWith('/models/') &&
      !p.startsWith('/appeals/') &&
      p !== '/retool/user-lookup' &&
      p !== '/ratings';
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

describe('the history and rating disputes panels', () => {
  const decision = { ...ticket, cfFeature: 'Moderation Decision' };
  const only = (path: string) => (p: string) => p === path;

  it('show on the tickets the Appeals card shows on, not elsewhere', async () => {
    const res = await loadPanels(decision, all, loaders);
    expect(res).toHaveProperty('history');
    expect(res).toHaveProperty('ratingDisputes');
    const other = await loadPanels({ ...decision, cfFeature: 'Billing' }, all, loaders);
    expect(other).toEqual({});
    expect(history).toHaveBeenCalledTimes(1);
    expect(ratingDisputes).toHaveBeenCalledTimes(1);
  });

  it('are each held back from a viewer without their own grant, without loading', async () => {
    const lookup = await loadPanels(decision, only('/retool/user-lookup'), loaders);
    expect(lookup).toHaveProperty('history');
    expect(lookup).not.toHaveProperty('ratingDisputes');
    const ratings = await loadPanels(decision, only('/ratings'), loaders);
    expect(ratings).toHaveProperty('ratingDisputes');
    expect(ratings).not.toHaveProperty('history');
    expect(history).toHaveBeenCalledTimes(1);
    expect(ratingDisputes).toHaveBeenCalledTimes(1);
  });

  it('become unavailable when their read throws, leaving the others alone', async () => {
    history.mockRejectedValue(new Error('db down'));
    ratingDisputes.mockRejectedValue(new Error('db down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await loadPanels(decision, all, loaders);
    expect(res.history).toEqual({ status: 'unavailable', userId: 7 });
    expect(res.ratingDisputes).toEqual({ status: 'unavailable', userId: 7 });
    expect(res.appeals).toMatchObject({ status: 'ok' });
  });
});
