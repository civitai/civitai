import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ grant: vi.fn(), audit: vi.fn() }));
vi.mock('~/server/services/moderator-grants', () => ({ hasModeratorGrant: m.grant }));
vi.mock('~/server/services/moderator.service', () => ({ trackModActivity: m.audit }));

import { RELEASE_REFUSALS, releaseForModerator } from '../release-endpoint';

const actor = { id: 9, roles: ['moderator:support'] };
const release = vi.fn();

beforeEach(() => {
  for (const f of [m.grant, m.audit, release]) f.mockReset();
  m.grant.mockResolvedValue(true);
  release.mockResolvedValue({ ok: true, userId: 42, expiresAt: new Date('2026-11-08T00:00:00Z') });
});

describe('release endpoint handler', () => {
  it('refuses without the release permission, before anything is released', async () => {
    m.grant.mockResolvedValue(false);
    await expect(releaseForModerator(actor, 5, release)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(m.grant).toHaveBeenCalledWith(actor, 'user.personalDataExport.release');
    expect(release).not.toHaveBeenCalled();
  });

  it('releases as the acting moderator and audits it against the owner', async () => {
    expect(await releaseForModerator(actor, 5, release)).toMatchObject({
      exportId: 5,
      released: true,
      linkExpiresAt: '2026-11-08T00:00:00.000Z',
    });
    expect(release).toHaveBeenCalledWith({ exportId: 5, actorId: 9 });
    expect(m.audit.mock.calls).toEqual([
      [9, { entityType: 'user', entityId: 42, activity: 'releasePersonalDataExport' }],
    ]);
  });

  it('answers a held export with the neutral wording, and an unreadable check with try again', async () => {
    release.mockResolvedValue({ ok: false, reason: 'held' });
    await expect(releaseForModerator(actor, 5, release)).rejects.toThrow(RELEASE_REFUSALS.held);
    expect(RELEASE_REFUSALS.held).not.toMatch(/report|image|marker|evidence/i);
    release.mockResolvedValue({ ok: false, reason: 'unconfirmed' });
    await expect(releaseForModerator(actor, 5, release)).rejects.toThrow(/try again/);
    expect(m.audit).not.toHaveBeenCalled();
  });

  it('still reports the release when the audit write fails, and says the audit is missing', async () => {
    m.audit.mockRejectedValue(new Error('db down'));
    expect(await releaseForModerator(actor, 5, release)).toMatchObject({
      released: true,
      auditRecorded: false,
    });
  });

  it('answers an unknown export as not found', async () => {
    release.mockResolvedValue({ ok: false, reason: 'not-found' });
    await expect(releaseForModerator(actor, 5, release)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
