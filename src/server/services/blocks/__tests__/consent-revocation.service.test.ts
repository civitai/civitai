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
import { ConsentRevocation } from '../consent-revocation.service';

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
 *   2. IT IS PER-SCOPE. A boolean marker would refuse the app's entire surface for up to a
 *      token lifetime because the viewer withdrew ONE permission.
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

describe('ConsentRevocation.isScopeRevoked', () => {
  it('is FALSE when no marker exists (the common case, one GET)', async () => {
    redisMock.redis.get.mockResolvedValueOnce(null);
    expect(
      await ConsentRevocation.isScopeRevoked({
        userId: USER,
        appBlockId: APP,
        scope: 'ai:write:budgeted',
      })
    ).toBe(false);
    expect(redisMock.redis.get).toHaveBeenCalledWith(EXPECTED_KEY);
  });

  it('is TRUE for a scope the marker lists', async () => {
    redisMock.redis.get.mockResolvedValueOnce(JSON.stringify(['ai:write:budgeted']));
    expect(
      await ConsentRevocation.isScopeRevoked({
        userId: USER,
        appBlockId: APP,
        scope: 'ai:write:budgeted',
      })
    ).toBe(true);
  });

  /**
   * 🔴 THE NARROWING, AND IT IS THE CONTROL THAT MAKES THE TEST ABOVE ATTRIBUTABLE. Without
   * it, an implementation that returned `true` whenever the key exists — a per-app boolean
   * — passes every other assertion in this block while breaking an app's unrelated
   * rendering for up to four hours because the viewer withdrew one permission.
   */
  it('is FALSE for a DIFFERENT scope, even though a marker exists', async () => {
    redisMock.redis.get.mockResolvedValue(JSON.stringify(['posts:write:self']));
    expect(
      await ConsentRevocation.isScopeRevoked({
        userId: USER,
        appBlockId: APP,
        scope: 'ai:write:budgeted',
      })
    ).toBe(false);
    // And the listed one IS refused in the same world, so this is not "false for
    // everything".
    expect(
      await ConsentRevocation.isScopeRevoked({
        userId: USER,
        appBlockId: APP,
        scope: 'posts:write:self',
      })
    ).toBe(true);
  });

  /**
   * 🔴 FAIL CLOSED ON A REDIS ERROR.
   *
   * MUTATION THAT MUST KILL THIS: change the `catch` in `isScopeRevoked` to `return false`
   * (i.e. align it with `BlockRevocation.isRevoked`, which is the tempting "cleanup").
   */
  it('FAILS CLOSED when Redis throws', async () => {
    redisMock.redis.get.mockRejectedValueOnce(new Error('connection reset'));
    expect(
      await ConsentRevocation.isScopeRevoked({
        userId: USER,
        appBlockId: APP,
        scope: 'ai:write:budgeted',
      }),
      'a Redis error made the consent-revocation guard report NOT revoked. That is the ' +
        'fail-OPEN posture of BlockRevocation.isRevoked, which is deliberate THERE and ' +
        'wrong here: this marker exists because a user asked for a permission to stop ' +
        'being granted and was told it was done.'
    ).toBe(true);
  });

  /**
   * 🔴 AND CLOSED ON AN UNPARSEABLE MARKER, which is the same situation in different
   * clothes: the key EXISTS, so something published a revocation, and we cannot tell which
   * scopes it covered. Reading it as "nothing revoked" turns a corrupt write — or a format
   * change rolled out to some pods first — into a silent fail-open.
   */
  it.each([
    ['not JSON at all', 'not-json'],
    ['JSON but not an array', '{"scope":"ai:write:budgeted"}'],
    ['an array of non-strings', '[1,2,3]'],
    ['the legacy boolean marker shape', '1'],
  ])('FAILS CLOSED on a malformed marker (%s)', async (_label, raw) => {
    redisMock.redis.get.mockResolvedValueOnce(raw);
    expect(
      await ConsentRevocation.isScopeRevoked({
        userId: USER,
        appBlockId: APP,
        scope: 'ai:write:budgeted',
      })
    ).toBe(true);
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
