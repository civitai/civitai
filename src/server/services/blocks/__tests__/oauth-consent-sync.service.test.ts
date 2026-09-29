import { beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/setup';

const { bustMock, deleteSubjectMock, invalidateMock } = vi.hoisted(() => ({
  bustMock: vi.fn(async () => undefined),
  deleteSubjectMock: vi.fn(async () => undefined),
  invalidateMock: vi.fn(async () => undefined),
}));
vi.mock('~/server/http/orchestrator/api-key-spend', () => ({
  bustBuzzLimitCache: bustMock,
  deleteAuthSubject: deleteSubjectMock,
}));
vi.mock('~/server/services/orchestrator/civitai', () => ({
  invalidateCivitaiUser: invalidateMock,
}));

import { dbMock } from '~/__tests__/mocks';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import {
  revokeOauthConsentForBlock,
  syncOauthConsentFromGrant,
} from '../oauth-consent-sync.service';

const USER_ID = 7;
const APP_BLOCK_ID = 'apb_sync';
const CLIENT_ID = 'app_sync';
const DAY_LIMIT = (limit: number) => [{ type: 'sliding', limit, window: 'day', unit: 1 }];

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.appBlock.findUnique.mockResolvedValue({ appId: CLIENT_ID });
  // DEFAULT = a viewer who granted the OAuth baseline (`user:read:self`) alongside a
  // spend scope, i.e. one whose consent CAN support a token. #5127: the baseline used
  // to be absent from this fixture while the assertions still expected `UserRead` in
  // the row — the partially-granted bypass, pinned as intended behaviour.
  dbMock.dbWrite.appUserScopeGrant.findUnique.mockResolvedValue({
    grantedScopes: [
      'user:read:self',
      'ai:write:budgeted',
      'apps:storage:read',
      'collections:read:private',
    ],
    revokedAt: null,
    buzzBudgetPerDay: 500,
  });
  dbMock.dbWrite.oauthConsent.findUnique.mockResolvedValue(null);
  dbMock.dbWrite.oauthConsent.upsert.mockResolvedValue({ id: 1 });
});

/**
 * 🔴 THE MIRROR HONOURS `revoked_scopes` — the one read of the grant row that did not.
 *
 * This surface is what the revoke mutation itself calls "a SECOND ENFORCEMENT SURFACE": the
 * `OauthConsent` row carries a bitmask the auth hub mints real OAuth access tokens against, and
 * `src/server/auth/bearer-token.ts` resolves every OAuth bearer's spend ceiling from its
 * `buzzLimit`. Both outlive the mutation.
 *
 * The chain review found, which these arms pin:
 *   1. viewer revokes `ai:write:budgeted` — the row loses it from `granted_scopes`, gains it in
 *      `revoked_scopes`, `buzz_budget_per_day` → NULL, and the mirror is deleted;
 *   2. viewer installs or subscribes to the app again — `recordInstallConsent` UNIONS the app's
 *      whole consent-gated set back into `granted_scopes` (the union the suppression list exists
 *      to survive), and `revoked_scopes` still holds the scope;
 *   3. the next OAuth mint calls this function — which read the RAW column and wrote a row
 *      carrying `AIServicesWrite` with `buzzLimit: null`. The viewer's revoke had removed their
 *      own ceiling and left it removed DURABLY.
 *
 * RED at `a8b75427f5`, where the select omitted `revokedScopes` entirely.
 */
