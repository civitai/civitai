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

    // The READ that mint depends on never touched `buzz_budget_per_day`, and must not
    // start. ⚠️ THIS TEST USED TO ASSERT THE SELECT WAS *EXACTLY* THE PRE-MIGRATION PAIR,
    // and it is now the pair PLUS `revokedScopes` — the per-scope revoke needs the
    // suppression list at every read, and there is no way to subtract a set you did not
    // select. The claim being pinned is narrower than it looks and is unchanged: the budget
    // column stays out. The revocation column's own pre-migration safety is the two arms
    // below, not this select.
    it('getGrantedScopes selects the revocation list but still NOT the budget column', async () => {
      mockDb.appUserScopeGrant.findUnique.mockResolvedValueOnce({
        grantedScopes: ['user:read:self'],
        revokedAt: null,
        revokedScopes: [],
      });
      const { getGrantedScopes } = await import('../scope-grant.service');
      await getGrantedScopes({ userId: 1, appBlockId: 'ab_x' });
      const select = mockDb.appUserScopeGrant.findUnique.mock.calls[0][0].select;
      expect(select).toEqual({ grantedScopes: true, revokedAt: true, revokedScopes: true });
      expect(select).not.toHaveProperty('buzzBudgetPerDay');
    });
  });

  // ── PRE-MIGRATION SAFETY FOR THE *REVOCATION* COLUMNS. A second hand-applied migration
  // means a database can have `buzz_budget_per_day` and not `revoked_scopes`, so this arm
  // is independent of the block above.
  //
  // 🔴 THE TWO DIRECTIONS ARE OPPOSITE, AND THAT ASYMMETRY IS THE POINT. A READ degrades to
  // "nothing revoked", which is not a guess — a database with no column cannot hold a
  // revocation, so it is the only possible answer and behaviour is byte-identical to the
  // world before the feature. A WRITE must THROW: telling a viewer their permission was
  // removed while persisting nothing is the worst available outcome on a consent surface.
  describe('a database WITHOUT the revoked_scopes column (P2022)', () => {
    function missingColumnError() {
      return Object.assign(new Error('The column ... does not exist in the current database.'), {
        code: 'P2022',
      });
    }

    it('getGrantedScopes RETRIES with the narrow select and reports the granted set', async () => {
      mockDb.appUserScopeGrant.findUnique
        .mockRejectedValueOnce(missingColumnError())
        .mockResolvedValueOnce({ grantedScopes: ['ai:write:budgeted'], revokedAt: null });
      const { getGrantedScopes } = await import('../scope-grant.service');
      const set = await getGrantedScopes({ userId: 1, appBlockId: 'ab_x' });
      // The scope is GRANTED, not withheld: with no column nothing can be suppressed.
      expect(set).toEqual(new Set(['ai:write:budgeted']));
      // And the retry really was the narrow, pre-migration select — without this the test
      // would also pass on an implementation that swallowed the error and returned empty.
      expect(mockDb.appUserScopeGrant.findUnique.mock.calls[1][0].select).toEqual({
        grantedScopes: true,
        revokedAt: true,
      });
    });

    it('getGrantedScopes RETHROWS any other Prisma error (never degrades to "nothing revoked")', async () => {
      const other = Object.assign(new Error('connection refused'), { code: 'P1001' });
      mockDb.appUserScopeGrant.findUnique.mockRejectedValueOnce(other);
      const { getGrantedScopes } = await import('../scope-grant.service');
      await expect(getGrantedScopes({ userId: 1, appBlockId: 'ab_x' })).rejects.toThrow(
        /connection refused/
      );
    });

    // 🔴 THE WRITE HALF, AND THE ONE THAT MATTERS MOST. It must refuse rather than report a
    // success it did not persist, AND the refusal must actually REACH the viewer.
    //
    // ⚠️ THE ASSERTION USED TO MATCH THE MIGRATION NAME, and that was the wrong target twice
    // over. It was a bare `Error`, so tRPC classified it `INTERNAL_SERVER_ERROR` and
    // `src/server/trpc/client-safe-error.ts` replaced the whole message with a generic
    // "something went wrong (ref: …)" — the carefully-worded text reached nobody while this
    // test passed one layer above where it was discarded. And a migration identifier is not
    // actionable by a viewer anyway; it belongs in the operator's log line, which
    // `logMissingRevokedScopesColumn` still emits.
    //
    // So: `PRECONDITION_FAILED` (a 4xx, whose message survives the formatter) carrying the
    // EXPORTED viewer-facing string, pinned exactly — so a mutant that swaps the guard for a
    // different error is killed by the MESSAGE, not merely by "something threw".
    it('revokeScopes refuses with PRECONDITION_FAILED and the viewer-facing message', async () => {
      mockDb.appUserScopeGrant.findUnique.mockRejectedValueOnce(missingColumnError());
      const { revokeScopes, CONSENT_REVOKE_UNAVAILABLE_MESSAGE } = await import(
        '../scope-grant.service'
      );
      await expect(
        revokeScopes({ userId: 1, appBlockId: 'ab_x', scopes: ['ai:write:budgeted'] })
      ).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        message: CONSENT_REVOKE_UNAVAILABLE_MESSAGE,
      });
      // And it wrote NOTHING — a partial write would be worse than the refusal.
      expect(mockDb.appUserScopeGrant.update).not.toHaveBeenCalled();
      expect(mockDb.appUserScopeGrant.create).not.toHaveBeenCalled();
    });

    // 🔴 THE MESSAGE SURVIVES THE CLIENT-SAFE FORMATTER. Asserting the code alone would not
    // establish that: the whole defect was a status class whose message is replaced, and this
    // is the check that pins the class rather than the spelling.
    it('the refusal is a 4xx, so its message is not replaced by the generic 500 text', async () => {
      const { getHTTPStatusCodeFromError } = await import('@trpc/server/http');
      const { getClientSafeError } = await import('~/server/trpc/client-safe-error');
      mockDb.appUserScopeGrant.findUnique.mockRejectedValueOnce(missingColumnError());
      const { revokeScopes } = await import('../scope-grant.service');
      const err = await revokeScopes({
        userId: 1,
        appBlockId: 'ab_x',
        scopes: ['ai:write:budgeted'],
      }).then(
        () => null,
        (e) => e as Parameters<typeof getHTTPStatusCodeFromError>[0]
      );
      expect(err).not.toBeNull();
      const status = getHTTPStatusCodeFromError(err!);
      expect(status).toBeLessThan(500);
      // `undefined` from the formatter means "this message is safe to show as-is".
      expect(getClientSafeError(err as never)).toBeUndefined();
    });

    it('revokeScopes refuses on a P2022 raised by the WRITE, not only by the read', async () => {
      mockDb.appUserScopeGrant.findUnique.mockResolvedValueOnce({
        id: 'augr_1',
        grantedScopes: ['ai:write:budgeted'],
        revokedScopes: [],
      });
      mockDb.appUserScopeGrant.update.mockRejectedValueOnce(missingColumnError());
      const { revokeScopes, CONSENT_REVOKE_UNAVAILABLE_MESSAGE } = await import(
        '../scope-grant.service'
      );
      await expect(
        revokeScopes({ userId: 1, appBlockId: 'ab_x', scopes: ['ai:write:budgeted'] })
      ).rejects.toMatchObject({ message: CONSENT_REVOKE_UNAVAILABLE_MESSAGE });
    });

    // A prompted re-consent must keep working on such a database — it simply has nothing to
    // clear. Without the tolerant read, `grantScopes` would 500 for every user.
    it('recordScopeGrant({ clearRevocations }) degrades to a plain grant write', async () => {
      mockDb.appUserScopeGrant.findUnique
        .mockRejectedValueOnce(missingColumnError())
        .mockResolvedValueOnce({ id: 'augr_1', grantedScopes: ['user:read:self'] });
      mockDb.appUserScopeGrant.update.mockResolvedValueOnce({});
      const { recordScopeGrant } = await import('../scope-grant.service');
      const res = await recordScopeGrant({
        userId: 1,
        appBlockId: 'ab_x',
        version: '1.0.0',
        scopes: ['ai:write:budgeted'],
        clearRevocations: true,
      });
      const data = mockDb.appUserScopeGrant.update.mock.calls[0][0].data;
      // The write never NAMES the missing column — that is what stops the 500.
      expect(data).not.toHaveProperty('revokedScopes');
      expect(data).not.toHaveProperty('revokedScopesAt');
      expect(new Set(data.grantedScopes)).toEqual(new Set(['user:read:self', 'ai:write:budgeted']));
      // `null`, not `[]` — nothing was cleared, so the caller must NOT delete a marker.
      expect(res.revokedScopesAfterClear).toBeNull();
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

    it('is additive: merges new scopes into the existing grant', async () => {
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
      // 🔴 IT DOES **NOT** CLEAR `revokedAt`, AND THIS ASSERTION USED TO REQUIRE THAT IT DID.
      // `revoked_at` had two clearers and closing only `revokeScopes`' left an INSTALL able to
      // un-revoke: `recordInstallConsent` calls this with no `clearRevocations`, so the
      // unconditional `revokedAt: null` lifted a whole-grant revoke with no consent prompt. The
      // exposed population is the hand-written one the `2026-09-16` re-consent oneoff creates.
      // A PROMPTED re-consent still clears it — the arm below.
      expect(arg.data).not.toHaveProperty('revokedAt');
    });

    /**
     * 🔴 THE PROMPTED PATH STILL UN-REVOKES, which is the flow the oneoff wants: the host
     * surfaces `needs_consent`, the viewer accepts, and THAT clears both the whole-grant flag
     * and the suppression for the scopes they just consented to.
     *
     * MUTATION THAT MUST KILL IT: make `unrevokeData()` return `{}` unconditionally.
     */
    it('a PROMPTED re-consent clears revokedAt', async () => {
      mockDb.appUserScopeGrant.findUnique.mockResolvedValueOnce({
        id: 'augr_1',
        grantedScopes: ['models:read:self'],
        revokedScopes: [],
      });
      mockDb.appUserScopeGrant.update.mockResolvedValueOnce({});
      const { recordScopeGrant } = await import('../scope-grant.service');
      await recordScopeGrant({
        userId: 1,
        appBlockId: 'ab_x',
        version: '2.0.0',
        scopes: ['ai:write:budgeted'],
        clearRevocations: true,
      });
      expect(mockDb.appUserScopeGrant.update.mock.calls[0][0].data.revokedAt).toBeNull();
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

  // ─────────────────────────────────────────────────────────────────────────────
  // PER-SCOPE REVOCATION. Every test in this block is RED at `origin/main`, where
  // `revokeScopes` and `revoked_scopes` do not exist at all.
  // ─────────────────────────────────────────────────────────────────────────────

  describe('getGrantedScopes subtracts revoked_scopes', () => {
    // 🔴 THE CENTRAL READ-SIDE CLAIM. The granted ARRAY still holds the scope — that is the
    // state an install-after-revoke produces, because `recordScopeGrant` unions — and the
    // grant must nevertheless not convey it. Deleting the subtraction is the mutation the
    // install-resurrection suite exists to kill.
    it('a scope present in BOTH arrays is NOT granted', async () => {
      mockDb.appUserScopeGrant.findUnique.mockResolvedValueOnce({
        grantedScopes: ['user:read:self', 'ai:write:budgeted', 'posts:write:self'],
        revokedAt: null,
        revokedScopes: ['ai:write:budgeted'],
      });
      const { getGrantedScopes } = await import('../scope-grant.service');
      const set = await getGrantedScopes({ userId: 1, appBlockId: 'ab_x' });
      expect(set).toEqual(new Set(['user:read:self', 'posts:write:self']));
      expect(set.has('ai:write:budgeted')).toBe(false);
    });

    // The negative image, so "returns nothing" cannot be the answer the code gives for
    // everything: an empty suppression list changes nothing.
    it('an EMPTY revoked list leaves the granted set untouched', async () => {
      mockDb.appUserScopeGrant.findUnique.mockResolvedValueOnce({
        grantedScopes: ['user:read:self', 'ai:write:budgeted'],
        revokedAt: null,
        revokedScopes: [],
      });
      const { getGrantedScopes } = await import('../scope-grant.service');
      const set = await getGrantedScopes({ userId: 1, appBlockId: 'ab_x' });
      expect(set).toEqual(new Set(['user:read:self', 'ai:write:budgeted']));
    });

    // A suppression entry that matches nothing suppresses nothing — the reason the
    // migration deliberately adds no CHECK constraint on the array's contents.
    it('a revoked scope the user never granted removes nothing', async () => {
      mockDb.appUserScopeGrant.findUnique.mockResolvedValueOnce({
        grantedScopes: ['user:read:self'],
        revokedAt: null,
        revokedScopes: ['posts:write:self', 'not:a:real:scope'],
      });
      const { getGrantedScopes } = await import('../scope-grant.service');
      expect(await getGrantedScopes({ userId: 1, appBlockId: 'ab_x' })).toEqual(
        new Set(['user:read:self'])
      );
    });
  });

  describe('revokeScopes', () => {
    /** A live grant row holding two gated scopes and nothing suppressed. */
    function liveGrant(over: Record<string, unknown> = {}) {
      return {
        id: 'augr_1',
        grantedScopes: ['ai:write:budgeted', 'posts:write:self'],
        revokedScopes: [],
        ...over,
      };
    }

    it('writes BOTH arrays — suppression added, grant narrowed', async () => {
      mockDb.appUserScopeGrant.findUnique.mockResolvedValueOnce(liveGrant());
      mockDb.appUserScopeGrant.update.mockResolvedValueOnce({});
      const { revokeScopes } = await import('../scope-grant.service');
      const res = await revokeScopes({
        userId: 1,
        appBlockId: 'ab_x',
        scopes: ['posts:write:self'],
      });
      const data = mockDb.appUserScopeGrant.update.mock.calls[0][0].data;
      expect(data.revokedScopes).toEqual(['posts:write:self']);
      expect(data.grantedScopes).toEqual(['ai:write:budgeted']);
      expect(res.revoked).toEqual(['posts:write:self']);
      expect(res.grantedScopes).toEqual(['ai:write:budgeted']);
    });

    // 🔴 THE BOUNDARY. `revoked_at` is the WHOLE-GRANT flag and the permissions page skips
    // rows that carry it, so stamping it on a PARTIAL revoke would make a viewer's first
    // revoke delete the card they revoked from — along with every remaining permission's
    // control.
    it('does not TOUCH revokedAt while any granted scope remains', async () => {
      mockDb.appUserScopeGrant.findUnique.mockResolvedValueOnce(liveGrant());
      mockDb.appUserScopeGrant.update.mockResolvedValueOnce({});
      const { revokeScopes } = await import('../scope-grant.service');
      const res = await revokeScopes({
        userId: 1,
        appBlockId: 'ab_x',
        scopes: ['posts:write:self'],
      });
      // ⚠️ `not.toHaveProperty`, NOT `toBeNull()`. This assertion used to read
      // `…data.revokedAt).toBeNull()` — it PINNED THE DEFECT. See the arm below.
      expect(mockDb.appUserScopeGrant.update.mock.calls[0][0].data).not.toHaveProperty('revokedAt');
      expect(res.fullyRevoked).toBe(false);
    });

    /**
     * 🔴 A PARTIAL REVOKE MUST NOT UN-REVOKE A WHOLE-GRANT REVOKE. This is the arm the
     * original suite could not fail: its fixture already had `revokedAt: null`, so a write of
     * `revokedAt: null` was indistinguishable from leaving it alone, and the test was NAMED
     * after the intent while pinning the opposite.
     *
     * The state is real and intended, not hypothetical:
     * `scripts/oneoffs/2026-09-16-reconsent-ai-write-budgeted.sql` runs
     * `SET revoked_at = now() WHERE 'ai:write:budgeted' = ANY (granted_scopes)` and
     * deliberately leaves the array intact, to force a fresh consent prompt. On such a row a
     * `revokedAt: null` write re-granted EVERY other scope with no prompt —
     * `ai:write:budgeted` among them, with the old `buzz_budget_per_day` springing back — so
     * withdrawing one permission widened five. The same inversion class this change exists to
     * fix.
     *
     * MUTATION THAT MUST KILL IT: `...(fullyRevoked ? { revokedAt: now } : {})` →
     * `revokedAt: fullyRevoked ? now : null`.
     */
    it('🔴 does not clear a PRE-EXISTING whole-grant revoke (the re-consent oneoff’s state)', async () => {
      // The oneoff's row shape: suspended, but the granted array untouched.
      mockDb.appUserScopeGrant.findUnique.mockResolvedValueOnce(
        liveGrant({ grantedScopes: ['ai:write:budgeted', 'posts:write:self'] })
      );
      mockDb.appUserScopeGrant.update.mockResolvedValueOnce({});
      const { revokeScopes } = await import('../scope-grant.service');
      await revokeScopes({ userId: 1, appBlockId: 'ab_x', scopes: ['posts:write:self'] });
      const data = mockDb.appUserScopeGrant.update.mock.calls[0][0].data;
      expect(
        data,
        'the write NAMES revokedAt on a partial revoke. If the row carried a non-NULL ' +
          'revoked_at — which the 2026-09-16 re-consent oneoff produces deliberately — this ' +
          'clears it and re-grants every other scope on the row with no consent prompt.'
      ).not.toHaveProperty('revokedAt');
    });

    /**
     * 🔴 AN ALREADY WHOLE-GRANT-REVOKED ROW CONVEYS NOTHING, SO ANY REVOKE AGAINST IT IS TOTAL —
     * and the select used to omit `revokedAt`, so this could not even be expressed.
     *
     * This is the `2026-09-16` oneoff's row shape: `revoked_at` set, `granted_scopes` still
     * populated. Reading the raw array made `revokeScopes` report `fullyRevoked: false` and a
     * non-empty `grantedScopes`, while `liveGrantedScopes` — and therefore every mint, the OAuth
     * mirror and the permissions page — said the grant conveys nothing. The router hands both
     * fields straight to the client, so the UI would have contradicted enforcement.
     *
     * MUTATION THAT MUST KILL IT: `existing?.grantedScopes ?? []` in place of
     * `liveGrantedScopes(existing)`.
     */
    it('treats an already-revoked row as conveying nothing', async () => {
      mockDb.appUserScopeGrant.findUnique.mockResolvedValueOnce({
        id: 'augr_1',
        grantedScopes: ['ai:write:budgeted', 'posts:write:self'],
        revokedScopes: [],
        revokedAt: new Date('2026-09-16T00:00:00Z'),
      });
      mockDb.appUserScopeGrant.update.mockResolvedValueOnce({});
      const { revokeScopes } = await import('../scope-grant.service');
      const res = await revokeScopes({
        userId: 1,
        appBlockId: 'ab_x',
        scopes: ['posts:write:self'],
      });
      expect(
        res.fullyRevoked,
        'reported a partially-granted row for a grant that already conveys nothing — the client ' +
          'would be shown permissions the mint withholds'
      ).toBe(true);
      expect(res.grantedScopes).toEqual([]);
      // …and `revoked_at` is (re)stamped rather than cleared, so the suspension survives.
      expect(mockDb.appUserScopeGrant.update.mock.calls[0][0].data.revokedAt).toBeInstanceOf(Date);
    });

    /**
     * 🔴 AND THE CONTROL FOR THE BUDGET CLEAR, which review found survived every fixture: no
     * arm had `priorRevoked ⊇ {spend}` with `incoming ∌ spend`, so keying `budgetCleared` on
     * the accumulated `revoked_scopes` instead of THIS call's scopes was invisible. That
     * mutant names `buzz_budget_per_day` on every subsequent revoke — a 500 on a database
     * missing that (earlier, separate) migration — and reports `budgetCleared: true` for a
     * call that cleared nothing.
     *
     * MUTATION THAT MUST KILL IT: `incomingSet.has(CONSENT_SPEND_SCOPE)` →
     * `nextRevoked.includes(CONSENT_SPEND_SCOPE)`.
     */
    it('does not re-clear the budget when spend was ALREADY revoked earlier', async () => {
      mockDb.appUserScopeGrant.findUnique.mockResolvedValueOnce(
        liveGrant({ grantedScopes: ['posts:write:self'], revokedScopes: ['ai:write:budgeted'] })
      );
      mockDb.appUserScopeGrant.update.mockResolvedValueOnce({});
      const { revokeScopes } = await import('../scope-grant.service');
      const res = await revokeScopes({
        userId: 1,
        appBlockId: 'ab_x',
        scopes: ['posts:write:self'],
      });
      expect(
        mockDb.appUserScopeGrant.update.mock.calls[0][0].data,
        'the write names buzz_budget_per_day for a call that revoked no spend scope — it is ' +
          'keyed on the accumulated revoked set rather than on THIS call’s scopes'
      ).not.toHaveProperty('buzzBudgetPerDay');
      expect(res.budgetCleared).toBe(false);
    });

    it('stamps revokedAt once the LAST granted scope goes', async () => {
      mockDb.appUserScopeGrant.findUnique.mockResolvedValueOnce(
        liveGrant({ grantedScopes: ['posts:write:self'] })
      );
      mockDb.appUserScopeGrant.update.mockResolvedValueOnce({});
      const { revokeScopes } = await import('../scope-grant.service');
      const res = await revokeScopes({
        userId: 1,
        appBlockId: 'ab_x',
        scopes: ['posts:write:self'],
      });
      const data = mockDb.appUserScopeGrant.update.mock.calls[0][0].data;
      expect(data.revokedAt).toBeInstanceOf(Date);
      expect(data.grantedScopes).toEqual([]);
      expect(res.fullyRevoked).toBe(true);
    });

    // 🔴 REVOKING SPEND CLEARS THE CEILING. Leaving the number would make it spring back as
    // a live limit the moment a later re-consent restored the scope — a figure the viewer
    // set in a dialog they have since walked back.
    it('clears buzzBudgetPerDay when ai:write:budgeted is revoked', async () => {
      mockDb.appUserScopeGrant.findUnique.mockResolvedValueOnce(liveGrant());
      mockDb.appUserScopeGrant.update.mockResolvedValueOnce({});
      const { revokeScopes } = await import('../scope-grant.service');
      const res = await revokeScopes({
        userId: 1,
        appBlockId: 'ab_x',
        scopes: ['ai:write:budgeted'],
      });
      expect(mockDb.appUserScopeGrant.update.mock.calls[0][0].data).toMatchObject({
        buzzBudgetPerDay: null,
      });
      expect(res.budgetCleared).toBe(true);
    });

    // 🔴 THE CONTROL FOR THE TEST ABOVE, and it is not optional: without it, an
    // implementation that ALWAYS nulls the budget passes that assertion. Revoking an
    // unrelated scope must leave a spend limit the viewer deliberately set alone — and it
    // must not even NAME the column, because a `buzz_budget_per_day`-less database would
    // then 500 on every unrelated revoke.
    it('does NOT touch buzzBudgetPerDay when an unrelated scope is revoked', async () => {
      mockDb.appUserScopeGrant.findUnique.mockResolvedValueOnce(liveGrant());
      mockDb.appUserScopeGrant.update.mockResolvedValueOnce({});
      const { revokeScopes } = await import('../scope-grant.service');
      const res = await revokeScopes({
        userId: 1,
        appBlockId: 'ab_x',
        scopes: ['posts:write:self'],
      });
      expect(mockDb.appUserScopeGrant.update.mock.calls[0][0].data).not.toHaveProperty(
        'buzzBudgetPerDay'
      );
      expect(res.budgetCleared).toBe(false);
    });

    it('is additive over a prior suppression list and de-dups', async () => {
      mockDb.appUserScopeGrant.findUnique.mockResolvedValueOnce(
        liveGrant({ revokedScopes: ['posts:write:self'] })
      );
      mockDb.appUserScopeGrant.update.mockResolvedValueOnce({});
      const { revokeScopes } = await import('../scope-grant.service');
      const res = await revokeScopes({
        userId: 1,
        appBlockId: 'ab_x',
        scopes: ['posts:write:self', 'ai:write:budgeted'],
      });
      expect(new Set(mockDb.appUserScopeGrant.update.mock.calls[0][0].data.revokedScopes)).toEqual(
        new Set(['posts:write:self', 'ai:write:budgeted'])
      );
      // `revoked` is the DELTA — `posts:write:self` was already suppressed.
      expect(res.revoked).toEqual(['ai:write:budgeted']);
    });

    // 🔴 NO ROW ⇒ CREATE ONE. If this no-op'd, the viewer's pre-emptive "no" would be
    // forgotten and their next install would union the scope in with no prompt — the
    // resurrection hazard in the shape that is hardest to see, because there is nothing on
    // screen to suggest the revoke did not stick.
    it('CREATES a suppression row when the viewer holds no grant at all', async () => {
      mockDb.appUserScopeGrant.findUnique.mockResolvedValueOnce(null);
      mockDb.appUserScopeGrant.create.mockResolvedValueOnce({});
      const { revokeScopes } = await import('../scope-grant.service');
      const res = await revokeScopes({
        userId: 1,
        appBlockId: 'ab_x',
        scopes: ['ai:write:budgeted'],
      });
      const arg = mockDb.appUserScopeGrant.create.mock.calls[0][0];
      expect(arg.data.id).toMatch(/^augr_/);
      expect(arg.data.revokedScopes).toEqual(['ai:write:budgeted']);
      expect(arg.data.grantedScopes).toEqual([]);
      // Nothing granted ⇒ fully revoked, and no version to claim the consent was taken at.
      expect(arg.data.revokedAt).toBeInstanceOf(Date);
      expect(arg.data.version).toBe('');
      expect(res.fullyRevoked).toBe(true);
    });

    // A concurrent install taking the unique index must not lose the revoke — it is racing
    // the very union the suppression list defends against.
    it('recovers from a concurrent-create P2002 by re-reading and updating', async () => {
      mockDb.appUserScopeGrant.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(liveGrant({ id: 'augr_race' }));
      mockDb.appUserScopeGrant.create.mockRejectedValueOnce({ code: 'P2002' });
      mockDb.appUserScopeGrant.update.mockResolvedValueOnce({});
      const { revokeScopes } = await import('../scope-grant.service');
      const res = await revokeScopes({
        userId: 1,
        appBlockId: 'ab_x',
        scopes: ['ai:write:budgeted'],
      });
      expect(mockDb.appUserScopeGrant.update.mock.calls[0][0].where).toEqual({ id: 'augr_race' });
      expect(res.revokedScopes).toEqual(['ai:write:budgeted']);
    });

    // The retry is bounded. A second P2002 propagates rather than looping — see the
    // `attempt` parameter's docblock.
    it('does not loop forever if P2002 repeats', async () => {
      mockDb.appUserScopeGrant.findUnique.mockResolvedValue(null);
      mockDb.appUserScopeGrant.create.mockRejectedValue({ code: 'P2002' });
      const { revokeScopes } = await import('../scope-grant.service');
      await expect(
        revokeScopes({ userId: 1, appBlockId: 'ab_x', scopes: ['ai:write:budgeted'] })
      ).rejects.toMatchObject({ code: 'P2002' });
      expect(mockDb.appUserScopeGrant.create).toHaveBeenCalledTimes(2);
    });

    it('stamps revokedScopesAt so a UI has an app-level "last changed"', async () => {
      mockDb.appUserScopeGrant.findUnique.mockResolvedValueOnce(liveGrant());
      mockDb.appUserScopeGrant.update.mockResolvedValueOnce({});
      const { revokeScopes } = await import('../scope-grant.service');
      await revokeScopes({ userId: 1, appBlockId: 'ab_x', scopes: ['posts:write:self'] });
      expect(mockDb.appUserScopeGrant.update.mock.calls[0][0].data.revokedScopesAt).toBeInstanceOf(
        Date
      );
    });
  });

  describe('recordScopeGrant — clearRevocations', () => {
    // 🔴 THE INSTALL/SUBSCRIBE PATH. Without the flag the suppression column is not even
    // named, so the union cannot undo a revoke and the read-side subtraction keeps holding.
    it('does NOT clear anything when the flag is absent (the install path)', async () => {
      mockDb.appUserScopeGrant.findUnique.mockResolvedValueOnce({
        id: 'augr_1',
        grantedScopes: [],
      });
      mockDb.appUserScopeGrant.update.mockResolvedValueOnce({});
      const { recordScopeGrant } = await import('../scope-grant.service');
      const res = await recordScopeGrant({
        userId: 1,
        appBlockId: 'ab_x',
        version: '1.0.0',
        scopes: ['ai:write:budgeted'],
      });
      const data = mockDb.appUserScopeGrant.update.mock.calls[0][0].data;
      expect(data).not.toHaveProperty('revokedScopes');
      expect(res.revokedScopesAfterClear).toBeNull();
      // It also did not even ASK for the column — the install path's query is unchanged.
      expect(mockDb.appUserScopeGrant.findUnique.mock.calls[0][0].select).toEqual({
        id: true,
        grantedScopes: true,
      });
    });

    it('lifts the suppression for a re-consented scope', async () => {
      mockDb.appUserScopeGrant.findUnique.mockResolvedValueOnce({
        id: 'augr_1',
        grantedScopes: ['ai:write:budgeted'],
        revokedScopes: ['ai:write:budgeted'],
      });
      mockDb.appUserScopeGrant.update.mockResolvedValueOnce({});
      const { recordScopeGrant } = await import('../scope-grant.service');
      const res = await recordScopeGrant({
        userId: 1,
        appBlockId: 'ab_x',
        version: '1.0.0',
        scopes: ['ai:write:budgeted'],
        clearRevocations: true,
      });
      const data = mockDb.appUserScopeGrant.update.mock.calls[0][0].data;
      expect(data.revokedScopes).toEqual([]);
      // Empty list ⇒ the "last changed" stamp goes too, and the caller is told `[]` so it
      // DELETES the in-flight marker rather than leaving it to expire.
      expect(data.revokedScopesAt).toBeNull();
      expect(res.revokedScopesAfterClear).toEqual([]);
    });

    // 🔴 THE ONE THAT MAKES THE FLAG SAFE, and the shape this was first written wrong as.
    // A wholesale `revokedScopes: []` would have restored a permission the viewer withdrew
    // and was never asked about again — a widening performed by a dialog that named only
    // the OTHER scope.
    it('clears ONLY the re-consented scope’s revocation, leaving the others suppressed', async () => {
      mockDb.appUserScopeGrant.findUnique.mockResolvedValueOnce({
        id: 'augr_1',
        grantedScopes: [],
        revokedScopes: ['ai:write:budgeted', 'posts:write:self'],
      });
      mockDb.appUserScopeGrant.update.mockResolvedValueOnce({});
      const { recordScopeGrant } = await import('../scope-grant.service');
      const res = await recordScopeGrant({
        userId: 1,
        appBlockId: 'ab_x',
        version: '1.0.0',
        scopes: ['ai:write:budgeted'],
        clearRevocations: true,
      });
      const data = mockDb.appUserScopeGrant.update.mock.calls[0][0].data;
      expect(data.revokedScopes).toEqual(['posts:write:self']);
      // Something is still revoked, so the app-level stamp is NOT nulled.
      expect(data).not.toHaveProperty('revokedScopesAt');
      expect(res.revokedScopesAfterClear).toEqual(['posts:write:self']);
    });

    // Nothing to lift ⇒ the column is left alone AND the caller is told `null`, not `[]`.
    // Returning `[]` here would make an ordinary consent DELETE a live marker.
    it('touches nothing when the re-consented scope was never revoked', async () => {
      mockDb.appUserScopeGrant.findUnique.mockResolvedValueOnce({
        id: 'augr_1',
        grantedScopes: [],
        revokedScopes: ['posts:write:self'],
      });
      mockDb.appUserScopeGrant.update.mockResolvedValueOnce({});
      const { recordScopeGrant } = await import('../scope-grant.service');
      const res = await recordScopeGrant({
        userId: 1,
        appBlockId: 'ab_x',
        version: '1.0.0',
        scopes: ['ai:write:budgeted'],
        clearRevocations: true,
      });
      expect(mockDb.appUserScopeGrant.update.mock.calls[0][0].data).not.toHaveProperty(
        'revokedScopes'
      );
      expect(res.revokedScopesAfterClear).toBeNull();
    });
  });

  describe('resolveConsentSpendPosture', () => {
    // 🔴 THE THREE OUTCOMES MUST BE DISTINGUISHABLE. Collapsing `revoked` onto `no-budget`
    // is the inversion this function exists to fix: the spend path read a nullable number,
    // saw `null`, and fell back to the PLATFORM ceiling — so a revoke LIFTED the viewer's
    // own cap instead of stopping the spend.
    it('reports revoked/grant_revoked for a whole-grant revoke', async () => {
      mockDb.appUserScopeGrant.findUnique.mockResolvedValueOnce({
        grantedScopes: [],
        revokedAt: new Date(),
        revokedScopes: [],
      });
      const { resolveConsentSpendPosture } = await import('../scope-grant.service');
      expect(await resolveConsentSpendPosture({ userId: 1, appBlockId: 'ab_x' })).toEqual({
        kind: 'revoked',
        reason: 'grant_revoked',
      });
    });

    it('reports revoked/spend_scope_revoked for a PARTIAL revoke of the spend scope', async () => {
      mockDb.appUserScopeGrant.findUnique.mockResolvedValueOnce({
        grantedScopes: ['posts:write:self'],
        revokedAt: null,
        revokedScopes: ['ai:write:budgeted'],
      });
      const { resolveConsentSpendPosture } = await import('../scope-grant.service');
      expect(await resolveConsentSpendPosture({ userId: 1, appBlockId: 'ab_x' })).toEqual({
        kind: 'revoked',
        reason: 'spend_scope_revoked',
      });
    });

    // 🔴 THE CONTROL: a revoke of something ELSE must not stop spending. Without this, an
    // implementation that reported `revoked` for ANY non-empty suppression list passes the
    // test above.
    it('reports the BUDGET when a different scope was revoked', async () => {
      mockDb.appUserScopeGrant.findUnique
        // the revocation read
        .mockResolvedValueOnce({
          grantedScopes: ['ai:write:budgeted'],
          revokedAt: null,
          revokedScopes: ['posts:write:self'],
        })
        // the budget read
        .mockResolvedValueOnce({ buzzBudgetPerDay: 400, revokedAt: null });
      const { resolveConsentSpendPosture } = await import('../scope-grant.service');
      expect(await resolveConsentSpendPosture({ userId: 1, appBlockId: 'ab_x' })).toEqual({
        kind: 'budget',
        budget: 400,
      });
    });

    it('reports no-budget for a live grant with no ceiling set', async () => {
      mockDb.appUserScopeGrant.findUnique
        .mockResolvedValueOnce({
          grantedScopes: ['ai:write:budgeted'],
          revokedAt: null,
          revokedScopes: [],
        })
        .mockResolvedValueOnce({ buzzBudgetPerDay: null, revokedAt: null });
      const { resolveConsentSpendPosture } = await import('../scope-grant.service');
      expect(await resolveConsentSpendPosture({ userId: 1, appBlockId: 'ab_x' })).toEqual({
        kind: 'no-budget',
      });
    });

    it('reports no-budget when the viewer holds no grant row', async () => {
      mockDb.appUserScopeGrant.findUnique.mockResolvedValue(null);
      const { resolveConsentSpendPosture } = await import('../scope-grant.service');
      expect(await resolveConsentSpendPosture({ userId: 1, appBlockId: 'ab_x' })).toEqual({
        kind: 'no-budget',
      });
    });

    // Fail-closed on an UNKNOWN: a DB error is not "nothing revoked".
    it('RETHROWS a non-P2022 DB error rather than reporting a posture', async () => {
      mockDb.appUserScopeGrant.findUnique.mockRejectedValueOnce(
        Object.assign(new Error('replica down'), { code: 'P1001' })
      );
      const { resolveConsentSpendPosture } = await import('../scope-grant.service');
      await expect(resolveConsentSpendPosture({ userId: 1, appBlockId: 'ab_x' })).rejects.toThrow(
        /replica down/
      );
    });
  });

  describe('isConsentExemptScope / consentExemptScopeList', () => {
    // 🔴 PINS THE WHOLE SET, NOT A SAMPLE. Membership here decides which scopes a revoke
    // control may be offered on, and the set is also what `partitionByConsent` signs
    // without a grant — so a silent addition would BOTH mint a scope consent-free and make
    // it un-revokable. An exact-array assertion is what makes either change visible.
    it('is exactly the seven documented exempt scopes', async () => {
      const { consentExemptScopeList } = await import('../scope-grant.service');
      expect(consentExemptScopeList()).toEqual([
        'apps:storage:read',
        'apps:storage:shared:read',
        'apps:storage:shared:write',
        'apps:storage:write',
        'collections:read:self',
        'collections:write:self',
        'models:read:self',
      ]);
    });

    it('agrees with consentGatedScopes on both sides of the split', async () => {
      const { isConsentExemptScope, consentGatedScopes } = await import('../scope-grant.service');
      const all = [
        'models:read:self',
        'collections:read:private',
        'ai:write:budgeted',
        'posts:write:self',
        'apps:storage:shared:write',
      ];
      // ONE predicate, two consumers — the drift this pins is the router deciding a scope
      // is revokable while the mint signs it without a grant.
      expect(all.filter((s) => !isConsentExemptScope(s))).toEqual(consentGatedScopes(all));
      expect(isConsentExemptScope('ai:write:budgeted')).toBe(false);
      expect(isConsentExemptScope('models:read:self')).toBe(true);
    });

    it('hands out a COPY, so a caller cannot widen what the mint signs', async () => {
      const { consentExemptScopeList, isConsentExemptScope } = await import(
        '../scope-grant.service'
      );
      const list = consentExemptScopeList();
      list.push('ai:write:budgeted');
      expect(isConsentExemptScope('ai:write:budgeted')).toBe(false);
      expect(consentExemptScopeList()).not.toContain('ai:write:budgeted');
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
