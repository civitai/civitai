import { redis, REDIS_KEYS } from '~/server/redis/client';
import { MAX_BLOCK_TOKEN_LIFETIME_SECONDS } from '~/server/services/block-token-lifetimes';

// A marker shorter than the token it revokes lapses while that token is still
// accepted, and the gate reads a missing key as "not revoked" — the control
// stops refusing without failing. Same relationship key-rotation overlap states
// in block-token.service.ts; deriving it is what stops the two drifting again.
const REVOCATION_TTL_SECONDS = MAX_BLOCK_TOKEN_LIFETIME_SECONDS;

/** The INSTALL keyspace: uninstall and toggle-off. Clearable by the install's consumer. */
function revokedKey(blockInstanceId: string) {
  return `${REDIS_KEYS.BLOCKS.REVOKED_INSTANCE}:${blockInstanceId}` as const;
}

/** The BAN keyspace. Only the ban writer and the unban clearer can address it. */
function bannedKey(blockInstanceId: string) {
  return `${REDIS_KEYS.BLOCKS.REVOKED_INSTANCE_BAN}:${blockInstanceId}` as const;
}

/**
 * The SUBJECT-SCOPED ban keyspace, for instance ids that are NOT globally unique.
 *
 * 🔴 ONE SHAPE NEEDS THIS AND IT IS NOT A REFINEMENT — WITHOUT IT A BAN 403s AN
 * INNOCENT ACCOUNT. Every other instance id is derived from a globally unique row id
 * (`bki_*`, `bus_*` from a subscription id, `pdb_*`/`page_*` from an AppBlock id,
 * `page_pubreq_*` from a publish-request id), so the id names exactly one app and a
 * global marker is correct — those tokens are legitimately held by many viewers and all
 * of them must be refused.
 *
 * `page_ephemeral-<slug>` is the exception: the slug is chosen by the developer and
 * `resolveEphemeralDevPageBlock` only refuses one already claimed by an AppBlock row or
 * a pending request — it never consults tunnels — while `startDevTunnel` enforces
 * uniqueness per `(user, blockId)` ONLY. So two authors can hold live tunnels on the
 * same unclaimed slug and BOTH mint `page_ephemeral-<slug>`. A global marker written
 * when one is banned would refuse the other's own dev tunnel for up to 4h, and that
 * other account did nothing. The token is self-bound (`sub` is the tunnel owner), so
 * scoping the marker to the subject refuses exactly the banned holder.
 *
 * It also makes the dev-tunnel index's staleness harmless rather than dangerous: a
 * member the reaper's orphan branch could not remove (it has no session record to read
 * a userId/blockId from) now yields a marker only under its OWN owner's key.
 */
function bannedSubjectKey(blockInstanceId: string, subject: string) {
  return `${REDIS_KEYS.BLOCKS.REVOKED_INSTANCE_BAN}:${subject}:${blockInstanceId}` as const;
}

/**
 * Whether an instance id's ban marker lives in the SUBJECT-SCOPED keyspace.
 *
 * 🔴 ONE PREDICATE, TWO CONSUMERS, AND THAT IS THE POINT. The ban WRITER uses it to pick
 * the keyspace and `isRevoked` uses it to decide whether the scoped key is worth reading.
 * Open-coded at the two sites these would drift, and the failure is silent in the worst
 * direction: a writer that scopes while a reader does not look leaves the marker
 * unreadable, so the ban refuses nobody and every test that checks the KEY still passes.
 *
 * It also keeps the read cheap. Without the gate `isRevoked` issued a third GET on EVERY
 * REST and bridge request — including the `pollWorkflow` polling ones — for a key that
 * only one of five `page_` sub-shapes can ever carry, and that can never exist for an
 * `anon` subject. ~50% more round-trips on the hot path for a guaranteed miss.
 */
export function isSubjectScopedInstanceId(blockInstanceId: string): boolean {
  return blockInstanceId.startsWith('page_ephemeral-');
}

/**
 * The token `sub` a given userId mints as.
 *
 * ⚠️ MOVED to `~/server/services/block-token-subject` and re-exported here so this
 * module's existing importers are unchanged. The docblock that used to sit on the
 * definition claimed this was "THE ONE PLACE this format is written on the WRITE side",
 * and that was FALSE even when written: `block-token.service.ts`'s mint open-coded the
 * same template, so the ban writer and the thing that actually stamps every JWT were two
 * copies agreeing by coincidence. clawgate #571's approval guard would have been a
 * third. The claim is now true, of the leaf — see that module for why it is a leaf.
 *
 * Still pinned by `__tests__/subject-key-round-trip.test.ts`, which feeds it through
 * `parseSubjectUserId` — the READ side's parser — and back; and the hand-typed
 * `:user:<id>:` literal in `services/__tests__/ban-revokes-block-instances.test.ts`
 * independently reds on a spelling change, pinning the KEY rather than this function.
 */
