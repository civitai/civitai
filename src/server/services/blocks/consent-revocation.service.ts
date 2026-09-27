import { redis, REDIS_KEYS } from '~/server/redis/client';
import { MAX_BLOCK_TOKEN_LIFETIME_SECONDS } from '~/server/services/block-token-lifetimes';

/**
 * PER-SCOPE CONSENT REVOCATION, ENFORCED ON TOKENS ALREADY IN FLIGHT.
 *
 * ## The window this closes
 *
 * `app_user_scope_grants` is read at MINT. The block-JWT path
 * (`block-scope.middleware.ts`) then trusts `claims.scopes` verbatim — only the
 * hub-OAuth path re-derives from the grant — so writing a revocation to Postgres is
 * invisible to a token that was already signed, for up to its remaining life: 900s
 * default, 300s settings-scoped, 4h dev (`block-token-lifetimes.ts`). A user who clicks
 * "remove this permission" and watches the app keep using it for four hours has been told
 * something untrue by the UI.
 *
 * This marker is what makes the revoke take effect at the next REQUEST rather than at the
 * next mint. It is written by `blocks.revokeScopes` in the same mutation as the Postgres
 * write, and read by the block-scope middleware beside `BlockRevocation.isRevoked`.
 *
 * ## 🔴 IT FAILS **CLOSED**, AND `BlockRevocation` FAILS **OPEN** — ON PURPOSE
 *
 * The two look like the same kind of control and are not, so this is stated in both
 * modules rather than in one:
 *
 *   - `BlockRevocation.isRevoked` swallows a Redis error and returns `false` (not
 *     revoked). Its markers are a SIDE EFFECT of uninstall / toggle-off / publisher-ban —
 *     operations whose own success must not depend on Redis — and its exposure is already
 *     bounded by the token lifetime. Blocking legitimate traffic fleet-wide on a cache
 *     incident buys nothing there, because the thing being protected (an install that has
 *     gone away) has no ongoing user asking for it.
 *   - THIS one refuses on a Redis error. The marker exists because a USER asked for access
 *     to stop, NOW. "The cache was down so we kept granting the permission you revoked"
 *     is not a degradation of that promise, it is the promise not being kept — and unlike
 *     the uninstall case there is a person on the other end who was told it was done.
 *
 * 🔴 THE TWO READS THEREFORE CANNOT SHARE ONE `mGet`, and that is not an oversight worth
 * "tidying". One call has one `catch`, and these two need opposite ones. Folding them
 * would silently convert whichever half lost the argument.
 *
 * 🔴 THE PRICE, STATED PLAINLY: a Redis outage refuses every authed, scope-bound block
 * REST request. That is a real availability coupling on the whole App Blocks REST
 * surface, accepted as the cost of the guarantee above. It is narrowed by only reading at
 * all when a read could matter (see `isScopeRevoked`'s two skips), which keeps anon and
 * any-token-mode traffic out of it entirely, but it is not eliminated.
 *
 * ## Why the value carries the scope set
 *
 * A per-(user, app) boolean would refuse the app's ENTIRE surface for up to a token
 * lifetime because the viewer withdrew one permission — so revoking `posts:write:self`
 * would break a block's unrelated `models:read:self` rendering. The value is a JSON array
 * of revoked scopes and the guard compares the route's OWN required scope against it, so
 * the refusal is as narrow as the revoke was.
 */

/**
 * TTL = the longest token this marker must outlive.
 *
 * 🔴 DERIVED, NEVER A LITERAL. `block-revocation.service.ts` states the same rule and the
 * same history: a marker shorter than the token it revokes lapses while that token is
 * still accepted, and a missing key reads as "not revoked" — the control stops refusing
 * without failing. That is precisely how `REVOKED_INSTANCE`'s TTL sat at 15 minutes for
 * the whole time `dev:live` tokens lived 4 hours. A new token kind added to
 * `BLOCK_TOKEN_LIFETIMES_SECONDS` raises this automatically.
 */
const CONSENT_REVOCATION_TTL_SECONDS = MAX_BLOCK_TOKEN_LIFETIME_SECONDS;

