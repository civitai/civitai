import { beforeEach, describe, expect, it } from 'vitest';
import '~/__tests__/setup';
import { redisMock } from '~/__tests__/mocks/redis.mock';
// 🔴 THE REAL CONSTANTS, NEVER HAND-TYPED. `~/__tests__/setup` spreads the real
// `@civitai/redis/client` into the global mock, so these are production's own strings —
// which is what `no-hand-typed-redis-key-constants.test.ts` exists to enforce: fifteen
// constants across six files had silently drifted from production while their suites passed,
// asserting against keys Redis never sees.
import { REDIS_KEYS } from '~/server/redis/client';
import { MAX_BLOCK_TOKEN_LIFETIME_SECONDS } from '~/server/services/block-token-lifetimes';
import {
  applyRevocations,
  ConsentRevocation,
  revokedScopesForToken,
  shouldConsultMarker,
} from '../consent-revocation.service';

/**
 * The PER-SCOPE CONSENT REVOCATION marker — the control that makes a revoke take effect on
 * a token that was already minted.
 *
 * Three properties are under test and each has its own failure mode:
 *
 *   1. IT FAILS **CLOSED**. Unlike `BlockRevocation.isRevoked`, which swallows a Redis
 *      error and returns "not revoked", this refuses. The marker exists because a USER
 *      asked for a permission to stop being granted and was told it was done; "the cache
 *      was down so we kept granting it" is that promise not being kept.
 *   2. IT IS PER-SCOPE, and the ENFORCEMENT IS A STRIP rather than a list of gates. A
 *      boolean marker would refuse the app's entire surface for up to a token lifetime
 *      because the viewer withdrew ONE permission; and a guard that only tested the ROUTE's
 *      declared scope — the first version — enforced nothing for `posts:write:self` (bridge
 *      only) or `collections:read:private` (an in-handler sub-check under an EXEMPT declared
 *      scope), which are the two most sensitive gated scopes in the vocabulary.
 *   3. ITS KEYSPACE IS DISJOINT from both `BlockRevocation` keyspaces. That separation is a
 *      security control with a history: when the install and ban causes shared one key, an
 *      ordinary model owner's `toggleEnabled(false)` overwrote a ban marker and
 *      `toggleEnabled(true)` cleared it, putting a banned publisher's live token back into
 *      service. This is a THIRD population — the viewer — writing about a different subject
 *      (a user/app pair, not an instance id).
 *
 * RED/GREEN: every test here is red at `origin/main` by absence — the module and the key
 * constant do not exist, so the file cannot import. That reports "no tests", not a failure,
 * which is why the fail-closed arms below are ALSO mutation-controlled (flip the `catch` to
 * `return false` and watch the two named tests go red).
 */

const USER = 42;
const APP = 'apb_test';
const EXPECTED_KEY = `${REDIS_KEYS.BLOCKS.CONSENT_REVOKED_SCOPES}:${USER}:${APP}`;

beforeEach(() => {
  redisMock.redis.get.mockReset();
  redisMock.redis.set.mockReset();
  redisMock.redis.del.mockReset();
  redisMock.redis.get.mockResolvedValue(null);
  redisMock.redis.set.mockResolvedValue('OK');
  redisMock.redis.del.mockResolvedValue(1);
});

describe('ConsentRevocation.publish', () => {
  it('writes the whole suppression list under the (user, app) key', async () => {
    await ConsentRevocation.publish({
      userId: USER,
      appBlockId: APP,
      revokedScopes: ['ai:write:budgeted', 'posts:write:self'],
    });
    expect(redisMock.redis.set).toHaveBeenCalledTimes(1);
    const [key, value] = redisMock.redis.set.mock.calls[0];
    expect(key).toBe(EXPECTED_KEY);
    // The VALUE carries the scopes, which is what makes the refusal per-scope rather than
    // per-app. A bare '1' here would break property 2 above.
    expect(JSON.parse(value as string)).toEqual(['ai:write:budgeted', 'posts:write:self']);
  });

  /**
   * 🔴 THE TTL IS DERIVED, NOT A LITERAL. A marker shorter than the token it refuses lapses
   * while that token is still accepted, and a MISSING key reads as "not revoked" — the
   * control stops refusing without failing. That is exactly how `REVOKED_INSTANCE`'s TTL sat
   * at 15 minutes for the whole time `dev:live` tokens lived 4 hours.
   *
   * Asserted against the CONSTANT, never against a number: hardcoding 14400 here would make
   * this test agree with a regression the moment a longer token kind is added.
   */
  it('sets a TTL equal to the longest token lifetime', async () => {
    await ConsentRevocation.publish({ userId: USER, appBlockId: APP, revokedScopes: ['x'] });
    expect(redisMock.redis.set.mock.calls[0][2]).toEqual({
      EX: MAX_BLOCK_TOKEN_LIFETIME_SECONDS,
    });
    // Positive control on the constant itself: a 0/NaN would satisfy the equality above
    // while expiring the marker immediately.
    expect(MAX_BLOCK_TOKEN_LIFETIME_SECONDS).toBeGreaterThanOrEqual(4 * 60 * 60);
  });

  // An empty list means nothing is revoked, so the key should go rather than sit there
  // answering "no" on every request. This is also the path a full re-consent takes.
  it('DELETES the key for an empty list instead of storing []', async () => {
    await ConsentRevocation.publish({ userId: USER, appBlockId: APP, revokedScopes: [] });
    expect(redisMock.redis.del).toHaveBeenCalledWith(EXPECTED_KEY);
    expect(redisMock.redis.set).not.toHaveBeenCalled();
  });

  /**
   * 🔴 THROWS, unlike `BlockRevocation.revokeInstance` which swallows. The caller is a
   * mutation whose entire purpose is this revocation, so it must be able to tell the viewer
   * their in-flight session may keep the permission for a few more minutes rather than
   * report an unqualified success.
   */
  it('PROPAGATES a Redis failure to the caller', async () => {
    redisMock.redis.set.mockRejectedValueOnce(new Error('redis down'));
    await expect(
      ConsentRevocation.publish({ userId: USER, appBlockId: APP, revokedScopes: ['x'] })
    ).rejects.toThrow(/redis down/);
  });
});