export { subjectForUserId } from '~/server/services/block-token-subject';

/**
 * Per-blockInstanceId token revocation, written when an install is uninstalled,
 * toggled off, or its publisher is banned. Tokens for the revoked instance are
 * rejected by the block-scope middleware until the marker's TTL elapses.
 *
 * 🔴 TWO KEYSPACES, AND THE SEPARATION IS THE SECURITY CONTROL. An INSTALL marker
 * (`uninstallFromModel`, `toggleEnabled(false)`) and a BAN marker
 * (`revokeBlockInstancesForPublisher`, from `toggleBan`) are written by different
 * methods to different keys, and `isRevoked` refuses if EITHER is present.
 *
 * This replaced a single key carrying its cause as its VALUE, which did not hold:
 * `toggleEnabled(false)` calls `revokeInstance` with no cause, so an ordinary
 * un-banned model owner disabling a banned publisher's install rewrote the ban
 * marker's value to `install`, and `toggleEnabled(true)` then cleared it — the
 * publisher's pre-ban token was accepted again. Measured end-to-end on the real
 * `BlockRegistry.toggleEnabled` pair. A value-guarded write would have been a
 * read-modify-write with a race in it; separate keys make the downgrade
 * UNREPRESENTABLE, because the install path has no way to name this key.
 *
 * 🔴 THE BAN LEG IS REAL NOW — AND THIS DOCBLOCK HAS CLAIMED IT BEFORE IT WAS.
 * It once listed "or the publisher is banned" with no such writer in the tree,
 * and was then corrected to say no ban path writes a marker. As of clawgate #618
 * a writer exists, so the correction is stale in turn. The INSTALL writer
 * `revokeInstance` has exactly two production call sites, `uninstallFromModel`
 * and `toggleEnabled(false)` (both `block-registry.service.ts`); the BAN writer
 * `revokeInstanceForBan` has exactly one, `revokeBlockInstancesForPublisher`
 * (`blocks/publisher-ban-revocation.service.ts`), reached from `toggleBan`.
 * Read that writer's docblock before reasoning about the ban path: it covers
 * blocks the banned user OWNS, not ones they hold a collaborator seat on.
 *
 * This is a deliberately coarse-grained revocation primitive (per-instance,
 * not per-jti). A per-jti denylist is heavier infra and gains little for v1
 * volumes — the same outcome at lower cost.
 */
export class BlockRevocation {
  /**
   * INSTALL-cause revocation: the install went away or was switched off. Clearable by
   * `clearInstance`, which the re-enable path calls. Cannot address the ban keyspace.
   */
  static async revokeInstance(blockInstanceId: string): Promise<void> {
    try {
      await redis.set(revokedKey(blockInstanceId), '1', { EX: REVOCATION_TTL_SECONDS });
    } catch {
      // Fail open: an uninstall/toggle write path must not block on a
      // Redis incident. If the marker isn't written, tokens for this
      // instance remain valid until natural exp — exposure is bounded by the
      // token lifetime rather than by Redis-recovery time. Accepted tradeoff.
    }
  }

  /**
   * BAN-cause revocation. Separate key, so no install-path write can overwrite it and
   * no install-path clear can delete it. Cleared only by {@link clearBanInstance}, which
   * only `toggleBan`'s unban branch calls.
   */
  static async revokeInstanceForBan(
    blockInstanceId: string,
    opts: { subject?: string } = {}
  ): Promise<void> {
    try {
      const key = opts.subject
        ? bannedSubjectKey(blockInstanceId, opts.subject)
        : bannedKey(blockInstanceId);
      await redis.set(key, '1', { EX: REVOCATION_TTL_SECONDS });
    } catch {
      // Fail open, for the same reason as the install path: a Redis incident must not
      // be able to fail a ban. Exposure stays bounded by the token lifetime.
    }
  }