describe('syncOauthConsentFromGrant — the suppression list', () => {
  /**
   * MUTATION THAT MUST KILL IT: read `grant.grantedScopes` instead of `liveGrantedScopes(grant)`,
   * or drop `revokedScopes` from the select.
   */
  it('does NOT mirror a revoked scope, even while the raw column still holds it', async () => {
    // The post-install state: the union put the scope back, the suppression stands.
    dbMock.dbWrite.appUserScopeGrant.findUnique.mockResolvedValue({
      grantedScopes: ['user:read:self', 'ai:write:budgeted'],
      revokedScopes: ['ai:write:budgeted'],
      revokedAt: null,
      buzzBudgetPerDay: null,
    });
    const result = await syncOauthConsentFromGrant({ userId: USER_ID, appBlockId: APP_BLOCK_ID });
    expect(
      result,
      'the OAuth mirror re-granted a scope the viewer revoked. The hub mints real access tokens ' +
        'against this bitmask, and the row is durable.'
    ).toEqual({ clientId: CLIENT_ID, scope: TokenScope.UserRead });
    const written = dbMock.dbWrite.oauthConsent.upsert.mock.calls[0][0];
    expect(written.create.scope & TokenScope.AIServicesWrite).toBe(0);
  });

  /**
   * 🔴 THE CONTROL. The identical row with an EMPTY suppression list DOES mirror the spend bit —
   * so "drops the bit" is not the answer this function gives for everything.
   */
  it('CONTROL: mirrors the spend bit when nothing is revoked', async () => {
    dbMock.dbWrite.appUserScopeGrant.findUnique.mockResolvedValue({
      grantedScopes: ['user:read:self', 'ai:write:budgeted'],
      revokedScopes: [],
      revokedAt: null,
      buzzBudgetPerDay: null,
    });
    const result = await syncOauthConsentFromGrant({ userId: USER_ID, appBlockId: APP_BLOCK_ID });
    expect(result).toEqual({
      clientId: CLIENT_ID,
      scope: TokenScope.UserRead | TokenScope.AIServicesWrite,
    });
  });

  /**
   * The MINT PREDICATE reads the live set too. A viewer whose only remaining path to the OAuth
   * baseline is a REVOKED `user:read:self` has no consent to mirror, so this must write NOTHING
   * — the #5127 contract ("a row that cannot mint is worse than no row") applied to revocation.
   */
  it('writes NOTHING when the baseline scope is the revoked one', async () => {
    dbMock.dbWrite.appUserScopeGrant.findUnique.mockResolvedValue({
      grantedScopes: ['user:read:self', 'ai:write:budgeted'],
      revokedScopes: ['user:read:self'],
      revokedAt: null,
      buzzBudgetPerDay: null,
    });
    const result = await syncOauthConsentFromGrant({ userId: USER_ID, appBlockId: APP_BLOCK_ID });
    expect(result).toBeNull();
    expect(dbMock.dbWrite.oauthConsent.upsert).not.toHaveBeenCalled();
  });

  /**
   * PRE-MIGRATION: a row with no `revoked_scopes` key at all (what the column-less database
   * produces) mirrors exactly as it always did. `undefined` means "none", which is the only state
   * such a database can be in.
   */
  it('behaves exactly as before on a row with no revocation column', async () => {
    dbMock.dbWrite.appUserScopeGrant.findUnique.mockResolvedValue({
      grantedScopes: ['user:read:self', 'ai:write:budgeted'],
      revokedAt: null,
      buzzBudgetPerDay: 500,
    });
    const result = await syncOauthConsentFromGrant({ userId: USER_ID, appBlockId: APP_BLOCK_ID });
    expect(result).toEqual({
      clientId: CLIENT_ID,
      scope: TokenScope.UserRead | TokenScope.AIServicesWrite,
    });
  });

  /**
   * 🔴 THE PRE-MIGRATION DATABASE MUST DEGRADE, NOT 500 — and widening this select made it the
   * ONE reader of these columns with no fallback. It sits inside a `Promise.all` whose rejection
   * propagates out of `syncOauthConsentFromGrant`, and no caller catches:
   * `block-tokens/index.ts` awaits it on the OAuth mint AND the page-load mint, and
   * `blocks.grantScopes` awaits it after a successful consent write. So between deploy and a
   * human applying the migration — which is production as this ships — every mint for an
   * `auth: "oauth"` app 500'd, while the migration header in the same commit asserted "the
   * revoke MUTATION is therefore unavailable until this lands; nothing else is".
   *
   * MUTATION THAT MUST KILL IT: remove the `isMissingColumnError` retry from
   * `readGrantForMirror`.
   */
  it('degrades on a pre-migration database instead of throwing', async () => {
    const missingColumn = Object.assign(
      new Error('The column ... does not exist in the current database.'),
      { code: 'P2022' }
    );
    dbMock.dbWrite.appUserScopeGrant.findUnique
      .mockRejectedValueOnce(missingColumn)
      // The narrow, pre-migration row shape.
      .mockResolvedValueOnce({
        grantedScopes: ['user:read:self', 'ai:write:budgeted'],
        revokedAt: null,
        buzzBudgetPerDay: 500,
      });
    const result = await syncOauthConsentFromGrant({ userId: USER_ID, appBlockId: APP_BLOCK_ID });
    expect(
      result,
      'the mirror threw on a database without the revocation columns, so every OAuth mint 500s ' +
        'until a human applies the migration'
    ).toEqual({
      clientId: CLIENT_ID,
      scope: TokenScope.UserRead | TokenScope.AIServicesWrite,
    });
    // The retry really was the NARROW select — without this the test would also pass on an
    // implementation that swallowed the error and re-ran the identical query.
    expect(dbMock.dbWrite.appUserScopeGrant.findUnique.mock.calls[1][0].select).not.toHaveProperty(
      'revokedScopes'
    );
  });

  /** Any OTHER error still propagates: for those the suppression list is UNKNOWN, not absent. */
  it('still throws a non-P2022 error', async () => {
    dbMock.dbWrite.appUserScopeGrant.findUnique.mockRejectedValue(
      Object.assign(new Error('replica down'), { code: 'P1001' })
    );
    await expect(
      syncOauthConsentFromGrant({ userId: USER_ID, appBlockId: APP_BLOCK_ID })
    ).rejects.toThrow(/replica down/);
  });

  it('selects the revocation column, so the subtraction has something to read', async () => {
    await syncOauthConsentFromGrant({ userId: USER_ID, appBlockId: APP_BLOCK_ID });
    expect(dbMock.dbWrite.appUserScopeGrant.findUnique.mock.calls[0][0].select).toHaveProperty(
      'revokedScopes',
      true
    );
  });
});

