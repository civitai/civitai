import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * A6 (audit HIGH / design-gaps C2) — per-user scope-grant consent ledger.
 *
 * Pins the grant read/write semantics that the token-mint path relies on:
 *   - getGrantedScopes: missing row → empty; revoked → empty; active → set
 *   - recordScopeGrant: additive (existing grants persist), un-revokes,
 *     idempotent on the (user, app_block) unique index, P2002-race-safe
 *   - partitionByConsent: granted scopes sign; ungranted withheld; exempt
 *     scopes (block:settings:*, apps:storage:*) always sign
 */

const { mockDb } = vi.hoisted(() => {
  const db = {
    appUserScopeGrant: {
      findUnique: vi.fn<(...args: any[]) => Promise<any>>(),
      create: vi.fn<(...args: any[]) => Promise<any>>(),
      update: vi.fn<(...args: any[]) => Promise<any>>(),
    },
  };
  return { mockDb: db };
});

vi.mock('~/server/db/client', () => ({ dbRead: mockDb, dbWrite: mockDb }));

function resetAll() {
  for (const tbl of Object.values(mockDb)) {
    for (const fn of Object.values(tbl)) (fn as ReturnType<typeof vi.fn>).mockReset();
  }
}

describe('scope-grant.service', () => {
  beforeEach(resetAll);

  describe('getGrantedScopes', () => {
    it('returns the granted set for an active grant', async () => {
      mockDb.appUserScopeGrant.findUnique.mockResolvedValueOnce({
        grantedScopes: ['models:read:self', 'user:read:self'],
        revokedAt: null,
      });
      const { getGrantedScopes } = await import('../scope-grant.service');
      const set = await getGrantedScopes({ userId: 1, appBlockId: 'ab_x' });
      expect(set).toEqual(new Set(['models:read:self', 'user:read:self']));
    });

    it('returns empty set when no grant row exists (fail-closed)', async () => {
      mockDb.appUserScopeGrant.findUnique.mockResolvedValueOnce(null);
      const { getGrantedScopes } = await import('../scope-grant.service');
      const set = await getGrantedScopes({ userId: 1, appBlockId: 'ab_x' });
      expect(set.size).toBe(0);
    });

    it('returns empty set when the grant is revoked', async () => {
      mockDb.appUserScopeGrant.findUnique.mockResolvedValueOnce({
        grantedScopes: ['models:read:self'],
        revokedAt: new Date(),
      });
      const { getGrantedScopes } = await import('../scope-grant.service');
      const set = await getGrantedScopes({ userId: 1, appBlockId: 'ab_x' });
      expect(set.size).toBe(0);
    });
  });

  describe('recordScopeGrant', () => {
    it('creates a fresh grant row when none exists', async () => {
      mockDb.appUserScopeGrant.findUnique.mockResolvedValueOnce(null);
      mockDb.appUserScopeGrant.create.mockResolvedValueOnce({});
      const { recordScopeGrant } = await import('../scope-grant.service');
      await recordScopeGrant({
        userId: 1,
        appBlockId: 'ab_x',
        version: '1.0.0',
        scopes: ['models:read:self'],
      });
      expect(mockDb.appUserScopeGrant.create).toHaveBeenCalledTimes(1);
      const arg = mockDb.appUserScopeGrant.create.mock.calls[0][0];
      expect(arg.data.grantedScopes).toEqual(['models:read:self']);
      expect(arg.data.version).toBe('1.0.0');
      expect(arg.data.id).toMatch(/^augr_/);
    });

    it('is additive: merges new scopes into the existing grant + clears revokedAt', async () => {
      mockDb.appUserScopeGrant.findUnique.mockResolvedValueOnce({
        id: 'augr_1',
        grantedScopes: ['models:read:self'],
      });
      mockDb.appUserScopeGrant.update.mockResolvedValueOnce({});
      const { recordScopeGrant } = await import('../scope-grant.service');
      await recordScopeGrant({
        userId: 1,
        appBlockId: 'ab_x',
        version: '2.0.0',
        scopes: ['ai:write:budgeted'],
      });
      expect(mockDb.appUserScopeGrant.create).not.toHaveBeenCalled();
      const arg = mockDb.appUserScopeGrant.update.mock.calls[0][0];
      expect(new Set(arg.data.grantedScopes)).toEqual(
        new Set(['models:read:self', 'ai:write:budgeted'])
      );
      expect(arg.data.version).toBe('2.0.0');
      expect(arg.data.revokedAt).toBeNull();
    });

    it('recovers from a concurrent first-write P2002 race via additive update', async () => {
      // No row at first read → create → P2002 (a sibling won the race) →
      // re-read + merge.
      mockDb.appUserScopeGrant.findUnique
        .mockResolvedValueOnce(null) // initial read
        .mockResolvedValueOnce({ id: 'augr_race', grantedScopes: ['user:read:self'] }); // post-race read
      mockDb.appUserScopeGrant.create.mockRejectedValueOnce({ code: 'P2002' });
      mockDb.appUserScopeGrant.update.mockResolvedValueOnce({});
      const { recordScopeGrant } = await import('../scope-grant.service');
      await recordScopeGrant({
        userId: 1,
        appBlockId: 'ab_x',
        version: '1.0.0',
        scopes: ['models:read:self'],
      });
      const arg = mockDb.appUserScopeGrant.update.mock.calls[0][0];
      expect(new Set(arg.data.grantedScopes)).toEqual(
        new Set(['user:read:self', 'models:read:self'])
      );
    });
  });

  describe('partitionByConsent', () => {
    it('signs granted scopes; withholds ungranted ones', async () => {
      const { partitionByConsent } = await import('../scope-grant.service');
      const granted = new Set(['models:read:self']);
      const { signable, missing } = partitionByConsent(
        ['models:read:self', 'ai:write:budgeted'],
        granted
      );
      expect(signable).toEqual(['models:read:self']);
      expect(missing).toEqual(['ai:write:budgeted']);
    });

    it('always signs consent-exempt scopes (block:settings:*, apps:storage:*, models:read:self)', async () => {
      const { partitionByConsent } = await import('../scope-grant.service');
      const { signable, missing } = partitionByConsent(
        ['block:settings:read', 'apps:storage:write', 'models:read:self'],
        new Set() // user granted nothing
      );
      // models:read:self is consent-exempt (allow-by-default, 01ea90441), so all
      // three sign with no grant and nothing is withheld.
      expect(new Set(signable)).toEqual(
        new Set(['block:settings:read', 'apps:storage:write', 'models:read:self'])
      );
      expect(missing).toEqual([]);
    });
  });

  describe('consentGatedScopes', () => {
    it('drops the consent-exempt scopes so the implicit grant only stores gated ones', async () => {
      const { consentGatedScopes } = await import('../scope-grant.service');
      // models:read:self is consent-exempt (01ea90441), so it's dropped here
      // alongside block:settings:* / apps:storage:* — only ai:write:budgeted is
      // gated and kept.
      expect(
        consentGatedScopes([
          'models:read:self',
          'block:settings:read',
          'apps:storage:read',
          'ai:write:budgeted',
        ])
      ).toEqual(['ai:write:budgeted']);
    });
  });
});