  /**
   * True when EITHER keyspace holds a marker.
   *
   * 🔴 TWO GETs — THREE only for a subject-scoped id — PIPELINED, NOT ONE ROUND TRIP. This said "ONE ROUND TRIP, NOT TWO" and
   * that was false: `packages/civitai-redis/src/client.ts` WRAPS `mGet` to fetch keys
   * individually (`Promise.all(keys.map(get))`) so a multi-key read cannot CROSSSLOT on
   * the cluster, and the array path never reaches the native `MGET`. Wall-clock is
   * likely unchanged — both GETs are issued in the same tick and pipeline — but the
   * COMMAND RATE against the cache cluster is doubled on every REST and bridge request,
   * including the polling ones. That is the honest cost of splitting the keyspaces, and
   * it is the price of making a ban marker unoverwritable; it is not a free win.
   *
   * `mGet` is still the right call rather than two awaited `get`s: it keeps the two
   * reads in one tick instead of serialising them. The order of the returned values does
   * not matter — either key present means revoked.
   */
  static async isRevoked(blockInstanceId: string, subject?: string): Promise<boolean> {
    try {
      // `subject` is the token's own `sub`. FOUR production call sites pass it —
      // `withBlockScope` (`block-scope.middleware.ts`), `authorizeBlockBridgeToken`
      // (`blocks/block-bridge-auth.service.ts`), `resolveStorageContext`
      // (`routers/apps.router.ts`) and `resolveSharedContext`
      // (`routers/apps-shared.router.ts`). An earlier version of this sentence said "both
      // guards", and two of the four were passing nothing: they read only the global keys
      // while the ephemeral marker exists solely under the subject key. Latent, because
      // both tRPC paths require an `approved` AppBlock row and an ephemeral app has none —
      // but latent in the direction this work keeps moving (storage for unsubmitted apps).
      //
      // Omitting it only NARROWS the check — the scoped keyspace is not consulted — so a
      // caller without a subject degrades to the pre-existing behaviour rather than to a
      // wrong answer. That is why the gap was silent.
      const keys = [revokedKey(blockInstanceId), bannedKey(blockInstanceId)];
      // The third key is read ONLY for the one shape that can carry it — see
      // `isSubjectScopedInstanceId`. Everything else pays two GETs, as before.
      if (subject && isSubjectScopedInstanceId(blockInstanceId)) {
        keys.push(bannedSubjectKey(blockInstanceId, subject));
      }
      const values = await redis.mGet<string>(keys);
      return values.some((v) => v != null);
    } catch {
      // Fail open — never block legitimate traffic on a Redis incident.
      return false;
    }
  }

  /**
   * Clears an INSTALL revocation marker. Every path that brings an install back — both
   * `toggleEnabled(true)` and `installOnModel` on an existing row — must call
   * it: blockInstanceId is preserved across disable, so the marker written
   * then otherwise survives, and 403s the revived install's tokens for the
   * rest of REVOCATION_TTL_SECONDS (audit B1).
   *
   * 🔴 IT CANNOT REACH A BAN MARKER, AND THAT IS STRUCTURAL RATHER THAN CHECKED. Both
   * callers are reachable by the install's CONSUMER — a model owner, a different and
   * un-banned account — so a shared key let them undo a moderation action. This function
   * addresses the install keyspace only; there is no branch to get wrong and no
   * read-modify-write to race. The earlier value-guard here is gone because the guard was
   * the wrong half of the problem: the unguarded WRITE in front of it did the damage.
   */
  static async clearInstance(blockInstanceId: string): Promise<void> {
    try {
      await redis.del(revokedKey(blockInstanceId));
    } catch {
      // fail open
    }
  }

  /**
   * Clears a BAN revocation marker. Called ONLY by `toggleBan`'s unban branch, via
   * `clearBlockInstancesForPublisher`.
   *
   * 🔴 THIS EXISTS BECAUSE "re-minting is the recovery path" WAS FALSE. That sentence
   * sat in this file, in the ban writer and in clawgate #618's own AC-3, and measurement
   * refuted all three: `isRevoked` keys on `claims.blockInstanceId`, and every namespace's
   * instance id is STABLE across a re-mint (`bki_*` is a stored column; `bus_pub_*`,
   * `bus_view_*`, `pdb_*` and `page_*` are derived from row ids that do not change). So a
   * freshly minted token carries the same id the marker names and is refused just the
   * same. Without a clear, a mis-ban that is immediately lifted still killed the
   * publisher's entire block surface for up to MAX_BLOCK_TOKEN_LIFETIME_SECONDS with no
   * product-level remedy at all — a moderator would have had to delete Redis keys by
   * hand. `block-registry.service.ts`'s re-enable comment stated this correctly for the
   * install marker the whole time; these two now agree.
   */
  static async clearBanInstance(
    blockInstanceId: string,
    opts: { subject?: string } = {}
  ): Promise<void> {
    try {
      const key = opts.subject
        ? bannedSubjectKey(blockInstanceId, opts.subject)
        : bannedKey(blockInstanceId);
      await redis.del(key);
    } catch {
      // fail open — the marker expires on its own within one token lifetime.
    }
  }
}
