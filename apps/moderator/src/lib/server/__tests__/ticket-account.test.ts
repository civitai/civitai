import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('../user-lookup.service', () => ({ getIdentity: vi.fn() }));
vi.mock('../user-actions.service', () => ({ getTimedMute: vi.fn() }));

const { accountSectionFor } = await import('../tickets/account');

const identity = vi.fn();
const timedMute = vi.fn();
const restrictions = vi.fn();
const pendingAppeal = vi.fn();
const reads = { identity, timedMute, restrictions, pendingAppeal };

const ticket = {
  view: 'moderation' as const,
  cfFeature: 'Account Restriction or Banned Account' as string | null,
  routerTopic: null as string | null,
  civitaiUserId: 7 as number | null,
  canView: true,
};

beforeEach(() => {
  identity.mockReset().mockResolvedValue({
    id: 7,
    username: 'ann',
    email: 'ann@example.test',
    bannedAt: new Date('2026-10-01T00:00:00Z'),
    banReason: 'Harassment',
    muted: true,
  });
  timedMute.mockReset().mockResolvedValue(null);
  restrictions.mockReset().mockResolvedValue([]);
  pendingAppeal.mockReset().mockResolvedValue(null);
});

describe('accountSectionFor', () => {
  it('is omitted when the viewer cannot open User Lookup, without reading the account', async () => {
    expect(await accountSectionFor({ ...ticket, canView: false }, reads)).toBeUndefined();
    expect(identity).not.toHaveBeenCalled();
  });

  it('is omitted for tickets the rule excludes, without reading the account', async () => {
    expect(
      await accountSectionFor({ ...ticket, cfFeature: 'Moderation Decision' }, reads)
    ).toBeUndefined();
    expect(await accountSectionFor({ ...ticket, view: 'support' }, reads)).toBeUndefined();
    expect(identity).not.toHaveBeenCalled();
  });

  it('says no account is linked, without reading anything', async () => {
    expect(await accountSectionFor({ ...ticket, civitaiUserId: null }, reads)).toEqual({
      status: 'unlinked',
    });
    expect(identity).not.toHaveBeenCalled();
  });

  it('reports ban, mute and restrictions, never the address', async () => {
    timedMute.mockResolvedValue({
      muteExpiresAt: new Date('2026-11-01T00:00:00Z'),
      source: 'moderator',
      reason: 'spam',
    });
    restrictions.mockResolvedValue([
      { id: 3, type: 'generation', status: 'Pending', createdAt: new Date('2026-10-02T00:00:00Z') },
      {
        id: 2,
        type: 'bot-account',
        status: 'Pending',
        createdAt: new Date('2026-10-01T00:00:00Z'),
      },
      { id: 1, type: 'generation', status: 'Upheld', createdAt: new Date('2026-09-01T00:00:00Z') },
    ]);
    const res = await accountSectionFor(ticket, reads);
    expect(res).toMatchObject({
      status: 'ok',
      userId: 7,
      username: 'ann',
      banned: { since: '2026-10-01T00:00:00.000Z', reason: 'Harassment' },
      muted: true,
      timedMute: { until: '2026-11-01T00:00:00.000Z', source: 'moderator', reason: 'spam' },
    });
    expect(JSON.stringify(res)).not.toContain('example.test');
    const rows = res && res.status === 'ok' ? res.restrictions : [];
    expect(rows.map((r) => [r.id, r.rulable])).toEqual([
      [3, true],
      [2, false],
      [1, false],
    ]);
  });

  it('degrades to unavailable when a read fails, or the account is gone', async () => {
    identity.mockRejectedValueOnce(new Error('db down'));
    expect(await accountSectionFor(ticket, reads)).toEqual({ status: 'unavailable', userId: 7 });
    identity.mockResolvedValueOnce(null);
    expect(await accountSectionFor(ticket, reads)).toEqual({ status: 'unavailable', userId: 7 });
  });
});