describe('ConsentRevocation.lookup', () => {
  it('is `none` when no marker exists (the common case, one GET)', async () => {
    redisMock.redis.get.mockResolvedValueOnce(null);
    expect(await ConsentRevocation.lookup({ userId: USER, appBlockId: APP })).toEqual({
      kind: 'none',
    });
    expect(redisMock.redis.get).toHaveBeenCalledWith(EXPECTED_KEY);
  });

  it('returns the SET a marker lists', async () => {
    redisMock.redis.get.mockResolvedValueOnce(
      JSON.stringify(['ai:write:budgeted', 'posts:write:self'])
    );
    const verdict = await ConsentRevocation.lookup({ userId: USER, appBlockId: APP });
    expect(verdict).toEqual({
      kind: 'revoked',
      scopes: new Set(['ai:write:budgeted', 'posts:write:self']),
    });
  });

  /**
   * 🔴 `unavailable`, NOT `none`, ON A REDIS ERROR — and the two must stay distinguishable at
   * this layer. Folding "unknown" into "nothing revoked" here is the fail-open the whole
   * module exists to prevent; folding it into "everything revoked" would be wrong for the
   * any-token catalog routes. `revokedScopesForToken` owns that decision, in one place.
   *
   * MUTATION THAT MUST KILL THIS: return `{ kind: 'none' }` from the `catch`.
   */
  it('is `unavailable` when Redis throws (fail closed, and distinguishable)', async () => {
    redisMock.redis.get.mockRejectedValueOnce(new Error('connection reset'));
    expect(
      await ConsentRevocation.lookup({ userId: USER, appBlockId: APP }),
      'a Redis error reported `none`, i.e. "nothing is revoked". That is the fail-OPEN posture ' +
        'of BlockRevocation.isRevoked, deliberate THERE and wrong here.'
    ).toEqual({ kind: 'unavailable' });
  });

  /**
   * 🔴 AND ON AN UNPARSEABLE MARKER, which is the same situation in different clothes: the key
   * EXISTS, so something published a revocation, and we cannot tell which scopes it covered.
   */
  it.each([
    ['not JSON at all', 'not-json'],
    ['JSON but not an array', '{"scope":"ai:write:budgeted"}'],
    ['an array of non-strings', '[1,2,3]'],
    ['the legacy boolean marker shape', '1'],
  ])('is `unavailable` on a malformed marker (%s)', async (_label, raw) => {
    redisMock.redis.get.mockResolvedValueOnce(raw);
    expect(await ConsentRevocation.lookup({ userId: USER, appBlockId: APP })).toEqual({
      kind: 'unavailable',
    });
  });
});

/**
 * THE THREE PURE HELPERS that turn a verdict into a decision. They are exported and tested
 * separately because BOTH token seams — `withBlockScope` and `authorizeBlockBridgeToken` —
 * consume them, and a rule stated twice is a rule that drifts.
 */
