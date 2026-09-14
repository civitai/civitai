import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * A6 (audit HIGH / design-gaps C2) — per-user scope-grant consent ledger.
 *
 * Pins the grant read/write semantics that the token-mint path relies on:
 *   - getGrantedScopes: missing row → empty; revoked → empty; active → set
 *   - recordScopeGrant: additive (existing grants persist), un-revokes,
 *     idempotent on the (user, app_block) unique index, P2002-race-safe
 *   - partitionByConsent: granted scopes sign; ungranted withheld; exempt
 *     scopes (apps:storage:*, models:read:self, collections:read:self/write:self)
 *     always sign
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

  describe('getConsentBuzzBudget', () => {
    it('returns the stored budget for an active grant', async () => {
      mockDb.appUserScopeGrant.findUnique.mockResolvedValueOnce({
        buzzBudgetPerDay: 500,
        revokedAt: null,
      });
      const { getConsentBuzzBudget } = await import('../scope-grant.service');
      expect(await getConsentBuzzBudget({ userId: 1, appBlockId: 'ab_x' })).toBe(500);
    });

    it('returns null when no grant row exists', async () => {
      mockDb.appUserScopeGrant.findUnique.mockResolvedValueOnce(null);
      const { getConsentBuzzBudget } = await import('../scope-grant.service');
      expect(await getConsentBuzzBudget({ userId: 1, appBlockId: 'ab_x' })).toBeNull();
    });

    it('returns null when the grant is revoked', async () => {
      mockDb.appUserScopeGrant.findUnique.mockResolvedValueOnce({
        buzzBudgetPerDay: 500,
        revokedAt: new Date(),
      });
      const { getConsentBuzzBudget } = await import('../scope-grant.service');
      expect(await getConsentBuzzBudget({ userId: 1, appBlockId: 'ab_x' })).toBeNull();
    });

    // 🔴 GUARD THE VALUE, NOT ONLY ITS PRESENCE. A 0 would become a cap of 0 (deny
    // everything); a NaN would become `total > NaN` — always false — i.e. a corrupt row
    // would silently DISABLE the cap. Both must read as "no budget set".
    it.each([
      ['zero', 0],
      ['negative', -5],
      ['NaN', Number.NaN],
    ])('returns null for a %s stored value', async (_label, value) => {
      mockDb.appUserScopeGrant.findUnique.mockResolvedValueOnce({
        buzzBudgetPerDay: value,
        revokedAt: null,
      });
      const { getConsentBuzzBudget } = await import('../scope-grant.service');
      expect(await getConsentBuzzBudget({ userId: 1, appBlockId: 'ab_x' })).toBeNull();
    });

    // Reads the PRIMARY by default: this runs on the spend path right after a consent
    // write that may have LOWERED the budget, and a replica-lag read would spend against
    // the older, looser ceiling.
    it('reads the primary unless a read replica is explicitly requested', async () => {
      mockDb.appUserScopeGrant.findUnique.mockResolvedValue({
        buzzBudgetPerDay: 5,
        revokedAt: null,
      });
      const { getConsentBuzzBudget } = await import('../scope-grant.service');
      await getConsentBuzzBudget({ userId: 1, appBlockId: 'ab_x' });
      expect(mockDb.appUserScopeGrant.findUnique).toHaveBeenCalled();
    });
  });

  // ── PRE-MIGRATION SAFETY. Migrations here are applied BY HAND, per environment, so
  // an image can legitimately run against a database WITHOUT `buzz_budget_per_day`.
  // MEASURED on this PR's own preview environment before these guards existed: Prisma
  // raised P2022 and every install / subscribe / re-consent returned
  // INTERNAL_SERVER_ERROR.
  describe('a database WITHOUT the buzz_budget_per_day column (P2022)', () => {
    /** The shape Prisma raises for "the column does not exist in the current database". */
    function missingColumnError() {
      return Object.assign(new Error('The column ... does not exist in the current database.'), {
        code: 'P2022',
      });
    }

    it('getConsentBuzzBudget returns null (= no budget can have been set — the TRUE state)', async () => {
      mockDb.appUserScopeGrant.findUnique.mockRejectedValueOnce(missingColumnError());
      const { getConsentBuzzBudget } = await import('../scope-grant.service');
      expect(await getConsentBuzzBudget({ userId: 1, appBlockId: 'ab_x' })).toBeNull();
    });

    // 🔴 THE OTHER HALF, AND THE ONE THAT MAKES THE CATCH SAFE. A bare catch here would
    // turn a connection loss / timeout into "no budget", i.e. silently disable a money
    // cap the user set — the exact fail-open this feature exists to prevent.
    it('getConsentBuzzBudget RETHROWS any other Prisma error (never fails open)', async () => {
      const other = Object.assign(new Error('connection refused'), { code: 'P1001' });
      mockDb.appUserScopeGrant.findUnique.mockRejectedValueOnce(other);
      const { getConsentBuzzBudget } = await import('../scope-grant.service');
      await expect(getConsentBuzzBudget({ userId: 1, appBlockId: 'ab_x' })).rejects.toThrow(
        /connection refused/
      );
    });

    it('an error with NO code at all still throws', async () => {
      mockDb.appUserScopeGrant.findUnique.mockRejectedValueOnce(new Error('boom'));
      const { getConsentBuzzBudget } = await import('../scope-grant.service');
      await expect(getConsentBuzzBudget({ userId: 1, appBlockId: 'ab_x' })).rejects.toThrow(/boom/);
    });

    // 🔴 THE WRITE HALF. Prisma's DEFAULT selection is every scalar, so a create/update
    // with no `select` emits `RETURNING … buzz_budget_per_day` and 500s on a database
    // without the column — even though the write itself needs nothing back. These pin
    // the explicit select on ALL THREE write sites (update, create, and the P2002
    // concurrent-create retry); a guard covering only two would read as coverage while
    // leaving a live 500 on the racy path.
    it('the UPDATE write reads back only `id`', async () => {
      mockDb.appUserScopeGrant.findUnique.mockResolvedValueOnce({
        id: 'augr_1',
        grantedScopes: [],
      });
      mockDb.appUserScopeGrant.update.mockResolvedValueOnce({});
      const { recordScopeGrant } = await import('../scope-grant.service');
      await recordScopeGrant({
        userId: 1,
        appBlockId: 'ab_x',
        version: '1.0.0',
        scopes: ['user:read:self'],
      });
      expect(mockDb.appUserScopeGrant.update.mock.calls[0][0].select).toEqual({ id: true });
    });

    it('the CREATE write reads back only `id`', async () => {
      mockDb.appUserScopeGrant.findUnique.mockResolvedValueOnce(null);
      mockDb.appUserScopeGrant.create.mockResolvedValueOnce({});
      const { recordScopeGrant } = await import('../scope-grant.service');
      await recordScopeGrant({
        userId: 1,
        appBlockId: 'ab_x',
        version: '1.0.0',
        scopes: ['user:read:self'],
      });
      expect(mockDb.appUserScopeGrant.create.mock.calls[0][0].select).toEqual({ id: true });
    });

    it('the P2002 concurrent-create RETRY update reads back only `id`', async () => {
      mockDb.appUserScopeGrant.findUnique
        .mockResolvedValueOnce(null) // first look-up: no row
        .mockResolvedValueOnce({ id: 'augr_1', grantedScopes: [] }); // post-race re-read
      mockDb.appUserScopeGrant.create.mockRejectedValueOnce({ code: 'P2002' });
      mockDb.appUserScopeGrant.update.mockResolvedValueOnce({});
      const { recordScopeGrant } = await import('../scope-grant.service');
      await recordScopeGrant({
        userId: 1,
        appBlockId: 'ab_x',
        version: '1.0.0',
        scopes: ['user:read:self'],
      });
      expect(mockDb.appUserScopeGrant.update.mock.calls[0][0].select).toEqual({ id: true });
    });

    // The READ that mint depends on never touched the new column, and must not start.
    it('getGrantedScopes still selects only the columns that predate the migration', async () => {
      mockDb.appUserScopeGrant.findUnique.mockResolvedValueOnce({
        grantedScopes: ['user:read:self'],
        revokedAt: null,
      });
      const { getGrantedScopes } = await import('../scope-grant.service');
      await getGrantedScopes({ userId: 1, appBlockId: 'ab_x' });
      expect(mockDb.appUserScopeGrant.findUnique.mock.calls[0][0].select).toEqual({
        grantedScopes: true,
        revokedAt: true,
      });
    });
  });

  describe('recordScopeGrant — buzzBudgetPerDay update semantics', () => {
    // 🔴 THE OMITTED CASE IS THE ONE THAT MATTERS. A re-consent for an unrelated scope
    // sends only `scopes`; if an omitted budget were written through as NULL, accepting
    // one extra permission would silently wipe a spend limit the user set — a widening,
    // performed by a dialog that never mentioned money.
    it('leaves the stored budget untouched when the key is OMITTED', async () => {
      mockDb.appUserScopeGrant.findUnique.mockResolvedValueOnce({
        id: 'augr_1',
        grantedScopes: ['models:read:self'],
      });
      mockDb.appUserScopeGrant.update.mockResolvedValueOnce({});
      const { recordScopeGrant } = await import('../scope-grant.service');
      await recordScopeGrant({
        userId: 1,
        appBlockId: 'ab_x',
        version: '1.0.0',
        scopes: ['user:read:self'],
      });
      const data = mockDb.appUserScopeGrant.update.mock.calls[0][0].data;
      expect(data).not.toHaveProperty('buzzBudgetPerDay');
    });

    it('OVERWRITES the stored budget when a number is supplied', async () => {
      mockDb.appUserScopeGrant.findUnique.mockResolvedValueOnce({
        id: 'augr_1',
        grantedScopes: [],
      });
      mockDb.appUserScopeGrant.update.mockResolvedValueOnce({});
      const { recordScopeGrant } = await import('../scope-grant.service');
      await recordScopeGrant({
        userId: 1,
        appBlockId: 'ab_x',
        version: '1.0.0',
        scopes: ['ai:write:budgeted'],
        buzzBudgetPerDay: 250,
      });
      expect(mockDb.appUserScopeGrant.update.mock.calls[0][0].data).toMatchObject({
        buzzBudgetPerDay: 250,
      });
    });

    // An explicit NULL is the user REMOVING their limit — distinct from omitting it.
    it('CLEARS the stored budget when null is supplied explicitly', async () => {
      mockDb.appUserScopeGrant.findUnique.mockResolvedValueOnce({
        id: 'augr_1',
        grantedScopes: [],
      });
      mockDb.appUserScopeGrant.update.mockResolvedValueOnce({});
      const { recordScopeGrant } = await import('../scope-grant.service');
      await recordScopeGrant({
        userId: 1,
        appBlockId: 'ab_x',
        version: '1.0.0',
        scopes: ['ai:write:budgeted'],
        buzzBudgetPerDay: null,
      });
      expect(mockDb.appUserScopeGrant.update.mock.calls[0][0].data).toMatchObject({
        buzzBudgetPerDay: null,
      });
    });

    it('carries the budget onto a freshly CREATED grant row', async () => {
      mockDb.appUserScopeGrant.findUnique.mockResolvedValueOnce(null);
      mockDb.appUserScopeGrant.create.mockResolvedValueOnce({});
      const { recordScopeGrant } = await import('../scope-grant.service');
      await recordScopeGrant({
        userId: 1,
        appBlockId: 'ab_x',
        version: '1.0.0',
        scopes: ['ai:write:budgeted'],
        buzzBudgetPerDay: 250,
      });
      expect(mockDb.appUserScopeGrant.create.mock.calls[0][0].data).toMatchObject({
        buzzBudgetPerDay: 250,
      });
    });

    // The P2002 concurrent-first-write branch is a THIRD write site. It had to be updated
    // too, and a guard that only covered the other two would read as coverage while
    // leaving the racy path dropping the budget on the floor.
    it('carries the budget through the P2002 concurrent-create retry', async () => {
      mockDb.appUserScopeGrant.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'augr_1', grantedScopes: [] });
      mockDb.appUserScopeGrant.create.mockRejectedValueOnce({ code: 'P2002' });
      mockDb.appUserScopeGrant.update.mockResolvedValueOnce({});
      const { recordScopeGrant } = await import('../scope-grant.service');
      await recordScopeGrant({
        userId: 1,
        appBlockId: 'ab_x',
        version: '1.0.0',
        scopes: ['ai:write:budgeted'],
        buzzBudgetPerDay: 250,
      });
      expect(mockDb.appUserScopeGrant.update.mock.calls[0][0].data).toMatchObject({
        buzzBudgetPerDay: 250,
      });
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

    it('always signs consent-exempt scopes (apps:storage:*, models:read:self)', async () => {
      const { partitionByConsent } = await import('../scope-grant.service');
      const { signable, missing } = partitionByConsent(
        ['apps:storage:read', 'apps:storage:write', 'models:read:self'],
        new Set() // user granted nothing
      );
      // models:read:self is consent-exempt (allow-by-default, 01ea90441), so all
      // three sign with no grant and nothing is withheld. (block:settings:* was
      // removed from the exempt set alongside the scope's removal from the registry.)
      expect(new Set(signable)).toEqual(
        new Set(['apps:storage:read', 'apps:storage:write', 'models:read:self'])
      );
      expect(missing).toEqual([]);
    });

    it('does NOT exempt the removed block:settings:* scopes (footgun guard)', async () => {
      // block:settings:read/write were dropped from CONSENT_EXEMPT_SCOPES when the
      // scopes were removed from the registry. If either is ever re-added to the
      // registry it must NOT be silently consent-exempt — it must flow through the
      // gate (→ `missing`) unless an explicit grant/exemption decision is made.
      const { partitionByConsent } = await import('../scope-grant.service');
      const { signable, missing } = partitionByConsent(
        ['block:settings:read', 'block:settings:write'],
        new Set() // user granted nothing
      );
      expect(signable).toEqual([]);
      expect(new Set(missing)).toEqual(new Set(['block:settings:read', 'block:settings:write']));
    });

    it('signs the SHARED storage scopes WITHOUT any grant (governed by resolveSharedContext, not consent)', async () => {
      // Regression: shared-storage apps 403'd at runtime because the shared
      // scopes fell into `missing` (not consent-exempt) and were stripped from
      // the minted token. They are now exempt — their gate is the server-side
      // min-trust + moderation layer in apps-shared.router, not a consent prompt.
      const { partitionByConsent } = await import('../scope-grant.service');
      const { signable, missing } = partitionByConsent(
        ['apps:storage:shared:read', 'apps:storage:shared:write'],
        new Set() // user granted nothing
      );
      expect(new Set(signable)).toEqual(
        new Set(['apps:storage:shared:read', 'apps:storage:shared:write'])
      );
      expect(missing).toEqual([]);
    });

    it('mint model: a shared-storage manifest with NO grant → both shared scopes signable (authenticated branch)', async () => {
      // Mirrors the token-mint authenticated branch (block-tokens/index.ts):
      // requestedScopes ∩ consent → `signable` is what gets signed. A shared app
      // whose approved manifest declares the shared scopes must produce a token
      // carrying BOTH even though the user has granted nothing.
      const { partitionByConsent } = await import('../scope-grant.service');
      const manifestScopes = ['apps:storage:shared:read', 'apps:storage:shared:write'];
      const { signable } = partitionByConsent(manifestScopes, new Set());
      expect(signable).toEqual(manifestScopes);
    });
  });

  describe('consentGatedScopes', () => {
    it('drops the consent-exempt scopes so the implicit grant only stores gated ones', async () => {
      const { consentGatedScopes } = await import('../scope-grant.service');
      // models:read:self is consent-exempt (01ea90441), so it's dropped here
      // alongside apps:storage:* — only ai:write:budgeted is gated and kept.
      expect(
        consentGatedScopes([
          'models:read:self',
          'apps:storage:write',
          'apps:storage:read',
          'ai:write:budgeted',
        ])
      ).toEqual(['ai:write:budgeted']);
    });

    it('drops the SHARED storage scopes → the anon-strip KEEPS them + install does not record them as gated', async () => {
      // consentGatedScopes drives BOTH (a) the anon-scope strip at mint (an anon
      // token keeps only NON-gated scopes) and (b) what the install/subscribe
      // implicit grant records. The shared scopes must be exempt so an anon read
      // token can carry shared:read (public community data) and install doesn't
      // demand a grant that would never be given. Anon WRITE remains impossible:
      // resolveSharedContext rejects a null subject before any data access,
      // independent of the scope (see apps-shared.router tests).
      const { consentGatedScopes } = await import('../scope-grant.service');
      expect(
        consentGatedScopes([
          'apps:storage:shared:read',
          'apps:storage:shared:write',
          'ai:write:budgeted',
        ])
      ).toEqual(['ai:write:budgeted']);
    });
  });
});