describe('the pending Account appeal', () => {
  const found = {
    id: 12,
    createdAt: new Date('2026-10-20T00:00:00Z'),
    appealMessage: 'I was hacked',
  };

  it('is read only for a viewer holding /appeals/account, and left off otherwise', async () => {
    pendingAppeal.mockResolvedValue(found);
    const without = await accountSectionFor(ticket, reads);
    expect(without).not.toHaveProperty('pendingAppeal');
    expect(pendingAppeal).not.toHaveBeenCalled();

    const res = await accountSectionFor({ ...ticket, canAppeal: true }, reads);
    expect(pendingAppeal).toHaveBeenCalledWith(7);
    expect(res).toMatchObject({
      status: 'ok',
      pendingAppeal: { id: 12, createdAt: '2026-10-20T00:00:00.000Z', message: 'I was hacked' },
    });
  });

  it('is null when there is none', async () => {
    const res = await accountSectionFor({ ...ticket, canAppeal: true }, reads);
    expect(res).toMatchObject({ status: 'ok', pendingAppeal: null });
  });

  it('does not take the account down when only the appeal read fails', async () => {
    pendingAppeal.mockRejectedValue(new Error('db'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await accountSectionFor({ ...ticket, canAppeal: true }, reads);
    expect(res).toMatchObject({ status: 'ok', username: 'ann', pendingAppeal: null });
  });
});

describe('accountSectionFor, read-only (support)', () => {
  const support = {
    ...ticket,
    view: 'support' as const,
    cfFeature: 'Account Login',
    readOnly: true,
    canSeeEmail: true,
  };

  it('is omitted without readOnly: the moderation rule still hides every support ticket', async () => {
    expect(await accountSectionFor({ ...support, readOnly: false }, reads)).toBeUndefined();
  });

  it('is omitted for a feature other than Account Login or Email Change, and in the moderation view', async () => {
    expect(await accountSectionFor({ ...support, cfFeature: 'Billing' }, reads)).toBeUndefined();
    expect(await accountSectionFor({ ...support, view: 'moderation' }, reads)).toBeUndefined();
    expect(identity).not.toHaveBeenCalled();
  });

  it('carries the email and its verified date, and no appeal or rulable restriction', async () => {
    identity.mockResolvedValue({
      id: 7,
      username: 'ann',
      email: 'ann@example.test',
      emailVerified: new Date('2026-09-01T00:00:00Z'),
      bannedAt: null,
      banReason: null,
      muted: false,
    });
    restrictions.mockResolvedValue([
      { id: 3, type: 'generation', status: 'Pending', createdAt: new Date('2026-10-02T00:00:00Z') },
    ]);
    const res = await accountSectionFor({ ...support, canAppeal: true }, reads);
    expect(res).toMatchObject({
      status: 'ok',
      userId: 7,
      email: 'ann@example.test',
      emailVerified: '2026-09-01T00:00:00.000Z',
      restrictions: [{ id: 3, rulable: false }],
    });
    expect(res).not.toHaveProperty('pendingAppeal');
    expect(pendingAppeal).not.toHaveBeenCalled();
  });

  it('leaves the address out without the PII grant, keeping the verified date', async () => {
    identity.mockResolvedValue({
      id: 7,
      username: 'ann',
      email: 'ann@example.test',
      emailVerified: new Date('2026-09-01T00:00:00Z'),
    });
    const res = await accountSectionFor({ ...support, canSeeEmail: false }, reads);
    expect(res).toMatchObject({ status: 'ok', emailVerified: '2026-09-01T00:00:00.000Z' });
    expect(res).not.toHaveProperty('email');
    expect(JSON.stringify(res)).not.toContain('example.test');
  });

  it('reads an unverified address as null, and the moderation card never carries the address', async () => {
    identity.mockResolvedValue({ id: 7, username: 'ann', email: 'a@b.test', emailVerified: null });
    expect(await accountSectionFor(support, reads)).toMatchObject({
      email: 'a@b.test',
      emailVerified: null,
    });
    const mod = await accountSectionFor(ticket, reads);
    expect(mod).not.toHaveProperty('email');
    expect(mod).not.toHaveProperty('emailVerified');
  });
});