describe('shouldConsultMarker', () => {
  /**
   * 🔴 THE SKIP IS ON THE **TOKEN'S** SCOPES, NOT THE ROUTE'S. That is the whole correction
   * from the first version: testing the route's declared scope skipped the two scopes that
   * are never a declared scope, so revoking them enforced nothing.
   */
  it('is TRUE for an authed token carrying a consent-gated scope', () => {
    expect(shouldConsultMarker({ userId: USER, scopes: ['ai:write:budgeted'] })).toBe(true);
  });

  it('is TRUE for a token whose only gated scope is one no route ever declares', () => {
    // `posts:write:self` and `collections:read:private` appear ZERO times as a declared
    // `requiredScope` across `src/pages/api`. A skip keyed on the route would miss both.
    expect(shouldConsultMarker({ userId: USER, scopes: ['posts:write:self'] })).toBe(true);
    expect(
      shouldConsultMarker({
        userId: USER,
        scopes: ['collections:read:self', 'collections:read:private'],
      })
    ).toBe(true);
  });

  it('is FALSE for an anon subject (no user ⇒ no (user, app) marker can exist)', () => {
    expect(shouldConsultMarker({ userId: null, scopes: ['ai:write:budgeted'] })).toBe(false);
  });

  /**
   * The narrowing that keeps 20 of the 29 scope-bound REST routes out of the read AND out of
   * the fail-closed availability coupling: an all-exempt token cannot be affected by any
   * marker, because `blocks.revokeScopes` refuses to record a suppression for an exempt scope
   * and `partitionByConsent` signs them without consulting the grant at all.
   */
  it.each([
    ['per-user storage', ['apps:storage:read', 'apps:storage:write']],
    ['shared storage', ['apps:storage:shared:read', 'apps:storage:shared:write']],
    ['the exempt collections pair', ['collections:read:self', 'collections:write:self']],
    ['own-models read', ['models:read:self']],
  ])('is FALSE for a token carrying only exempt scopes (%s)', (_label, scopes) => {
    expect(shouldConsultMarker({ userId: USER, scopes })).toBe(false);
  });

  it('is FALSE for an empty scope list', () => {
    expect(shouldConsultMarker({ userId: USER, scopes: [] })).toBe(false);
  });
});

describe('revokedScopesForToken', () => {
  const TOKEN = ['ai:write:budgeted', 'posts:write:self', 'models:read:self'];

  it('`none` ⇒ nothing is revoked', () => {
    expect(revokedScopesForToken({ kind: 'none' }, TOKEN)).toEqual(new Set());
  });

  it('`revoked` ⇒ exactly the marker’s set, verbatim', () => {
    const scopes = new Set(['posts:write:self']);
    expect(revokedScopesForToken({ kind: 'revoked', scopes }, TOKEN)).toEqual(scopes);
  });

  /**
   * 🔴 `unavailable` FAILS CLOSED BY NAMING EVERY REVOKABLE SCOPE THE TOKEN CARRIES — and
   * NOT the exempt ones. Stripping an exempt scope during a Redis incident would refuse
   * `apps:storage:*` / `collections:read:self` traffic no revoke could ever have touched: a
   * self-inflicted outage on a population the feature does not apply to.
   *
   * MUTATION THAT MUST KILL THIS: return `new Set(scopes)` (all of them) or `new Set()` (none).
   */
  it('`unavailable` ⇒ every REVOKABLE scope in the token, and no exempt one', () => {
    const revoked = revokedScopesForToken({ kind: 'unavailable' }, TOKEN);
    expect(revoked).toEqual(new Set(['ai:write:budgeted', 'posts:write:self']));
    expect(revoked.has('models:read:self')).toBe(false);
  });

  it('`unavailable` on an all-exempt token revokes nothing', () => {
    expect(revokedScopesForToken({ kind: 'unavailable' }, ['models:read:self'])).toEqual(new Set());
  });
});

describe('applyRevocations', () => {
  /**
   * 🔴 THE STRIP IS THE ENFORCEMENT MECHANISM. Every consumer of a block token authorizes off
   * `claims.scopes` — the REST `requiredScope` check, the in-handler
   * `claims.scopes.includes('collections:read:private')` sub-checks, and every bridge
   * procedure. Removing the revoked members once is what makes all of them honour the revoke.
   */
  it('removes the revoked scopes and keeps the rest', () => {
    const claims = { scopes: ['a', 'b', 'c'], other: 1 };
    const out = applyRevocations(claims, new Set(['b']));
    expect(out.scopes).toEqual(['a', 'c']);
    // Everything else on the claims object survives — it is a token, not just a scope list.
    expect(out.other).toBe(1);
  });

  /**
   * Returns the SAME OBJECT when nothing changed, which both callers use as the cheap
   * "did this request lose a scope" test — the bridge emits its counter off exactly that.
   */
  it('returns the same object identity when nothing is revoked', () => {
    const claims = { scopes: ['a', 'b'] };
    expect(applyRevocations(claims, new Set())).toBe(claims);
    expect(applyRevocations(claims, new Set(['zzz']))).toBe(claims);
  });

  it('can empty the scope list entirely', () => {
    expect(applyRevocations({ scopes: ['a'] }, new Set(['a'])).scopes).toEqual([]);
  });
});