/**
 * `<prefix>:<userId>:<appBlockId>`.
 *
 * Keyed on the pair the GRANT is keyed on — not on `blockInstanceId`, which is what the
 * two `BlockRevocation` keyspaces use. A viewer's consent is per (user, app): the same
 * app can be installed on many models and minted under several instance-id namespaces,
 * and a revoke has to reach all of them.
 */
function consentRevokedKey(userId: number, appBlockId: string) {
  return `${REDIS_KEYS.BLOCKS.CONSENT_REVOKED_SCOPES}:${userId}:${appBlockId}` as const;
}

export class ConsentRevocation {
  /**
   * Publishes the viewer's CURRENT full suppression list for one app.
   *
   * 🔴 WRITES THE WHOLE LIST, NOT A DELTA. The caller has just computed
   * `revoked_scopes` in Postgres; writing that same set makes the marker a snapshot of
   * the authoritative row rather than an accumulating side channel that could disagree
   * with it. It also makes a re-consent expressible: `grantScopes` lifts suppressions in
   * Postgres and re-publishes the narrower list here, so the lifted scope stops being
   * refused immediately instead of waiting out the TTL.
   *
   * 🔴 THROWS ON A REDIS FAILURE, unlike `BlockRevocation.revokeInstance`, which swallows
   * one. Same asymmetry as the read, and for the same reason: the caller is a mutation
   * whose entire purpose is this revocation. If the marker cannot be written the viewer
   * must be told the revoke is only partially in force (the Postgres row IS written and
   * governs every future mint) rather than being shown a success that silently leaves an
   * in-flight token spending for up to four hours. The router turns this into a
   * user-visible error naming both halves.
   *
   * An EMPTY list deletes the key rather than storing `[]`: nothing is revoked, so there
   * is no reason to make every request pay a hit that can only ever answer "no".
   */
  static async publish(opts: {
    userId: number;
    appBlockId: string;
    revokedScopes: string[];
  }): Promise<void> {
    const key = consentRevokedKey(opts.userId, opts.appBlockId);
    if (opts.revokedScopes.length === 0) {
      await redis.del(key);
      return;
    }
    await redis.set(key, JSON.stringify(opts.revokedScopes), {
      EX: CONSENT_REVOCATION_TTL_SECONDS,
    });
  }

  /**
   * Whether `scope` is currently revoked for this (user, app) — FAIL CLOSED.
   *
   * Outcomes, all four of them deliberate:
   *   - no key                → `false`. The overwhelmingly common case; one GET, one miss.
   *   - key present, listed   → `true`. The refusal this whole module exists for.
   *   - key present, NOT listed → `false`. The narrowing described in the module docblock:
   *                             a viewer who revoked one permission has not revoked the
   *                             others, and refusing them would break the app for a
   *                             reason the user did not ask for.
   *   - Redis threw, OR the value would not parse as a string array → `true`.
   *
   * 🔴 THAT LAST ARM IS THE POINT AND IT COVERS **BOTH** FAILURES. A throw is the obvious
   * one. A value that does not parse is the same situation wearing different clothes: the
   * key EXISTS, so something published a revocation, and we cannot tell which scopes it
   * covered. Reading an unparseable marker as "nothing revoked" would turn a corrupt write
   * — or a future format change rolled out to some pods first — into a silent
   * fail-open on the one control a user explicitly asked for. Refuse and be wrong in the
   * direction that is recoverable by re-consenting.
   */
  static async isScopeRevoked(opts: {
    userId: number;
    appBlockId: string;
    scope: string;
  }): Promise<boolean> {
    try {
      const raw = await redis.get(consentRevokedKey(opts.userId, opts.appBlockId));
      if (raw == null) return false;
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed) || parsed.some((s) => typeof s !== 'string')) return true;
      return (parsed as string[]).includes(opts.scope);
    } catch {
      // FAIL CLOSED — see the docblock. Covers both the Redis error and a JSON.parse
      // throw on a malformed value.
      return true;
    }
  }
}