describe('syncOauthConsentFromGrant', () => {
  it('maps granted scopes to OAuth bits and the daily budget to a sliding limit', async () => {
    const result = await syncOauthConsentFromGrant({ userId: USER_ID, appBlockId: APP_BLOCK_ID });

    // `UserRead` is present because the viewer GRANTED `user:read:self`, not because
    // the mapping forces it (#5127). `apps:storage:read` / `collections:read:private`
    // are SKIP_OAUTH_CHECK, so they contribute no bit.
    const scope = TokenScope.UserRead | TokenScope.AIServicesWrite;
    expect(result).toEqual({ clientId: CLIENT_ID, scope });
    const upsert = dbMock.dbWrite.oauthConsent.upsert.mock.calls[0][0];
    expect(upsert.where).toEqual({ userId_clientId: { userId: USER_ID, clientId: CLIENT_ID } });
    expect(upsert.create).toMatchObject({ userId: USER_ID, clientId: CLIENT_ID, scope });
    expect(upsert.update).toEqual({ scope, buzzLimit: DAY_LIMIT(500) });
    expect(bustMock).not.toHaveBeenCalled();
  });

  it('maps a baseline-plus-buzz grant to exactly those two bits', async () => {
    dbMock.dbWrite.appUserScopeGrant.findUnique.mockResolvedValue({
      grantedScopes: ['user:read:self', 'buzz:read:self'],
      revokedAt: null,
      buzzBudgetPerDay: null,
    });

    const result = await syncOauthConsentFromGrant({ userId: USER_ID, appBlockId: APP_BLOCK_ID });

    expect(result).toEqual({
      clientId: CLIENT_ID,
      scope: TokenScope.UserRead | TokenScope.BuzzRead,
    });
  });

  it('busts the orchestrator limit cache only when an existing consent limit changed', async () => {
    dbMock.dbWrite.oauthConsent.findUnique.mockResolvedValue({ buzzLimit: DAY_LIMIT(100) });

    await syncOauthConsentFromGrant({ userId: USER_ID, appBlockId: APP_BLOCK_ID });

    expect(bustMock).toHaveBeenCalledWith({
      userId: USER_ID,
      subject: { type: 'oauth', id: CLIENT_ID },
    });
  });

  // 🔴 #5127 REGRESSION. This case previously asserted the opposite — that a viewer
  // with NO grant row still got a row mirroring `UserRead | ModelsRead`. That was the
  // vulnerability written down as a spec: the hub then validated consent against the
  // row this call had just manufactured, and an `auth: "oauth"` block read the
  // viewer's email from /api/v1/me while the same mint reported `user:read:self` as
  // missing. A viewer who has consented to nothing gets nothing written.
  it('writes nothing and returns null when the viewer has no grant row at all', async () => {
    dbMock.dbWrite.appUserScopeGrant.findUnique.mockResolvedValue(null);

    const result = await syncOauthConsentFromGrant({
      userId: USER_ID,
      appBlockId: APP_BLOCK_ID,
      scopes: ['models:read:self', 'apps:storage:read'],
    });

    expect(result).toBeNull();
    expect(dbMock.dbWrite.oauthConsent.upsert).not.toHaveBeenCalled();
  });

  // Pins the FUNCTION'S CONTRACT for the `scopes` parameter, and nothing wider.
  // ⚠️ NOT production coverage: no caller reaches this shape — `mintOauthAppToken`
  // passes `partitionByConsent(...).signable`, so a gated scope it hands over is
  // already in `grantedScopes`. Kept because the grant row must stay the sole
  // authority for gated scopes if a future caller ever passes a raw manifest list.
  it('ignores consent-gated scopes the caller asks for but the viewer never granted', async () => {
    dbMock.dbWrite.appUserScopeGrant.findUnique.mockResolvedValue({
      // Carries the baseline, so the mint predicate passes and the filter is REACHED.
      grantedScopes: ['user:read:self', 'apps:storage:write'],
      revokedAt: null,
      buzzBudgetPerDay: null,
    });

    const result = await syncOauthConsentFromGrant({
      userId: USER_ID,
      appBlockId: APP_BLOCK_ID,
      // exempt: models:read:self (→ ModelsRead), apps:storage:read (→ no bit).
      // gated and NOT granted: buzz:read:self (→ BuzzRead) must NOT appear.
      scopes: ['buzz:read:self', 'models:read:self', 'apps:storage:read'],
    });

    expect(result).toEqual({
      clientId: CLIENT_ID,
      scope: TokenScope.UserRead | TokenScope.ModelsRead,
    });
    expect(result!.scope & TokenScope.BuzzRead).toBe(0);
  });

  /**
   * 🔴 #5127 SECOND SHAPE — the guard the audit proved was missing, and the
   * REACHABILITY PROOF for the mint predicate.
   *
   * A grant row EXISTS and is not revoked, so the missing-row guard does not fire;
   * the viewer simply never granted `user:read:self`. Pre-fix this wrote a row ORing
   * `UserRead` in, the hub minted against it, and the block read the viewer's email
   * while the same mint reported `user:read:self` missing.
   *
   * The fixture deliberately grants a DIFFERENT bit (`AIServicesWrite`, 32768) rather
   * than nothing, so a mutant that returns early on an empty grant, or one that
   * hardcodes 0, cannot survive: the mask must be computed from this scope set and
   * come back without bit 1.
   */
  it('returns null and writes nothing when the grant omits user:read:self', async () => {
    dbMock.dbWrite.appUserScopeGrant.findUnique.mockResolvedValue({
      grantedScopes: ['ai:write:budgeted', 'collections:read:private'],
      revokedAt: null,
      buzzBudgetPerDay: 250,
    });

    const result = await syncOauthConsentFromGrant({
      userId: USER_ID,
      appBlockId: APP_BLOCK_ID,
      scopes: ['ai:write:budgeted', 'apps:storage:read'],
    });

    expect(result).toBeNull();
    expect(dbMock.dbWrite.oauthConsent.upsert).not.toHaveBeenCalled();
    expect(bustMock).not.toHaveBeenCalled();
  });

  it('returns null and writes nothing when the grant is revoked', async () => {
    dbMock.dbWrite.appUserScopeGrant.findUnique.mockResolvedValue({
      grantedScopes: ['ai:write:budgeted'],
      revokedAt: new Date(),
      buzzBudgetPerDay: null,
    });

    const result = await syncOauthConsentFromGrant({ userId: USER_ID, appBlockId: APP_BLOCK_ID });

    expect(result).toBeNull();
    expect(dbMock.dbWrite.oauthConsent.upsert).not.toHaveBeenCalled();
  });
});

describe('revokeOauthConsentForBlock', () => {
  it('deletes the consent and its tokens and invalidates the orchestrator subject', async () => {
    await revokeOauthConsentForBlock({ userId: USER_ID, appBlockId: APP_BLOCK_ID });

    expect(dbMock.dbWrite.apiKey.deleteMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, clientId: CLIENT_ID, type: { in: ['Access', 'Refresh'] } },
    });
    expect(dbMock.dbWrite.oauthConsent.deleteMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, clientId: CLIENT_ID },
    });
    expect(deleteSubjectMock).toHaveBeenCalledWith({
      userId: USER_ID,
      subject: { type: 'oauth', id: CLIENT_ID },
    });
    expect(invalidateMock).toHaveBeenCalledWith({ userId: USER_ID });
  });
});