/**
 * 🔴 KEYSPACE DISJOINTNESS — the security control, pinned as a RELATIONSHIP over the three
 * keyspaces rather than as a spelling of any one of them.
 *
 * History, because this is not hypothetical: when the install and ban causes shared ONE key
 * carrying its cause as a VALUE, `toggleEnabled(false)` — an ordinary model owner, reachable
 * over tRPC — rewrote a ban marker's value to `install`, and `toggleEnabled(true)` then
 * deleted it, so a banned publisher's pre-ban token was accepted again. Separate keys make
 * that downgrade UNREPRESENTABLE. This is now a THIRD writer population (the viewer), so the
 * property has to hold three ways.
 */
describe('the consent keyspace cannot collide with either revocation keyspace', () => {
  const INSTALL = REDIS_KEYS.BLOCKS.REVOKED_INSTANCE;
  const BAN = REDIS_KEYS.BLOCKS.REVOKED_INSTANCE_BAN;
  const CONSENT = REDIS_KEYS.BLOCKS.CONSENT_REVOKED_SCOPES;

  it('POSITIVE CONTROL: all three constants are real, non-empty and distinct', () => {
    // Without this every "no collision" assertion below could pass on three empty strings.
    for (const k of [INSTALL, BAN, CONSENT]) {
      expect(typeof k).toBe('string');
      expect(k.length).toBeGreaterThan(5);
    }
    expect(new Set([INSTALL, BAN, CONSENT]).size).toBe(3);
  });

  /**
   * 🔴 PREFIX-DISJOINT AT THE SEGMENT BOUNDARY, NOT MERELY UNEQUAL. Every one of these
   * constants is used as `<constant>:<suffix>`, so inequality is not enough: if one
   * constant were a prefix of another AND the boundary were not a `:`, a suffix could
   * straddle them and one writer's key could land inside another's space.
   *
   * `blocks:revoked-instance` IS a string-prefix of `blocks:revoked-instance-ban`, which is
   * exactly why this is tested at the boundary rather than with `startsWith`: the next
   * character is `-`, not `:`, so `blocks:revoked-instance:<id>` and
   * `blocks:revoked-instance-ban:<id>` can never be the same key. A future constant that
   * differed only AFTER a `:` would be the real hazard, and this is what catches it.
   */
  it('no constant is a COLON-boundary prefix of another', () => {
    const all = [INSTALL, BAN, CONSENT];
    for (const a of all) {
      for (const b of all) {
        if (a === b) continue;
        expect(
          b.startsWith(`${a}:`),
          `"${a}" is a colon-boundary prefix of "${b}", so a key built as "${a}:<suffix>" ` +
            `can land inside the "${b}" keyspace. The three writer populations — install ` +
            `(model owner), ban (moderator) and consent (the viewer) — must not be able to ` +
            `address each other's markers.`
        ).toBe(false);
      }
    }
  });

  /**
   * The behavioural half of the same claim: a real consent key, built by the module, is not
   * addressable by either `BlockRevocation` keyspace's own key shape. Structural
   * disjointness of the CONSTANTS is necessary; this checks the CONSTRUCTED keys, which is
   * what Redis actually sees.
   */
  it('a published consent key falls in neither revocation keyspace', async () => {
    await ConsentRevocation.publish({ userId: USER, appBlockId: APP, revokedScopes: ['x'] });
    const key = redisMock.redis.set.mock.calls[0][0] as string;
    expect(key.startsWith(`${CONSENT}:`)).toBe(true);
    expect(key.startsWith(`${INSTALL}:`)).toBe(false);
    expect(key.startsWith(`${BAN}:`)).toBe(false);
  });

  /**
   * 🔴 AND IT IS KEYED ON A DIFFERENT SUBJECT, which is the deeper reason the keyspaces
   * cannot be merged rather than just "they are different strings". `BlockRevocation` keys
   * on a `blockInstanceId`; consent is per (user, app). The same app installed on four
   * models mints four instance ids, and one revoke has to reach all of them.
   */
  it('is keyed on (userId, appBlockId), not on a blockInstanceId', async () => {
    await ConsentRevocation.publish({ userId: 7, appBlockId: 'apb_other', revokedScopes: ['x'] });
    expect(redisMock.redis.set.mock.calls[0][0]).toBe(
      `${REDIS_KEYS.BLOCKS.CONSENT_REVOKED_SCOPES}:7:apb_other`
    );
    // Two different viewers of the SAME app get different keys — without this, a revoke by
    // one user would refuse every other user of that app.
    redisMock.redis.set.mockClear();
    await ConsentRevocation.publish({ userId: 8, appBlockId: 'apb_other', revokedScopes: ['x'] });
    expect(redisMock.redis.set.mock.calls[0][0]).not.toBe(
      `${REDIS_KEYS.BLOCKS.CONSENT_REVOKED_SCOPES}:7:apb_other`
    );
  });
});
