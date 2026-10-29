import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('../user-lookup.service', () => ({ getIdentity: vi.fn() }));
vi.mock('../user-actions.service', () => ({ getTimedMute: vi.fn() }));

const { accountSectionFor } = await import('../tickets/account');

const identity = vi.fn();
const timedMute = vi.fn();
const restrictions = vi.fn();
const reads = { identity, timedMute, restrictions };

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
