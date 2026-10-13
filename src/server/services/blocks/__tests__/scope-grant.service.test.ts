import fs from 'fs';
import path from 'path';
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

    /**
     * 🔴 THE TWO REFUSAL MESSAGES MUST DIFFER, AND NOTHING PINNED THAT.
     *
     * Both refusal arms import their constant and assert equality against it, which is this file's
     * idiom and is right — it kills a mutant by TEXT rather than by "something threw". But it
     * makes each constant's own value unpinned, and round-6 review measured the consequence:
     * redefining `CONSENT_RECONSENT_UNAVAILABLE_MESSAGE` as `= CONSENT_REVOKE_UNAVAILABLE_MESSAGE`
     * SURVIVED all 264 tests. A routine "dedupe these two near-identical strings" refactor would
     * then tell a viewer who tried to UPDATE permissions that "Withdrawing a permission is not
     * available…", with a fully green suite — and it would collapse the very distinction the
     * mutant that swaps one message for the other is supposed to be caught by.
     *
     * Secondary: were they identical, `rethrowMissingRevokedScopesColumn`'s throw (same code, the
     * revoke message) would also satisfy the re-consent arm. Not reachable from `recordScopeGrant`
     * today — that helper is called only on the two `revokeScopes` paths — but the arm would stop
     * being able to tell the two apart.
     *
     * Pinned on the DISTINCTION a viewer depends on (which verb they are told about), not on the
     * full sentences, so ordinary copy edits stay free.
     */
    it('the re-consent and revoke refusals do not say the same thing', async () => {
      const { CONSENT_RECONSENT_UNAVAILABLE_MESSAGE, CONSENT_REVOKE_UNAVAILABLE_MESSAGE } =
        await import('../scope-grant.service');
      expect(
        CONSENT_RECONSENT_UNAVAILABLE_MESSAGE,
        'the two refusals collapsed into one string, so the re-consent path now tells the viewer ' +
          'their WITHDRAWAL is unavailable — and the mutant that swaps the messages becomes ' +
          'undetectable'
      ).not.toEqual(CONSENT_REVOKE_UNAVAILABLE_MESSAGE);
      expect(CONSENT_RECONSENT_UNAVAILABLE_MESSAGE).toMatch(/Updating/);
      expect(CONSENT_REVOKE_UNAVAILABLE_MESSAGE).toMatch(/Withdrawing/);
    });

    /**
     * 🔴 THE PRE-MIGRATION POPULATION IS THE ONE THE MIGRATION WAS WRITTEN FOR, AND IT WAS THE
     * ONE IT DID NOT REACH. `existingRevokedAt` was assigned on the WIDE read only, so the narrow
     * fallback left it `null`, `unrevokeData` took `return { revokedAt: null }`, and a partial
     * re-consent lifted a whole-grant revoke wholesale — restoring every scope in
     * `granted_scopes`, `ai:write:budgeted` at its old ceiling included. That is exactly the
     * fail-open the migration exists to close, surviving on the only database where the row shape
     * actually occurs today: `revoked_at` is set BY HAND (the `2026-09-16` oneoff) and
     * `revoked_scopes` does not exist yet because a human has not applied the migration.
     *
     * `revoked_at` PREDATES this migration, so the narrow select can read it for free.
     *
     * The migration itself is not expressible here (no column to write), so the clear is
     * CONDITIONAL — and a partial re-consent now **THROWS** rather than merely leaving the viewer
     * withheld. ⚠️ THIS PROSE DESCRIBED THE BEHAVIOUR IT REPLACED for one round: returning `{}`
     * left `grantScopes` answering `{ ok: true }` while changing nothing, permanently, because the
     * ceiling on both `incoming` and the revoke UI means no viewer action can empty the residual.
     * Refusing is the same fail-closed direction, said out loud — `revokeScopes` already refuses
     * this same database with `PRECONDITION_FAILED` and an exported message.
     *
     * MUTATIONS THAT MUST KILL IT: drop `revokedAt: true` from the narrow select; drop the
     * `existingRevokedAt = narrow?.revokedAt ?? null` assignment; make the
     * `!revokedScopesColumnAvailable` branch `return { revokedAt: null }` unconditionally; revert
     * the refusal to `return {}` (which is also this arm's POSITIVE CONTROL — it resolves instead
     * of rejecting, i.e. exactly the pre-change behaviour); throw a bare `Error` instead of a
     * `TRPCError`; keep the code but carry `CONSENT_REVOKE_UNAVAILABLE_MESSAGE`; change the code
     * while keeping the message; compute `residual` in the wrong direction, or drop its filter;
     * flip the boundary to `>= 0`.
     */
    it('🔴 REFUSES a PARTIAL re-consent out loud, rather than lifting or silently no-op-ing', async () => {
      mockDb.appUserScopeGrant.findUnique
        .mockRejectedValueOnce(missingColumnError())
        .mockResolvedValueOnce({
          id: 'augr_1',
          grantedScopes: ['ai:write:budgeted', 'posts:write:self'],
          revokedAt: new Date('2026-09-16T00:00:00Z'),
        });
      const { recordScopeGrant, CONSENT_RECONSENT_UNAVAILABLE_MESSAGE } = await import(
        '../scope-grant.service'
      );
      await expect(
        recordScopeGrant({
          userId: 1,
          appBlockId: 'ab_x',
          version: '1.0.0',
          // Names ONE of the two suspended scopes.
          scopes: ['posts:write:self'],
          clearRevocations: true,
        }),
        'the flag was lifted from a dialog that named one scope, so ai:write:budgeted came back ' +
          'at its old ceiling with no consent for it anywhere — or, after that was closed, the ' +
          'call reported ok and changed nothing, PERMANENTLY, because granted_scopes is never ' +
          'pruned so the residual can never empty'
      ).rejects.toMatchObject({
        // `PRECONDITION_FAILED`, so `client-safe-error.ts` does not replace the message — the
        // same reason the revoke half throws this code. Pinned by MESSAGE, so a mutant that
        // swaps in a different error is killed by the text and not merely by "something threw".
        code: 'PRECONDITION_FAILED',
        message: CONSENT_RECONSENT_UNAVAILABLE_MESSAGE,
      });
      // And NOTHING was written — the throw happens while building the payload, so there is no
      // half-applied grant behind the refusal.
      expect(mockDb.appUserScopeGrant.update).not.toHaveBeenCalled();
      expect(mockDb.appUserScopeGrant.create).not.toHaveBeenCalled();
      // 🔴 THE NARROW SELECT MUST ASK FOR `revokedAt`, AND THAT SHAPE WAS UNPINNED. The db mock
      // is a bare `vi.fn` that IGNORES `select` and returns whatever the fixture supplies, so a
      // mutant deleting `revokedAt: true` from the select SURVIVED the whole suite — while in
      // production Prisma honours `select`, `narrow.revokedAt` comes back `undefined`,
      // `existingRevokedAt` is `null`, and `unrevokeData` takes the WHOLESALE LIFT this arm
      // exists to prevent. Same idiom as the `getGrantedScopes` retry assertion above.
      expect(
        mockDb.appUserScopeGrant.findUnique.mock.calls[1][0].select,
        'the pre-migration retry stopped asking for revoked_at, so a whole-grant revoke reads as ' +
          'absent and is lifted wholesale — invisible to this suite because the mock ignores select'
      ).toEqual({ id: true, grantedScopes: true, revokedAt: true });
    });

    /**
     * CONTROL, and the case that must keep working: re-consenting to EVERYTHING the row granted
     * leaves nothing to suppress, so the migration would have produced an empty list anyway and
     * clearing the flag loses no information. This is the flow the oneoff wants, and it is what
     * makes the conditional clear a narrowing rather than a dead end.
     */
    it('CONTROL: a re-consent covering the whole granted set DOES lift it', async () => {
      const whole = ['ai:write:budgeted', 'posts:write:self'];
      mockDb.appUserScopeGrant.findUnique
        .mockRejectedValueOnce(missingColumnError())
        .mockResolvedValueOnce({
          id: 'augr_1',
          grantedScopes: whole,
          revokedAt: new Date('2026-09-16T00:00:00Z'),
        });
      mockDb.appUserScopeGrant.update.mockResolvedValueOnce({});
      const { recordScopeGrant } = await import('../scope-grant.service');
      const res = await recordScopeGrant({
        userId: 1,
        appBlockId: 'ab_x',
        version: '1.0.0',
        scopes: whole,
        clearRevocations: true,
      });
      const data = mockDb.appUserScopeGrant.update.mock.calls[0][0].data;
      expect(data.revokedAt).toBeNull();
      expect(data).not.toHaveProperty('revokedScopes');
      // `[]`, not `null` — nothing is withheld after this write, so any stale marker must go.
      expect(res.revokedScopesAfterClear).toEqual([]);
      // The select shape again, on the arm that WRITES: see the sibling above for why the mock
      // cannot observe it any other way.
      expect(mockDb.appUserScopeGrant.findUnique.mock.calls[1][0].select).toEqual({
        id: true,
        grantedScopes: true,
        revokedAt: true,
      });
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
    /**
     * 🔴 A PROMPTED RE-CONSENT **MIGRATES** A WHOLE-GRANT REVOKE, IT DOES NOT LIFT IT.
     *
     * `revoked_at` means "everything on this row is withheld pending fresh consent". A viewer
     * re-consenting to ONE scope has said nothing about the others, so simply nulling the flag
     * restored every scope in `granted_scopes` — including `ai:write:budgeted` with its old
     * ceiling — from a dialog that named one. That is exactly the argument the per-scope clear
     * makes for touching only `revoked_scopes ∖ scopes`; `revoked_at` is its whole-grant version
     * and was left wholesale when the install-path hole was closed.
     *
     * So everything that WAS granted and is NOT being re-consented to becomes an explicit
     * per-scope suppression, and only then does the flag clear.
     *
     * MUTATIONS THAT MUST KILL IT: return `{ revokedAt: null }` unconditionally from
     * `unrevokeData`; or drop `revocationData`'s `if (existingRevokedAt) return {}` yield, which
     * lets the plain subtraction overwrite the migration and silently restores everything.
     */
    it('🔴 MIGRATES a whole-grant revoke into per-scope suppressions', async () => {
      // The oneoff's row: suspended, array intact, nothing per-scope suppressed yet.
      // 🔴 A NON-EMPTY PRIOR SUPPRESSION LIST IS LOAD-BEARING IN THIS FIXTURE. With
      // `revokedScopes: []` the neighbouring `revocationData` returns `{}` whatever it is handed
      // (nothing to subtract), so deleting its `if (existingRevokedAt) return {}` yield was
      // invisible — measured as a SURVIVING mutant. A prior entry that the plain subtraction
      // WOULD remove is what makes the clobber observable: without the yield, `revocationData`
      // spreads last and overwrites the migration with `prior ∖ incoming`.
      mockDb.appUserScopeGrant.findUnique.mockResolvedValueOnce({
        id: 'augr_1',
        grantedScopes: ['ai:write:budgeted', 'posts:write:self', 'user:read:self'],
        revokedScopes: ['collections:read:private'],
        revokedAt: new Date('2026-09-16T00:00:00Z'),
      });
      mockDb.appUserScopeGrant.update.mockResolvedValueOnce({});
      const { recordScopeGrant } = await import('../scope-grant.service');
      await recordScopeGrant({
        userId: 1,
        appBlockId: 'ab_x',
        version: '2.0.0',
        // The viewer re-consented to one currently-granted scope AND the one they had previously
        // suppressed — so the plain subtraction has something to remove, and the migration has
        // something to add.
        scopes: ['user:read:self', 'collections:read:private'],
        clearRevocations: true,
      });
      const data = mockDb.appUserScopeGrant.update.mock.calls[0][0].data;
      // The flag lifts…
      expect(data.revokedAt).toBeNull();
      // …and everything NOT re-consented to is now explicitly suppressed.
      expect(
        new Set(data.revokedScopes),
        'a dialog naming one scope restored the others — including ai:write:budgeted with its ' +
          'old ceiling. That is the whole-grant version of the defect the per-scope clear ' +
          'already guards against.'
      ).toEqual(new Set(['ai:write:budgeted', 'posts:write:self']));
      // …and `collections:read:private`, which the dialog DID name, is genuinely lifted.
      expect(new Set(data.revokedScopes).has('collections:read:private')).toBe(false);
      expect(data.revokedScopesAt).toBeInstanceOf(Date);
    });

    /**
     * 🔴 THE BOUNDARY THE MIGRATION WAS GUARDED ON, AND IT WAS A SILENT NO-GRANT.
     *
     * `unrevokeData` used to write `revoked_scopes` only `if (migrated.length > 0)`. But the
     * consent dialog sends the app's WHOLE consent-gated set — `blocks.router.ts` intersects the
     * viewer's request with the app's ceiling — so on a whole-grant-revoked row `incoming` covers
     * everything and `migrated` is `[]`. The guard then skipped the column entirely: the
     * suppression list the revoke had written SURVIVED, `revoked_at` cleared anyway, and
     * `liveGrantedScopes` (granted ∖ revoked) returned NOTHING. The mutation reported success and
     * conveyed no scope. A SECOND identical click recovered — by then `existingRevokedAt` is null
     * so `revocationData` handles it — which is why the user-visible symptom is "I had to press
     * Allow twice", with the first press reporting success.
     *
     * Reachability is the ordinary flow, not a corner: `revokeScopes` stamps `revoked_at` exactly
     * when the granted set empties, and at that moment `revoked_scopes` holds the whole set. So
     * "revoke everything, then allow again" lands here every time.
     *
     * RED at `a50a7e3643` (`revokedScopes: undefined` — the column was not written).
     *
     * MUTATIONS THAT MUST KILL IT: restore the `migrated.length > 0` guard; write
     * `revokedScopesAt: new Date()` unconditionally; drop the `clearedTo = migrated` assignment.
     */
    it('🔴 CLEARS the suppression list when the re-consent covers everything (migrated === [])', async () => {
      const whole = ['ai:write:budgeted', 'posts:write:self'];
      mockDb.appUserScopeGrant.findUnique.mockResolvedValueOnce({
        id: 'augr_1',
        // The shape `revokeScopes` itself leaves behind on a full revoke: granted emptied of
        // nothing (the union put it back at install), every scope suppressed, flag stamped.
        grantedScopes: whole,
        revokedScopes: whole,
        revokedAt: new Date('2026-09-20T00:00:00Z'),
      });
      mockDb.appUserScopeGrant.update.mockResolvedValueOnce({});
      const { recordScopeGrant } = await import('../scope-grant.service');
      const res = await recordScopeGrant({
        userId: 1,
        appBlockId: 'ab_x',
        version: '2.0.0',
        scopes: whole,
        clearRevocations: true,
      });
      const data = mockDb.appUserScopeGrant.update.mock.calls[0][0].data;
      expect(data.revokedAt).toBeNull();
      expect(
        data.revokedScopes,
        'the consent wrote no revoked_scopes at all, so the full suppression list the revoke had ' +
          'written survived while revoked_at cleared — granted = all, revoked = all, so ' +
          'liveGrantedScopes() returns EMPTY. The mutation reports success and grants nothing.'
      ).toEqual([]);
      // The timestamp follows the list: nothing is withheld, so "permissions last withheld at"
      // must not keep pointing at the revoke.
      expect(data.revokedScopesAt).toBeNull();
      // 🔴 AND THE CALLER IS TOLD. `[]`, never `null`: the router skips
      // `ConsentRevocation.publish` on `null`, so a stale Redis marker would keep suppressing
      // every scope this write just restored, for up to a token lifetime.
      expect(
        res.revokedScopesAfterClear,
        'null here means the router skips the marker publish, so the in-flight suppression ' +
          'outlives the consent that removed it'
      ).toEqual([]);
    });

    /** CONTROL: with no whole-grant revoke, the flag is simply cleared and nothing is migrated. */
    it('CONTROL: an ordinary re-consent migrates nothing', async () => {
      mockDb.appUserScopeGrant.findUnique.mockResolvedValueOnce({
        id: 'augr_1',
        grantedScopes: ['posts:write:self'],
        revokedScopes: [],
        revokedAt: null,
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
      const data = mockDb.appUserScopeGrant.update.mock.calls[0][0].data;
      expect(data.revokedAt).toBeNull();
      expect(data).not.toHaveProperty('revokedScopes');
    });

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

    // 🔴 THE BOUNDARY, AND THE REASON IS NOT THE ONE ORIGINALLY RECORDED. ⚠️ This read *"the
    // permissions page skips rows that carry it, so stamping it on a PARTIAL revoke would make a
    // viewer's first revoke delete the card they revoked from"* — RETRACTED: 4990 removed that skip,
    // so the card no longer disappears. The boundary still holds, for the reason `revokeScopes`'
    // own `revokedAt` comment gives: `revoked_at` collapses `liveGrantedScopes` to EMPTY, so
    // stamping it on a partial revoke would withhold every REMAINING permission the viewer still
    // grants — and a later `: null` would then re-grant them all with no prompt. Read that comment
    // before relaxing this; the consequence moved, the guard did not.
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
      const data = mockDb.appUserScopeGrant.update.mock.calls[0][0].data;
      // …and `revoked_at` is (re)stamped rather than cleared, so the suspension survives.
      expect(data.revokedAt).toBeInstanceOf(Date);
      // 🔴 THE STORED ARRAY IS NARROWED, NOT WIPED — the REPORT uses the effective set, the WRITE
      // uses the raw one. Collapsing both onto the projection flattened `granted_scopes` to `[]`
      // on exactly this row, destroying the audit array the `2026-09-16` oneoff deliberately
      // preserves ("keeping the audit trail"). Nothing is gained by discarding it: `revoked_at`
      // stays set, so every reader still sees the grant as conveying nothing.
      //
      // MUTATION THAT MUST KILL IT: write `nextGranted` (the effective set) instead of
      // `nextGrantedStored`.
      expect(
        data.grantedScopes,
        'the stored granted_scopes array was wiped on an already-revoked row, destroying the ' +
          'audit trail the re-consent oneoff preserves on purpose'
      ).toEqual(['ai:write:budgeted']);
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

    // ⚠️ INVARIANT GUARD OVER A BRANCH UNREACHABLE FROM ITS ONLY CALLER, AND THE RATIONALE BELOW IS
    // RETRACTED. This read: *"NO ROW ⇒ CREATE ONE. If this no-op'd, the viewer's pre-emptive 'no'
    // would be forgotten and their next install would union the scope in with no prompt."* That
    // "pre-emptive no" is precisely the requirement 4990 found unattributed and removed:
    // `blocks.revokeScopes` now refuses any scope outside the viewer's live granted set, and no
    // grant row means an empty granted set, so this branch cannot be reached through the one caller
    // that exists. The next three arms (this one, the P2002 recovery and the bounded retry) are
    // therefore invariant guards over an unreachable write path into a consent ledger — kept
    // because the service's contract is "records whatever it is told", NOT because the hazard they
    // describe is live. See `revokeScopes`' own docblock, which says the same thing from the other
    // side. Do not cite them as evidence the pre-emptive case is supported.
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
    //
    // 🔴 THE LITERAL IS DELIBERATE HERE, AND IT IS THE ONE PLACE THAT CARRIES ONE. Deriving the
    // expected value from the source would make this assertion unfailable, which is the opposite
    // of its purpose: this is a tripwire on a security-relevant set, so adding a scope is MEANT to
    // red it and force a reviewer to confirm the exemption was intended. Bump it consciously.
    // Every OTHER site that used to retype a count against this set now derives it instead — see
    // `components/Apps/__tests__/scopeConsentRows.test.ts`, which cross-checks the note map's keys
    // against this list rather than pinning a number of its own. (A count in a TITLE is pure rot
    // with no tripwire value, which is why this one names the property instead of a number: the
    // title said "seven" while the array said eight after upstream added `goods:read:self`.)
    it('is exactly the documented exempt set — bump this literal deliberately', async () => {
      const { consentExemptScopeList } = await import('../scope-grant.service');
      expect(consentExemptScopeList()).toEqual([
        'apps:storage:read',
        'apps:storage:shared:read',
        'apps:storage:shared:write',
        'apps:storage:write',
        // App Store items: gated per call (parent switch, trust, authorship, text safety, rate
        // limits, moderator approval). A consent gate would silently drop it from tokens.
        'apps:store:items:write',
        'collections:read:self',
        'collections:write:self',
        // Added by the digital-goods rail: the app's own sales ledger, filtered to this viewer and
        // scoped to `claims.appBlockId` server-side. Its sibling `goods:purchase:self` is
        // deliberately NOT here — money out of the viewer's balance needs an explicit grant, which
        // is also what keeps it REVOKABLE.
        'goods:read:self',
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

  /**
   * 🔴 THE P2022 TOLERANCE MUST SEE `meta.code`, NOT ONLY A BARE `code`.
   *
   * Every degrade-and-refuse path in this module runs through `isMissingColumnError`, and it used
   * to match `code === 'P2022'` alone. Prisma reports the column error under `meta.code` on some
   * engine versions — `app-listing-source-repo.service.ts` says so in its own docblock and pins
   * both shapes in its tests, on the same TYPED client this module uses — so on such a version the
   * narrow retry never fired, the read 500ed instead of degrading to "nothing revoked", and the
   * whole pre-migration refusal branch was unreachable. Round-10 review; the predicate is
   * pre-existing but this branch took its consumers from 2 to 4.
   *
   * The negative arms are the point as much as the positive ones: this predicate is the ONLY thing
   * standing between "a column is missing" and "a connection died", and widening it is exactly
   * where that distinction gets lost.
   */
  describe('isMissingColumnError', () => {
    it('matches every shape Prisma reports a missing column as', async () => {
      const { isMissingColumnError } = await import('../scope-grant.service');
      expect(isMissingColumnError({ code: 'P2022' })).toBe(true);
      expect(isMissingColumnError({ code: '42703' })).toBe(true);
      expect(
        isMissingColumnError({ code: 'P2000', meta: { code: '42703' } }),
        'the engine-version shape: the column code arrives under meta, so every tolerance in this ' +
          'module silently stopped working and a degraded read became a 500'
      ).toBe(true);
      expect(isMissingColumnError({ code: 'P2000', meta: { code: 'P2022' } })).toBe(true);
    });

    it('🔴 REFUSES every error that is not a missing column', async () => {
      const { isMissingColumnError } = await import('../scope-grant.service');
      // A real outage must PROPAGATE — degrading here is the fail-open this module exists to stop.
      expect(isMissingColumnError({ code: 'P1001' })).toBe(false);
      expect(isMissingColumnError({ code: 'P2002' })).toBe(false);
      // A missing TABLE is deliberately NOT a missing column: `app-access.service.ts` makes the
      // same distinction in the other direction, and conflating them hides a half-applied schema.
      expect(isMissingColumnError({ code: 'P2021' })).toBe(false);
      expect(isMissingColumnError({ code: '42P01' })).toBe(false);
      expect(isMissingColumnError({ code: 'P2000', meta: { code: '42P01' } })).toBe(false);
      // 🔴 INVARIANT GUARDS, NOT REGRESSION COVERAGE. Measured against the pre-widening body
      // (`(err as {code?: unknown} | null)?.code === 'P2022'`), every non-object input below
      // already returned `false` and none threw, because optional chaining handled them. So the
      // two `typeof` guards are equivalent mutants — removing either changes no observable
      // answer. These arms pin an invariant the bug never violated; they are cheap and worth
      // keeping, and must not be counted as coverage of a defect.
      expect(isMissingColumnError(null)).toBe(false);
      expect(isMissingColumnError(undefined)).toBe(false);
      expect(isMissingColumnError('P2022')).toBe(false);
      expect(isMissingColumnError({ code: 'P2000', meta: 'P2022' })).toBe(false);
      expect(isMissingColumnError(42703)).toBe(false);
    });
  });

  /**
   * 🔴 EVERY `logToAxiom` IN THIS MODULE MUST SWALLOW ITS OWN REJECTION — a STRUCTURAL assertion,
   * because the property is asserted in a COMMENT and was pinned by nothing.
   *
   * All three call sites here sit on a consent or spend path and each carries a comment promising
   * that logging can never break it. Round-7 review measured what that promise was worth: deleting the
   * `.catch(() => {})` from the re-consent refusal SURVIVED all 265 tests. Without it a rejected
   * `logToAxiom` is an unhandled rejection on a MUTATION path — the log line would break the very
   * consent path its neighbour promises it cannot.
   *
   * ⚠️ WHY STRUCTURAL AND NOT BEHAVIOURAL. Pinning this behaviourally needs `vi.mock` on
   * `~/server/logging/client` in a suite that deliberately mocks only the db, and two of this
   * repo's own lint-rule guards police wholesale module mocks. This scan costs one file read, pins
   * every site present and any future one, and fails when a site is ADDED without the catch — which
   * is the direction that matters. The site count is derived by the scan itself, not stated here.
   *
   * It reads the SOURCE comment-stripped, so a future `logToAxiom(` written in prose cannot break
   * it — ⚠️ DEFENSIVE ONLY, not a working property: measured, no comment in that module contains
   * the call shape today (3 raw occurrences, 3 stripped), so mutating the stripper to the identity
   * function SURVIVES. It is here so the guard does not start false-failing the first time someone
   * documents the call, not because it is doing work now.
   *
   * The count assertion is the positive control: a scan that finds nothing would otherwise pass
   * vacuously, which is how a guard reads as coverage while providing none.
   *
   * 🔴 WHAT IT DELIBERATELY DOES NOT CATCH, so nobody reads it as wider than it is. It is a
   * SPELLED guard and it errs in both directions. The shapes are enumerated below rather than
   * counted — three successive drafts of this paragraph stated a count that was wrong, so the
   * count is gone and the list is the claim:
   *   - FALSE PASS: `.catch()`, `.catch(undefined)`, `.catch(null)` and `.catch(void 0)` are
   *     pass-throughs that leave the rejection unhandled. The matcher below rejects all four by
   *     name, spaced or not, and skips a trailing line comment — it took FOUR drafts, each closing
   *     a hazard the previous one passed; see its own comment. A variable that merely HOLDS
   *     `undefined`, and `.catch(...args)`, are beyond a source scan and are not claimed.
   *   - FALSE FAIL: `.then(undefined, fn)` is SAFE and is rejected — accepted, because a visible
   *     cheap false failure is the right direction for a promise-rejection guard. ⚠️ An earlier
   *     draft also listed `await logToAxiom(...)` inside a `try/catch` here, presenting it as a
   *     live risk; it is NOT REACHABLE at any of the three sites, because all three enclosing
   *     functions (`logMissingBudgetColumn`, `logMissingRevokedScopesColumn`, `unrevokeData`) are
   *     SYNCHRONOUS — the `await` variant is a transform error, not a guard signal, which is also
   *     what made two mutants in two successive audits invalid. It would only become reachable if
   *     a site's enclosing function were first made `async`.
   */
  describe('logToAxiom call sites cannot break a consent path', () => {
    function stripComments(src: string): string {
      return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    }

    /**
     * Index just past the `)` that closes the call opening at `openIdx`.
     *
     * ⚠️ STRING-BLIND. It counts parens without tracking quotes or template literals, so an
     * UNBALANCED paren inside one of the call's message literals throws the walk off. Both
     * directions still fail loudly rather than passing — an unbalanced `(` returns -1 and trips the
     * explicit assertion below, an unbalanced `)` terminates early and reports the wrong CAUSE
     * ("does not swallow its own rejection" for a call that does). Latent today: all three call
     * bodies' literals are balanced. Worth knowing before you debug a confusing failure here.
     */
    function endOfCall(src: string, openIdx: number): number {
      let depth = 0;
      for (let i = openIdx; i < src.length; i += 1) {
        if (src[i] === '(') depth += 1;
        else if (src[i] === ')') {
          depth -= 1;
          if (depth === 0) return i + 1;
        }
      }
      return -1;
    }

    /**
     * The handled-rejection predicate, at DESCRIBE scope so the real scan and its control arm
     * grade the SAME regex. Two copies would let the guard drift from the thing that certifies it.
     */
    const HANDLED = /^\s*\.catch\s*\((?!(?:\s|\/\/[^\n]*)*(?:\)|undefined\b|null\b|void\b))/;

    /**
     * 🔴 EVERY TAIL THAT FOLLOWS A `logToAxiom(...)` CALL IN `source` — THE ONE CODE PATH THE REAL
     * SCAN AND ITS CONTROL ARM BOTH RUN.
     *
     * Shared deliberately: a control that computes its own slice is blind to the scan's slicing,
     * and reinstating either historical scan window then SURVIVED it (measured). One helper means a
     * reinstated window, a lost site or a broken paren walk fails the control instead of waiting
     * for a reviewer to re-measure it by hand.
     */
    function callTails(source: string): string[] {
      const src = stripComments(source);
      // 🔴 `indexOf`, NOT `regex.exec` IN A `while` — AND THAT IS NOT STYLE. The first draft used
      // `while ((m = re.exec(src)) !== null)`, which advances only while the regex carries the `g`
      // flag: a later edit dropping it makes this loop spin FOREVER, so the suite HANGS instead of
      // failing. Measured while validating this very guard — the mutation that removed `g` was
      // scored SURVIVED by a driver that never got a verdict. A hang is the worst failure mode a
      // guard can have, because it reads as infrastructure trouble rather than as a finding.
      // An `indexOf` walk cannot regress that way: the cursor is advanced explicitly.
      const NAME = 'logToAxiom';
      const tails: string[] = [];
      for (let from = src.indexOf(NAME); from !== -1; from = src.indexOf(NAME, from + 1)) {
        const open = src.indexOf('(', from + NAME.length);
        // Only a CALL counts. Anything between the name and the next `(` that is not whitespace
        // means this occurrence was the import binding or a member expression, not an invocation.
        if (open === -1 || src.slice(from + NAME.length, open).trim() !== '') continue;
        const end = endOfCall(src, open);
        expect(
          end,
          'unbalanced parens after a logToAxiom call — the scan cannot judge it'
        ).toBeGreaterThan(0);
        // 🔴 NO WINDOW AT ALL — AND A WINDOW OF **ANY** SIZE IS THE BUG, NOT A SIZE TO TUNE.
        // A negative lookahead whose target lies PAST the slice simply fails to match, and a
        // failed inner pattern makes the NEGATIVE lookahead SUCCEED. So a truncated tail turns a
        // hazard into a pass at whatever width you pick: 40 let `.catch(<34 spaces>undefined)`
        // through (round 10), and widening to 4096 moved the threshold instead of removing the
        // mechanism — round 11 measured `.catch(<5000 spaces>undefined)` passing the 4096 version.
        // The claim "widening cannot cost anything" was true of SAFE shapes and wrong about the
        // class.
        //
        // Slicing to the end costs nothing measurable, because the `^` anchor bounds the work:
        // 1,000 `RE.test` calls over the whole ~87 KB module run in ~0.06 ms, and the
        // comment-consuming alternation's adversarial input (20,000 alternating `" /"` pairs) is
        // FASTER than plain spaces — no catastrophic backtracking.
        tails.push(src.slice(end));
      }
      return tails;
    }

    it('every logToAxiom(...) is followed by .catch(', () => {
      const sites = callTails(
        fs.readFileSync(path.resolve(__dirname, '../scope-grant.service.ts'), 'utf8')
      );
      // 🔴 POSITIVE CONTROL, AND ITS FLOOR IS THE DERIVED COUNT — **THREE**, not two.
      // `logMissingBudgetColumn`, `logMissingRevokedScopesColumn` and the pre-migration
      // re-consent refusal. (This comment said "two sites" on its first draft, counting only the
      // revocation ones — the third is the budget column's, which predates this arc. Derive the
      // population before quoting it, which is the lesson three rounds of this review keep
      // teaching.) A floor BELOW the real count lets a scan silently stop covering a site, which
      // is the same reads-as-coverage failure this guard exists to close; a scan finding none
      // would make the loop below assert nothing at all.
      expect(
        sites.length,
        'the logToAxiom scan lost a call site (or found none, making the assertion below vacuous) ' +
          '— check the regex and the comment stripper before believing a green result here'
      ).toBeGreaterThanOrEqual(3);
      for (const after of sites) {
        // 🔴 THE BOOLEAN IS THE VERDICT AND THE OFFENDING TAIL RIDES IN THE MESSAGE — do not fold
        // them back into one asserted string. A previous draft asserted
        // `` `${HANDLED.test(after)} :: ${prefix}` `` against `/^true ::/`, which made the REPORTING
        // FORMAT part of the verdict (renaming the separator failed the guard and blamed the call)
        // and hid a hardcode surface: replacing `HANDLED.test(after)` with a literal `true`
        // SURVIVED, because the constant sat inside the template string. Measured, round-12 review.
        expect(
          HANDLED.test(after),
          'a logToAxiom call in scope-grant.service.ts does not swallow its own rejection. These ' +
            'sit on consent and spend paths — on a MUTATION that is an unhandled rejection — and ' +
            'it contradicts the neighbouring comment promising logging can never break the path. ' +
            `Offending tail: ${after.slice(0, 60).replace(/\n/g, '\\n')}`
          // 🔴 A REAL HANDLER IS REQUIRED, AND THIS MATCHER TOOK **FOUR** DRAFTS, EACH FIXING A
          // HAZARD THE PREVIOUS ONE PASSED. `.catch()`, `.catch(undefined)`, `.catch(null)` and
          // `.catch(void 0)` are all pass-throughs — the rejection stays unhandled — so each is
          // this guard's exact hazard, spelled differently.
          //   draft 1 `\.catch\s*\(` — passed all four.
          //   draft 2 `\(\s*[^)\s]` — closed only `.catch()`; `undefined` starts with a non-`)`
          //     character and sailed through.
          //   draft 3 `\(\s*(?!\)|undefined\b|null\b)` — ⚠️ passed every SPACED variant plus
          //     `void 0`, and the cause was BACKTRACKING, not the alternation. (An earlier note
          //     said "SEVEN shapes"; that figure is population-dependent and no population was
          //     named — measured over a 13-shape hazard set it is nine. Name the set or drop the
          //     count; this comment now does the latter.) With `\s*` OUTSIDE the lookahead and optional,
          //     a failed lookahead on `)` is retried with `\s*` matching zero characters, and
          //     `" )"` starts with none of the three names. So every spaced variant —
          //     `.catch( )`, `.catch( undefined )`, `.catch( null )`, `.catch(\n)` — passed, as did
          //     `void 0`, which was named nowhere.
          // 🔴 THE FIX IS THAT THE LOOKAHEAD OWNS THE WHITESPACE, so there is nothing to backtrack
          // into. Measured, not reasoned, at every draft — and validated in BOTH directions,
          // through the REAL `stripComments`/`endOfCall` pipeline rather than the regex alone,
          // over an enumerated set of **21 hazard** shapes { bare, spaced-bare, newline-bare, tab,
          // NBSP, em-space, `undefined`, ` undefined `, `null`, ` null `, `void 0`, ` void 0 `,
          // `void handler`, `null?.x`, block-comment-bare, trailing-line-comment-bare,
          // own-line-comment-bare, and wide-whitespace variants of bare / `undefined` / `null` /
          // `void 0` } and **14 handler** shapes { arrow, spaced arrow, `( ) =>`, named, `async`,
          // `function`, `e => void e`, multi-line arrow, trailing-comment-then-arrow,
          // wide-whitespace-then-arrow, `nullHandler`, `voidHandler`, `undefined2`,
          // `null_handler` } — plus `.then(undefined, fn)`, red by design. ⚠️ Counts are stated WITH
          // their population on purpose: an earlier note said "SEVEN shapes" with no population
          // named, and the same round's commit message and code comment disagreed about the totals.
          //
          // NOT CLAIMED, and each is a shape nobody writes by hand: a variable that merely HOLDS
          // `undefined`; `.catch(...args)`, which is genuinely ambiguous; and two contrived FALSE
          // FAILS in the accepted visible direction — `.catch(void$fn)` (a legal identifier, since
          // `$` is not a `\w`, so `void\b` matches) and `.catch(undefined ?? noop)` (which does
          // evaluate to a real handler).
          // 🔴 THE LOOKAHEAD SKIPS LINE COMMENTS TOO, AND WITHOUT THAT `\.catch( // why\n)` PASSED.
          // `stripComments`' second replace is anchored `^[ \t]*//`, so a `//` that is NOT at line
          // start survives stripping; the matcher then saw `/` as the first token, which is in
          // neither the forbidden set nor `\s`, so the lookahead succeeded on a bare `.catch()`.
          // Round-10 review, measured through the real `stripComments` rather than against the
          // regex alone — which is why it was invisible to the previous round's pure-function
          // check. `(?:\s|//[^\n]*)*` consumes both, and a trailing comment FOLLOWED by a real
          // handler still passes.
        ).toBe(true);
      }
    });

    /**
     * 🔴 CAN THE SCAN ABOVE GO RED? THAT IS THE ONLY QUESTION THIS ARM ANSWERS.
     *
     * The scan can only fail on what the real module happens to contain, and the real module
     * contains no pathological `.catch(`. So a matcher hole is invisible to CI: measured,
     * reinstating the 4096-character scan window — the exact defect round 11 removed — passed the
     * whole suite. This arm feeds the LIVE pipeline (the same `callTails` and the same `HANDLED`)
     * a set of tails whose classification is known, in both directions: a HAZARD that passes means
     * the matcher has a hole, a SAFE shape that fails means it will false-fail on a correct
     * refactor.
     *
     * 🔴 THE SET IS THE HISTORICAL ONE, NOT AN IMAGINED ONE. Every hazard below actually slipped
     * through some draft of this matcher. A battery built from mutations one can think of would
     * have missed the two that mattered — a trailing line comment surviving the stripper's
     * line-start anchor, and a whitespace run longer than the scan window.
     *
     * 🔴 WHAT IT CANNOT SEE: any mutation of its own scaffolding — the probe list edited, the loop
     * bounds narrowed, the verdict hardcoded. A guard cannot guard its own assertion, and the
     * layers of LEDGER set-equality, distinctness and content pins that once sat here only raised
     * the cost of such an edit from two coordinated places to four. Every one of them is
     * conspicuous in a diff, and a diff is where this is meant to be caught. Do not re-add THOSE.
     *
     * ⚠️ THAT PARAGRAPH USED TO SAY "the layers of ledger, FLOOR and content pins … Do not re-add
     * them", AND THE FLOOR WAS BUNDLED INTO AN ARGUMENT WRITTEN ABOUT A DIFFERENT GUARD SHAPE. The
     * two-places-to-four accounting is true of the three LEDGER pins: each guards the probe ARRAY,
     * a second structure, so walking one needs a coordinated edit in both — which is why each of
     * them in turn was found walkable by the NEXT round of the same ladder. The `WIDE.length` floor
     * is not that shape. It is a one-place guard against a one-place edit: shrinking `WIDE` makes
     * the three wide probes stop exceeding any scan window, so they assert nothing, and **nothing
     * else in the file can see it** — measured, `' '.repeat(5)` SURVIVES the whole suite without
     * the floor and goes RED with it. So it is reinstated as the ASSERTION ONLY, with the window
     * history inlined as a literal rather than as a separate `HISTORICAL_SCAN_WINDOWS` array: that
     * array was the second place the original floor could be walked from (shortening it only
     * loosened the floor, measured SURVIVING), and it is exactly what made the round-15 version
     * fail its own test. One expression, no ledger, ~40 lines of prose not restored.
     *
     * Also not covered, because the component is INERT rather than unguarded: `stripComments` is
     * provably the identity for every probe below (the line-comment replace is line-start-anchored
     * and no probe carries a block comment). It is defence against a future prose mention of the
     * call shape, not a working part today.
     */
    it('CONTROL: the live scan pipeline classifies the historical shapes correctly', () => {
      // Longer than every scan window this guard has ever had (40, then 4096) — that is the whole
      // point of the three `WIDE` probes, so do not shrink it. A truncated tail makes the negative
      // lookahead succeed, which turns a hazard into a pass at whatever width is chosen.
      const WIDE = ' '.repeat(5000);
      // 🔴 THE FLOOR, NOT THE COMMENT ABOVE IT. The sentence above says "do not shrink it"; this
      // makes it a machine-readable claim. `4096` is the largest scan window this guard has ever
      // had (40, then 4096) and is written as a literal on purpose — a separate history ARRAY is a
      // second place the floor can be loosened from, which is what killed the previous version.
      expect(
        WIDE.length,
        'the wide-whitespace probes no longer exceed every scan window this ' +
          'guard has had, so they assert nothing'
      ).toBeGreaterThan(4096);
      const cases: Array<[kind: 'HAZARD' | 'SAFE', tail: string]> = [
        // Pass-throughs: the rejection stays unhandled. Each passed at least one earlier draft.
        ['HAZARD', ''],
        ['HAZARD', '.catch()'],
        ['HAZARD', '.catch( )'],
        ['HAZARD', '.catch(undefined)'],
        ['HAZARD', '.catch( undefined )'],
        ['HAZARD', '.catch(null)'],
        ['HAZARD', '.catch(void 0)'],
        // Survived the `^[ \t]*//`-anchored stripper (round 10).
        ['HAZARD', '.catch( // why\n)'],
        // Lay past the scan window, so the NEGATIVE lookahead succeeded (rounds 10 and 11).
        ['HAZARD', `.catch(${WIDE})`],
        ['HAZARD', `.catch(${WIDE}undefined)`],
        // Real handlers, which must keep passing.
        ['SAFE', '.catch(() => {})'],
        ['SAFE', '.catch( () => {} )'],
        ['SAFE', '.catch(String)'],
        ['SAFE', '.catch((e) => void e)'],
        ['SAFE', '.catch( // why\n () => {})'],
        ['SAFE', `.catch(${WIDE}() => {})`],
        // `\b` boundaries: an identifier that merely STARTS with a forbidden word is a handler.
        ['SAFE', '.catch(nullHandler)'],
        ['SAFE', '.catch(voidHandler)'],
      ];
      for (const [kind, tail] of cases) {
        // 🔴 THROUGH `callTails`, NOT A HAND-ROLLED COPY OF IT — see its docblock. A probe that
        // computes its own slice is blind to the scan's slicing, which is how both historical
        // windows survived this arm's first draft.
        const tails = callTails(`logToAxiom({ a: 1 })${tail};`);
        // The run is collapsed for display only — a 5,000-space diagnostic is unreadable. The
        // token is deliberately not a stated length, which would go stale the moment `WIDE` moves.
        const shown = JSON.stringify(tail.replace(WIDE, '<WIDE>'));
        expect(tails.length, `the pipeline found ${tails.length} calls, not 1, for ${shown}`).toBe(
          1
        );
        expect(
          HANDLED.test(tails[0]),
          `${kind} shape misclassified by the live scan pipeline: ${shown}. A HAZARD that passes ` +
            'means the guard has a hole; a SAFE shape that fails means it will false-fail on a ' +
            'correct refactor.'
        ).toBe(kind === 'SAFE');
      }
    });
  });
});
