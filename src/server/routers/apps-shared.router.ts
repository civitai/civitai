// App Blocks SHARED (app-global / cross-user) storage tRPC router.
//
// Mounted at `trpc.apps.shared.*` (block-token authed) + `trpc.apps.mod.*`
// (session moderatorProcedure). This is the FIRST App Blocks surface that opens
// the per-app datastore to PUBLIC cross-user writes. The per-user KV path
// (apps.router) is scoped by every query to the writer's OWN
// (block_instance_id, user_id) rows, and is gated on the RUN capability
// (`app-blocks-enabled`, via apps.router's `assertAppBlocksEnabledForTokenUser`).
// It is NO LONGER limited to app authors: `assertViewerIsAppDeveloper` left that
// path when per-user storage was re-gated on the run capability, and now guards
// only the mod review-preview ("run for real") branch. That is CLOSE TO, but not
// identical to, "whoever may open the app at all" — the block-token mint gates on
// `getFeatureFlags({ user }).appBlocks`, which falls back to the static
// `availability: ['mod']` evaluation when Flipt returns null, whereas
// `isAppBlocksEnabled` has no mod floor. So with Flipt unavailable a moderator can
// mint a token that the per-user KV gate then refuses: a divergence in the SAFE
// direction, on a path that is already degraded.
//
// Here, by contrast, a write is readable, votable and reportable by OTHER users
// of the app, which is what every control below (min-trust, per-user row cap,
// rate limits, revocation, content safety) is answering. The security review that
// motivated those controls is not a document in this repo; the rationale that
// survives is the per-control comments below — read those before touching
// auth/counter/trust logic.
//
// Data model (per-app schema `app_<slug>`, provisioned by AppStorageProvisioner):
//   - shared_kv(key ULID PK [SERVER-generated], author_user_id, value jsonb, …)
//   - votes(key→shared_kv ON DELETE CASCADE, user_id, PK(key,user_id))
//   - counters(key→shared_kv ON DELETE CASCADE, count>=0)  ← reconstructable cache
//   - shared_kv_reports(id, key, reporter_user_id, reason, …)
//
// Invariants (design "Isolation confirmed SAFE"):
//   - schema derived from sanitizeAppSlug(claims.blockId) → app A can't reach app B
//   - shared:read touches ONLY shared_kv/counters, NEVER the per-user `kv`
//   - `votes` is NEVER listable — only the aggregate `count` is returned
//   - votes/counters are OUT of the byte-quota; a per-user shared_kv row cap applies

import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import { dbRead } from '~/server/db/client';
import { requireAppsDb } from '~/server/db/appsDb';
import { appSchemaIdent, sanitizeAppSlug } from '~/server/utils/apps-slug';
import { newUlid } from '~/server/utils/app-block-ids';
import { parseSubjectUserId, verifyBlockToken } from '~/server/middleware/block-scope.middleware';
import { BlockRevocation } from '~/server/services/block-revocation.service';
import { logToAxiom } from '~/server/logging/client';
import { escalateToServerFault } from '~/server/logging/server-fault-override';
import { FLIPT_FEATURE_FLAGS, getFliptBoolean } from '~/server/flipt/client';
import { isAppBlocksSharedStorageEnabled } from '~/server/services/app-blocks-flag';
import {
  assertSharedWriteTrust,
  hasLinkedOAuthAccount,
} from '~/server/services/blocks/block-write-trust.service';
import { sessionClient } from '~/server/auth/session-client';
import type { SessionUser } from '~/types/session';
import type { SyncSubListingForSharedRowArgs } from '~/server/services/blocks/app-sub-listing.service';
import {
  assertSharedTextSafe,
  SharedContentBlockedError,
  SHARED_TITLE_MAX,
  SHARED_BODY_MAX,
} from '~/server/services/apps/shared-content-safety';
import {
  blockingHit,
  recordSharedDataScan,
  resolveSharedDataModerationMode,
  scanCounterKey,
  scanSharedData,
  scheduleSharedDataShadow,
  type SharedDataModerationMode,
  type SharedDataSurface,
  type SharedTextHit,
  type SharedTextScan,
} from '~/server/services/apps/shared-data-moderation';
import {
  checkSharedAppendRateLimit,
  checkSharedVoteRateLimit,
  checkSharedReportRateLimit,
  checkSharedWithdrawRateLimit,
} from '~/server/utils/shared-storage-rate-limit';
import { moderatorProcedure, publicProcedure, router } from '~/server/trpc';
import { appsModUserStorageRouter } from '~/server/routers/apps-mod-storage.router';

// ── Limits (design M2/M3) ─────────────────────────────────────────────────────
// The app quota row is SHARED with the per-user kv path; these mirror the
// apps.router ceilings so shared writes and per-user writes share one 50MB / 1M
// budget. Votes/counters/reports carry NO quota trigger → excluded from bytes.
const APP_QUOTA_BYTES = 50 * 1024 * 1024;
const APP_ROW_LIMIT = 1_000_000;
// Per individual shared value (the whole jsonb: the moderated title+body PLUS the
// optional opaque app-owned `data` blob). Raised from 8KB → 64KB so apps can store
// real structured state in `data`; still tightly bounded and enforced BEFORE the DB
// write, and the bytes count toward the per-app `size_bytes`/quota + row caps below.
//
// 🔴 ENFORCED IN THE WIRE UNIT — `Buffer.byteLength(JSON.stringify(value))` — and
// deliberately so: it bounds what one call SENDS, which is the only quantity a
// block can predict for itself before it writes. It is NOT the unit the byte
// QUOTA is accounted in, and the two diverge by far more than they look: measured
// through this path, a value of 65,532 wire bytes (9,358 copies of `5e-324`, which
// jsonb normalises to their full 326-digit expansions) stores 3,069,452 — 46.8x; the
// same shape built from `1e308` stores 2,910,366, so this is a measurement of two
// candidates and NOT a maximum. So this cap does not bound stored bytes at all, and a
// wire byte count must never be reused in a quota comparison — see
// `STORED_SIZE_PROBE_SQL` below, and the units block in `app-storage.service`'s
// `set` for the full measurements.
const SHARED_VALUE_BYTE_CAP = 64 * 1024;
// Per-USER row cap on shared_kv (design M2): one hostile-but-trusted account can't
// exhaust the app row budget on its own.
const SHARED_KV_PER_USER_ROW_CAP = 50;

/**
 * The projection that yields the number of bytes `shared_kv.size_bytes` will hold
 * for the value about to be written — i.e. the unit `quota.used_bytes` is accounted
 * in, and the ONLY unit a comparison against APP_QUOTA_BYTES may be made in.
 *
 * ONE fragment, selected into the quota read on BOTH write paths, so the two gates
 * cannot drift apart. `$2` is the serialized value on both; `$1` is the app block
 * id. Pair it with `requireStoredSize` to read the result.
 *
 * 🔴 WHY THIS EXISTS AND WHY IT ASKS POSTGRES. `shared_kv.size_bytes` is
 * `GENERATED ALWAYS AS (octet_length(value::text))` over a JSONB column
 * (`storage-provision.service`), and `shared_kv_quota_trg` reuses
 * `kv_quota_trigger`, which sums exactly that column into `quota.used_bytes`. So
 * both the stored per-row weight and the app counter are in STORED bytes.
 * Postgres' jsonb output function is not `JSON.stringify`: it emits `, ` after
 * every separator and `: ` after every object key. Measured against Postgres,
 * `[1,2,3]` stores 9 bytes where `JSON.stringify` gives 7, and a 5,000-element
 * integer array stores 15,000 against 10,001 — a 1.5x RATIO. The ratio is what
 * matters, not the gap: a shared value is always a JSON object, so a title-only
 * value diverges by exactly the one `: ` after its single key — one byte, however
 * long the title — which is why a title-only fixture makes a wire-unit gate look
 * correct and can see none of this.
 *
 * Holding the NEW side of a quota comparison in the wire unit was a REPEATABLE
 * BYPASS of the app byte ceiling, in both shapes it appears in:
 *   - `append` compared `usedBytes + <wire>` against the cap, so every create was
 *     charged ~1/1.5x (and, on the shapes measured above, up to 46.8x less) than it
 *     actually stored;
 *   - `update` compared `usedBytes + (<wire> − <stored old>)`, a subtraction
 *     between two different units. Submitting any value whose WIRE size is at or
 *     below the row's CURRENT STORED size holds that delta at or below zero
 *     forever, so the gate passes unconditionally while the trigger charges the
 *     true stored growth — repeatable, with no ceiling ever binding. This is the
 *     same class already fixed on the per-user path; see the units block in
 *     `app-storage.service`'s `set`.
 *
 * This is a PREDICTION of what the write will store, not a read of what it stored —
 * it is evaluated before the INSERT/UPDATE. It is exact for the reason the two agree
 * at all: identical input text through identical casts (`$2::jsonb`, then jsonb →
 * text) evaluated by the same server. That identity is asserted against rows
 * Postgres actually wrote in
 * `src/server/routers/__tests__/apps-shared.router.quota.stored-units.behavior.test.ts`,
 * not in prose here.
 *
 * It is selected WITHOUT a FROM clause, as a sibling of two scalar subqueries over
 * `quota`, rather than as a column of a `FROM quota` select. That shape returns
 * exactly one row on every Postgres whether or not the app has a quota row, which
 * keeps the pre-existing "missing quota row counts as 0" behaviour intact instead of
 * turning it into a hard failure. It also costs no extra round trip.
 */
const STORED_SIZE_PROBE_SQL = `octet_length($2::jsonb::text) AS stored_size_bytes`;

/**
 * Read the `STORED_SIZE_PROBE_SQL` result, or fail loudly.
 *
 * Throws a plain Error (not a TRPCError → a 500, not a refusal): the probe sits in a
 * FROM-less select, so there is no legitimate path to a missing or NULL result.
 * Absorbing one into a 0 would make the gates below read "this write stores nothing"
 * and sail through — the same fail-open the probe exists to close, reached through
 * the guard instead of around it.
 *
 * 🔴 `Number.isFinite(Number(x))` alone is NOT enough: `Number(null)` is 0, which is
 * finite, so a NULL would pass that check and then produce a zero-byte charge (and,
 * on the update path, a non-positive delta — the exact bypass). Reject the null
 * explicitly, before the coercion.
 */
function requireStoredSize(raw: number | null | undefined): number {
  const storedByteSize = Number(raw);
  if (raw == null || !Number.isFinite(storedByteSize)) {
    throw new Error('app shared storage: stored-size probe returned no usable value');
  }
  return storedByteSize;
}

/**
 * Read a trigger-maintained counter that is selected `::text`, treating a MISSING row as
 * zero but a non-numeric value as a fault.
 *
 * 🔴 USED FOR EVERY `quota` COUNTER THESE GATES READ — `used_bytes` and `row_count`.
 * A NaN in any of them fails open through BOTH arms of its gate: `usedBytes +
 * storedByteSize > CAP` is false on append, on update `netDelta` is unaffected so
 * `usedBytes + netDelta > CAP` is false too, and `rowCount + 1 > APP_ROW_LIMIT` is false
 * as well. All are unreachable today (`bigint NOT NULL`, read through `::text`).
 *
 * ⚠️ `row_count` was NOT covered when this helper was introduced, and two docstrings
 * then claimed `usedBytes` was "the one term of these comparisons" without a check —
 * which was only true if "these comparisons" silently excluded the row gate two lines
 * away. Covering it is behaviour-preserving (measured against the full suite), so the
 * asymmetry had no justification beyond having been overlooked. The general point stands
 * and now applies to all of them: leaving one term as the odd one out is exactly the
 * asymmetry a later schema or driver change turns into a hole.
 *
 * `null` is NOT a fault here, unlike the probe: the scalar subquery returns NULL when the
 * app has no `quota` row, and the pre-existing behaviour is to treat that as zero used
 * bytes. Only a value that is present and non-numeric is rejected.
 */
function requireFiniteCounter(raw: string | null | undefined, label: string): number {
  const value = Number(raw ?? '0');
  if (!Number.isFinite(value)) {
    throw new Error(`app shared storage: ${label} is not numeric`);
  }
  return value;
}

// ── Min-trust gate (design H3 / MIN-TRUST GATE) ───────────────────────────────
// MOVED to `~/server/services/blocks/block-write-trust.service` — it now has a
// SECOND caller (`blocks.createPostFromApp`), and a trust predicate open-coded at
// two sites is one that will be wrong at one of them. The rule, its signals and
// its exact deny messages are unchanged.
//
// NOT re-exported from here. The importers of this module were enumerated when
// the predicate moved, and none of them took `assertSharedWriteTrust`,
// `MIN_ACCOUNT_AGE_MS` or `REQUIRE_PAID_TIER` from it — they take
// `appsSharedRouter`/`appsModRouter` and the counter helpers. Import the
// predicate from the service that owns it.

type SharedOp =
  | 'list'
  | 'get'
  | 'getCount'
  | 'append'
  // Author-scoped in-place edit of an OWN published row (write-gated exactly like
  // append: shared:write scope + min-trust). Author-only; see the `update` mutation.
  | 'update'
  | 'vote'
  | 'unvote'
  | 'withdraw'
  | 'report'
  // App Blocks play-counts (block REST endpoints /api/v1/blocks/shared-storage/*):
  //   - 'increment' is a WRITE (min-trust gated like append/vote — anti-inflation)
  //   - 'getTop' is a READ (anon-allowed like list/getCount)
  | 'increment'
  | 'getTop';
const READ_OPS: ReadonlySet<SharedOp> = new Set<SharedOp>(['list', 'get', 'getCount', 'getTop']);

const SHARED_READ_SCOPE = 'apps:storage:shared:read';
const SHARED_WRITE_SCOPE = 'apps:storage:shared:write';

interface SharedContext {
  userId: number | null;
  subjectUser: SessionUser | null;
  slug: string;
  schema: string;
  appBlockId: string;
  blockInstanceId: string;
}

/**
 * NEW resolver for the shared surface — does NOT reuse resolveStorageContext /
 * assertViewerIsAppDeveloper (that gates to app-authors only; copying it would
 * FORBID all general users). Asserts, per op:
 *   1. valid block token → approved AppBlock (isolation via sanitizeAppSlug)
 *   2. the shared read/write scope is present on claims.scopes
 *   3. the dedicated fail-closed Flipt flag (kill-switch) is on
 *   4. for WRITE ops: authenticated subject + the min-trust gate
 * Anon may READ list/counts; anon NEVER writes/votes.
 */
export async function resolveSharedContext(
  blockToken: string,
  op: SharedOp
): Promise<SharedContext> {
  const claims = await verifyBlockToken(blockToken);
  if (!claims) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'invalid block token' });

  const slug = sanitizeAppSlug(claims.blockId);
  if (!slug) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'block id is not a valid storage slug',
    });
  }

  // 🔴 THE STRICTEST OF THE THREE RESOLVERS THAT READ THIS ROW, AND DELIBERATELY SO.
  // The other two are `resolveAppBlockApprovalVerdict`
  // (`~/server/services/blocks/block-approval.service`), the shared predicate for the REST
  // middleware and the tRPC bridge, which exempts a run-for-real review token, a token
  // with no backing row, and an owner with a live dev tunnel; and `resolveStorageContext`
  // (`apps.router`), which exempts only the run-for-real review token. This one exempts
  // NOTHING, because shared storage is cross-user, app-global state and the review mint
  // never grants `apps:storage:shared:*` at all — so there is no case here to exempt, not
  // a disagreement about what approval means. Do not "align" these three without deciding
  // it; the reconciliation and its rationale are ledgered, and enforced on both growth and
  // shrink, in `src/server/services/__tests__/no-unguarded-block-rest-token.test.ts`.
  const block = await dbRead.appBlock.findUnique({
    where: { appId_blockId: { appId: claims.appId, blockId: claims.blockId } },
    select: { id: true, status: true },
  });
  if (!block) throw new TRPCError({ code: 'NOT_FOUND', message: 'app block not found' });
  if (block.status !== 'approved') {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'app block is not approved' });
  }

  // Per-instance revocation — the missing containment leg (audit M-1). The REST
  // `withBlockScope` path enforces this; the tRPC shared path must too, so an
  // uninstalled / toggled-off / publisher-banned instance can't keep writing
  // until token expiry. Mirrors block-scope.middleware's check. (The ban leg is new as
  // of clawgate #618 and lives in its OWN keyspace: install writes go through
  // `revokeInstance` — `uninstallFromModel`, `toggleEnabled(false)` — and ban writes
  // through `revokeInstanceForBan`, from `revokeBlockInstancesForPublisher`. Read
  // `block-scope.middleware.ts` before reasoning about the ban path from here.)

  // `claims.sub` is passed for the same reason the two runtime guards pass it: the
  // subject-scoped ban keyspace. Latent on THIS path today — it requires an `approved`
  // AppBlock row and an ephemeral app has none — but the argument costs nothing and
  // the alternative is a silent trap pointed at unsubmitted-app storage.
  if (await BlockRevocation.isRevoked(claims.blockInstanceId, claims.sub)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'block instance revoked' });
  }

  // Per-op scope assertion (re-checks the issuance contract at point of use).
  const requiredScope = READ_OPS.has(op) ? SHARED_READ_SCOPE : SHARED_WRITE_SCOPE;
  if (!Array.isArray(claims.scopes) || !claims.scopes.includes(requiredScope)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: `shared storage ${op} requires the ${requiredScope} scope`,
    });
  }

  // parseSubjectUserId throws a plain ForbiddenError on a malformed `sub`; surface
  // it as a clean FORBIDDEN (not an uncaught 500). Fail-closed either way. (audit 🟢-4)
  let userId: number | null;
  try {
    userId = parseSubjectUserId(claims.sub);
  } catch {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'invalid token subject' });
  }
  // Hydrate the TOKEN SUBJECT (block-token path has no ctx.user) — needed for both
  // the flag segment eval and the trust gate.
  const subjectUser =
    userId != null
      ? ((await sessionClient.getSessionUserById(userId)) as SessionUser | null)
      : null;

  // 🔴 A VANISHED SUBJECT IS NOT AN ANONYMOUS CALLER — refuse it here, before the
  // flag. Both used to collapse into the single `subjectUser ?? undefined` below,
  // and the comment claimed that was "fail-closed on a vanished subject". It was
  // not: a no-user eval cannot match a segment, but its answer is the flag's own
  // base `enabled` value, so a base-`enabled: true` GA flip of
  // `app-blocks-shared-storage` would admit a token whose subject no longer exists.
  // The WRITE path happened to catch it downstream (the `userId == null` check +
  // the min-trust gate below); EVERY op in `READ_OPS` skips that block entirely and
  // has no second belt, so the flag was the only thing standing in front of all of
  // them. Do not re-enumerate that set here — it is four ops today and adding a
  // fifth must not silently make this comment wrong. Mechanism + the measurement
  // against the real wasm engine: GLOBAL-EVAL SEMANTICS in `app-blocks-flag.ts`.
  //
  // 🔴 WATCHLISTED as `shared-storage-subject-refusal` in
  // `scripts/compiled-branch-watchlist.mjs`. Unlike a type-level guard, this is a pure
  // runtime branch, so a bundler that drops it re-opens the exposure with the source
  // still correct — which is precisely what shipped in release 5.1.18 (civitai#3983).
  // MOVING this branch is fine — the gate resolves its anchor from source at run time,
  // so line numbers do not matter, and the message text is free to change because the
  // anchor here is the CONDITION on the next line, not the message. DELETING the branch,
  // or rewriting that condition, fails the production Docker build at
  // `assert-compiled-branches.mjs` — in the second case update the watchlist entry in the
  // same commit.
  if (userId != null && !subjectUser) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'token subject could not be resolved' });
  }

  // Dedicated kill-switch, evaluated with the subject's context so the flag's
  // mod/cohort segments resolve identically to the client gate. An ANON token
  // (`sub:'anon'`, `userId == null`) still reaches this with no user, which is
  // deliberate: that is a global eval, i.e. the flag's BASE value, and anon shared
  // access is exactly the GA widening a base-`enabled` flip is meant to perform.
  if (!(await isAppBlocksSharedStorageEnabled({ user: subjectUser ?? undefined }))) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'shared storage is not enabled' });
  }

  if (!READ_OPS.has(op)) {
    // WRITE — anon never writes; authenticated subject must pass the trust gate.
    if (userId == null) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'shared storage writes require an authenticated viewer',
      });
    }
    // Keyed on the SUBJECT (from the verified block token), never client-forgeable input.
    const hasLinkedOAuth = subjectUser ? await hasLinkedOAuthAccount(subjectUser) : false;
    assertSharedWriteTrust(subjectUser, hasLinkedOAuth);
  }

  return {
    userId,
    subjectUser,
    slug,
    schema: appSchemaIdent(slug),
    appBlockId: block.id,
    blockInstanceId: claims.blockInstanceId,
  };
}

// Postgres literal quoting for the SET LOCAL GUC (no $1 form). appBlockId is the
// server-issued `apb_<ulid>` PK from the AppBlock lookup — never client input.
function pgQuoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

const blockTokenInput = z.object({ blockToken: z.string().min(1) });

// Bounds shared by the tRPC inputs below AND the block REST adapters
// (`/api/v1/blocks/shared-storage/{list,item,counts}`). Exported so each surface
// restates the NUMBER in exactly one place: both run the SAME resolver and the
// SAME SQL, so a bound that silently disagreed between them is a difference only
// a fuzzer would ever find.
export const SHARED_KEY_MAX = 64;
export const SHARED_PREFIX_MAX = 64;
export const SHARED_CURSOR_MAX = 200;
export const SHARED_LIST_LIMIT_MAX = 100;
export const SHARED_LIST_LIMIT_DEFAULT = 50;
export const SHARED_COUNTS_KEYS_MAX = 100;
// `report.reason` — free-text, moderator-facing only (never rendered to other
// app users), so it carries no content-safety belt; the bound is what keeps it
// from becoming a storage channel.
export const SHARED_REASON_MAX = 500;

const sharedKeyInput = z.string().min(1).max(SHARED_KEY_MAX);

// Structured append payload (design M3: title ≤200, body ≤ few KB).
//
// `title`/`body` are the MODERATED, user-visible TEXT — they run the full
// content-safety belt (assertSharedTextSafe) synchronously on every append.
//
// `data` is an OPTIONAL, app-owned structured payload stored alongside the moderated
// text. It is NOT run through the title/body content-safety belt: it is app-structured
// state (e.g. an app's own saved-config JSON), rendered ONLY inside the app's
// opaque-origin iframe sandbox — the SAME trust boundary as the rest of shared storage
// (all approved apps are `unverified` tier → no `allow-same-origin`, so even hostile
// bytes in `data` run in an origin that can't touch civitai). Apps can and do render
// strings from it to other users, so its string values and object keys get the LOCAL
// leaf moderation in `shared-data-moderation.ts` — default OFF, ramped per app by two
// flags (shadow, then enforce). 🔴 Apps should still place user-VISIBLE TEXT in
// `title`/`body`, which carries the full belt. Size is bounded by the whole-value
// SHARED_VALUE_BYTE_CAP (below) and its bytes count toward the app quota.
//
// EXPORTED because the REST adapters (`/api/v1/blocks/shared-storage/{append,
// update}`) validate the SAME payload. Exporting the schema rather than its three
// bounds is deliberate: `title`/`body`/`data` is a SHAPE, not three numbers, and a
// REST copy that drifted — an extra key admitted, `title` made optional — would be
// a difference only a fuzzer would find, on the one input that reaches the
// content-safety belt.
export const sharedValueInput = z.object({
  title: z.string().min(1).max(SHARED_TITLE_MAX),
  body: z.string().max(SHARED_BODY_MAX).optional(),
  data: z.unknown().optional(),
});

// ── Shared READ surface (tRPC procedures + block REST adapters) ───────────────
// The three functions below are the ONE implementation of every shared read.
// They take a raw bearer block token (never a tRPC ctx), exactly like
// `getTopSharedCounters` / `incrementSharedCounter` below, so the REST adapters
// in `src/pages/api/v1/blocks/shared-storage/` and the tRPC procedures in
// `appsSharedRouter` are the SAME code path — same `resolveSharedContext` op,
// same SQL, same visibility gate. A read that behaved differently over REST than
// over the bridge is precisely the divergence this shape exists to prevent, and
// it is why the procedures below are one-liners rather than a second copy.
//
// 🔴 `schema` is derived inside `resolveSharedContext` from the VERIFIED token
// (`sanitizeAppSlug(claims.blockId)`), never from anything a caller sends. No
// argument on any of these functions can influence which app's schema is read.

/** One row of the shared feed, as `list` and `get` both project it. */
export interface SharedKvItem {
  key: string;
  authorUserId: number;
  value: unknown;
  count: number;
  createdAt: Date;
  updatedAt: Date;
  viewerVoted: boolean;
}

interface SharedKvRow {
  key: string;
  author_user_id: number;
  value: unknown;
  count: string;
  created_at: Date;
  updated_at: Date;
  viewer_voted: boolean;
}

function toSharedKvItem(r: SharedKvRow): SharedKvItem {
  return {
    key: r.key,
    authorUserId: r.author_user_id,
    value: r.value,
    count: Number(r.count),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    viewerVoted: r.viewer_voted,
  };
}

/**
 * Cursor-paginated list of shared_kv rows (the "requests" feed). shared_kv +
 * counter aggregate ONLY — NEVER the per-user kv, NEVER the raw vote rows.
 * Hidden rows are excluded. Anon may read. Keyset cursor on the ULID key
 * (newest-first, DESC). `cursor` is an opaque base64 of the last key seen; a
 * malformed one simply decodes to a key that matches nothing, never an error.
 *
 * `mine` narrows the feed to rows the VIEWER authored (civitai/civitai#5354 Q3).
 * It is a BOOLEAN, not a user id: the author it filters on is
 * `resolveSharedContext`'s resolved subject — the same value `viewerVoted` already
 * keys on — so no caller-supplied identity enters this path. Rows are world-readable
 * either way, so this adds no read reach: it replaces "page the whole board and
 * filter client-side" with one predicate over the same set.
 *
 * ⚠ THE REASON FOR THE BOOLEAN IS YAGNI, NOT A CAPABILITY BOUNDARY — an earlier
 * draft of this comment claimed a `mine=<userId>` form "would be a new enumeration
 * primitive", and that is FALSE: `toSharedKvItem` returns `authorUserId` on every
 * listed row, so enumerating a named user's submissions is ALREADY possible by
 * paging the board — which is the very cost this parameter exists to remove. A
 * userId form would make it CHEAP, not POSSIBLE. The real argument is narrower and
 * still sufficient: nothing asks for it, and widening a boolean to an id later is
 * easy while narrowing an id to a boolean after clients depend on it is not.
 * Do not restore the security framing; it would read as an invariant that the
 * response shape contradicts two functions up.
 */
export async function listSharedRows(
  blockToken: string,
  {
    prefix,
    limit,
    cursor,
    mine,
  }: { prefix?: string; limit: number; cursor?: string; mine?: boolean }
): Promise<{ items: SharedKvItem[]; nextCursor?: string }> {
  // `userId` is the RESOLVED token subject (null for anon) — used ONLY to
  // hydrate the per-viewer `viewerVoted` flag below, and (when `mine`) to be the
  // author filtered on. It is never client input.
  const { schema, userId } = await resolveSharedContext(blockToken, 'list');
  const pool = requireAppsDb();

  const afterKey = cursor ? Buffer.from(cursor, 'base64').toString('utf8') : null;
  const escapedPrefix = (prefix ?? '').replace(/([\\%_])/g, '\\$1');
  const prefixPattern = `${escapedPrefix}%`;

  // Per-viewer vote hydration (item 3): LEFT JOIN the viewer's OWN vote row
  // ($4 = resolved subject uid, or NULL for anon). `v.user_id = $4` is UNKNOWN
  // (never true) for a NULL param, so an anonymous viewer always reads
  // `viewer_voted = false`. The join keys on votes' PK `(key, user_id)`, so it
  // is index-covered and adds no scan to the hot list path. The raw vote rows
  // are NEVER returned — only the boolean derived from the viewer's own row.
  //
  // `mine` ($5) reuses that same $4 — see this function's JSDoc for why it is a
  // boolean rather than a user id. 🔴 AN ANONYMOUS VIEWER ASKING FOR `mine` GETS
  // AN EMPTY PAGE, NOT AN ERROR AND NOT THE WHOLE BOARD, and it is the SQL that
  // guarantees it rather than a guard anyone could forget: $4 is NULL for anon,
  // so `s.author_user_id = $4::int` is UNKNOWN and matches nothing — the
  // identical three-valued-logic reason `viewer_voted` is always false for anon,
  // two lines up. That is the right answer (an anonymous viewer has authored
  // nothing) but it is right by a MECHANISM rather than by an `if`, so
  // `apps-shared.router.test.ts` pins the SQL SHAPE and not just the row count:
  // against an empty fixture a refactor to `COALESCE($4, s.author_user_id)` —
  // which silently returns the ENTIRE board to anon under a `mine` flag — is
  // behaviourally indistinguishable, so only a shape assertion can see it.
  // The predicate is SUPPORTED by `shared_kv_author_idx` (author_user_id) —
  // supported, not covering; the index holds only that column — and the
  // per-author row cap is SHARED_KV_PER_USER_ROW_CAP, so the sort it feeds is
  // bounded and small. The index is created by the same migration that creates
  // `shared_kv`, so every provisioned schema has it.
  //
  // 🔴 NO FAIL-CLOSED FORM OF THE `$5` GUARD IS AN IMPROVEMENT ON THIS ONE, AND
  // TWO SUCCESSIVE ATTEMPTS TO FIND ONE WERE WRONG. Written down so a third is
  // not derived. (An earlier heading said no fail-closed form EXISTS, which this
  // comment's own second half then contradicts — one does; it is simply worse.)
  //
  // Attempt 1 shipped `NOT COALESCE($5::boolean, false)` in place of
  // `$5::boolean IS NOT TRUE`, with a comment claiming it changed the failure
  // direction on NULL. It is a NO-OP — measured in PostgreSQL 16, the two have
  // identical truth tables, NULL included:
  //     $5     IS NOT TRUE   NOT COALESCE($5,false)
  //     true        f                 f
  //     false       t                 t
  //     NULL        t                 t
  // Reverted to the simpler original form, because a change that does nothing is
  // churn that reads as protection.
  //
  // Attempt 2, proposed by the next audit round, was `NOT COALESCE($5, true)` —
  // which genuinely does flip the NULL case, and is DANGEROUS. 🔴 Do not apply it.
  // `$5` can only be NULL if the `mine ?? false` below is removed, and in exactly
  // that scenario a caller sending NO `mine` sends `undefined` → NULL — so
  // defaulting NULL to "filter" would make EVERY ordinary board listing silently
  // return only the viewer's own rows. That is a far wider blast radius than the
  // case it fixes.
  //
  // So: the NULL case is UNREACHABLE, no spelling of this predicate improves on
  // that, and the invariant lives in the `mine ?? false` below plus the zod types
  // on both callers (`boolean | undefined`). That is the honest state. If you are
  // about to propose a third form, you are the third.
  const rows = (
    await pool.query<SharedKvRow>(
      `SELECT s.key, s.author_user_id, s.value, COALESCE(c.count, 0)::text AS count,
              s.created_at, s.updated_at,
              (v.user_id IS NOT NULL) AS viewer_voted
         FROM ${schema}.shared_kv s
         LEFT JOIN ${schema}.counters c ON c.key = s.key
         LEFT JOIN ${schema}.votes v ON v.key = s.key AND v.user_id = $4::int
        WHERE s.hidden_at IS NULL
          AND s.key LIKE $1 ESCAPE '\\'
          AND ($2::text IS NULL OR s.key < $2)
          AND ($5::boolean IS NOT TRUE OR s.author_user_id = $4::int)
        ORDER BY s.key DESC
        LIMIT $3`,
      [prefixPattern, afterKey, limit, userId, mine ?? false]
    )
  ).rows;

  const nextCursor =
    rows.length === limit
      ? Buffer.from(rows[rows.length - 1].key, 'utf8').toString('base64')
      : undefined;

  return { items: rows.map(toSharedKvItem), nextCursor };
}

/**
 * Single-row fetch by key (item 6 — deep-link resolution). Returns the SAME
 * item shape as `listSharedRows`, or `null` when the key is missing OR hidden —
 * applying the identical `hidden_at IS NULL` visibility gate as the list, so a
 * direct key fetch can NOT leak a withdrawn / moderator-hidden row the paged
 * list excludes.
 */
export async function getSharedRow(
  blockToken: string,
  key: string
): Promise<{ item: SharedKvItem | null }> {
  const { schema, userId } = await resolveSharedContext(blockToken, 'get');
  const pool = requireAppsDb();
  const row = (
    await pool.query<SharedKvRow>(
      `SELECT s.key, s.author_user_id, s.value, COALESCE(c.count, 0)::text AS count,
              s.created_at, s.updated_at,
              (v.user_id IS NOT NULL) AS viewer_voted
         FROM ${schema}.shared_kv s
         LEFT JOIN ${schema}.counters c ON c.key = s.key
         LEFT JOIN ${schema}.votes v ON v.key = s.key AND v.user_id = $2::int
        WHERE s.key = $1 AND s.hidden_at IS NULL`,
      [key, userId]
    )
  ).rows[0];
  return { item: row ? toSharedKvItem(row) : null };
}

/**
 * Batch aggregate vote counts. `counters` ONLY — the raw vote rows are never
 * listable. Unknown/hidden keys resolve to 0, so the returned map always has one
 * entry per requested key (the single-key `getCount` procedure is this function
 * with a one-element array; there is no second query shape for it).
 */
export async function getSharedCounts(
  blockToken: string,
  keys: string[]
): Promise<{ counts: Record<string, number> }> {
  const { schema } = await resolveSharedContext(blockToken, 'getCount');
  const pool = requireAppsDb();
  const rows = (
    await pool.query<{ key: string; count: string }>(
      `SELECT s.key, COALESCE(c.count, 0)::text AS count
         FROM ${schema}.shared_kv s
         LEFT JOIN ${schema}.counters c ON c.key = s.key
        WHERE s.key = ANY($1) AND s.hidden_at IS NULL`,
      [keys]
    )
  ).rows;
  const counts: Record<string, number> = {};
  for (const k of keys) counts[k] = 0;
  for (const r of rows) counts[r.key] = Number(r.count);
  return { counts };
}

// ── Shared WRITE surface (tRPC procedures + block REST adapters) ──────────────
// Same shape, same reason as the read functions above: the six write bodies are
// ONE implementation each, taking a raw bearer block token rather than a tRPC
// ctx, so `appsSharedRouter.{append,update,vote,unvote,withdraw,report}` and the
// REST adapters in `src/pages/api/v1/blocks/shared-storage/` are the SAME code
// path. A write that behaved differently over REST than over the bridge — a
// rate-limit bucket wired one way here and another way there, a trust gate run
// on one surface and not the other — is exactly the divergence this shape exists
// to prevent, and it is why the procedures below are one-liners.
//
// 🔴 EVERY control still lives in ONE place and runs on BOTH surfaces:
//   - `resolveSharedContext(token, <op>)` — token verification, approved-block,
//     revocation, the per-op scope assertion, the fail-closed kill-switch, the
//     anon refusal (UNAUTHORIZED) and `assertSharedWriteTrust`.
//   - `schema` is derived INSIDE that resolver from the VERIFIED token
//     (`sanitizeAppSlug(claims.blockId)`). No argument on any function below can
//     influence which app's schema is written.
//   - the per-(user, app) rate-limit bucket, taken BEFORE any pooled connection.
//   - `assertSharedValueSafeAndSerialize` — the blocking content-safety belt.

/** The moderated title/body plus the opaque app-owned `data` blob. */
export interface SharedValueInput {
  title: string;
  body?: string;
  data?: unknown;
}

/**
 * Create a shared row (a "request"). The server GENERATES a ULID key (C1: never
 * accept a client key on create → user B can't overwrite user A's row).
 * INSERT-only; author = the token subject. Runs the BLOCKING content-safety belt
 * (C2/C3/M1) synchronously, the per-user + per-app row caps + byte quota, and the
 * per-(user,app) daily rate limit — all before the row lands.
 */
export async function appendSharedRow(
  blockToken: string,
  value: SharedValueInput
): Promise<{ key: string }> {
  const { userId, subjectUser, slug, schema, appBlockId } = await resolveSharedContext(
    blockToken,
    'append'
  );
  // userId is non-null (trust gate ran in the resolver).
  const uid = userId as number;

  // Rate limit FIRST — bounds a flood AND the external-moderation cost the
  // safety belt would otherwise incur per attempt.
  const rl = await checkSharedAppendRateLimit(uid, appBlockId);
  if (!rl.allowed) {
    throw new TRPCError({
      code: 'TOO_MANY_REQUESTS',
      message: `Too many submissions — retry in ${rl.retryAfterSeconds}s`,
    });
  }

  // BLOCKING content safety (belt on title/body) + serialize-guard + whole-value
  // byte cap → RAW, store-ready serialized JSON. Shared verbatim with `update`
  // (see assertSharedValueSafeAndSerialize): a policy-violating edit and a create
  // are moderated identically. Throws a clean 4xx on any rejection — no row is
  // ever written on failure.
  //
  // Only `serialized` is taken: the wire `byteSize` it also returns has already
  // done its one job (SHARED_VALUE_BYTE_CAP, enforced in that unit inside the
  // helper) and must not reach the quota gate below. See STORED_SIZE_PROBE_SQL.
  const { serialized, moderation } = await assertSharedValueSafeAndSerialize({
    schema,
    slug,
    appBlockId,
    uid,
    subjectUser,
    value,
    surface: 'append',
  });

  const pool = requireAppsDb();

  // Per-USER row cap (design M2).
  const userRowCount = Number(
    (
      await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ${schema}.shared_kv WHERE author_user_id = $1`,
        [uid]
      )
    ).rows[0]?.n ?? '0'
  );
  if (userRowCount + 1 > SHARED_KV_PER_USER_ROW_CAP) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'you have reached the maximum number of submissions for this app',
    });
  }

  // Per-app byte + row quota (shared with the per-user kv path), read together with
  // the stored size of the value about to be written.
  const quota = (
    await pool.query<{
      used_bytes: string | null;
      row_count: string | null;
      stored_size_bytes: number | null;
    }>(
      `SELECT (SELECT used_bytes::text FROM ${schema}.quota WHERE app_block_id = $1) AS used_bytes,
              (SELECT row_count::text FROM ${schema}.quota WHERE app_block_id = $1) AS row_count,
              ${STORED_SIZE_PROBE_SQL}`,
      [appBlockId, serialized]
    )
  ).rows[0];
  const usedBytes = requireFiniteCounter(quota?.used_bytes, 'app used_bytes');
  const rowCount = requireFiniteCounter(quota?.row_count, 'app row_count');
  // 🔴 BOTH SIDES OF THIS COMPARISON MUST BE IN THE STORED UNIT. `usedBytes` is the
  // trigger-maintained sum of `shared_kv.size_bytes`; the wire `byteSize` the
  // serialize helper also returns belongs only to SHARED_VALUE_BYTE_CAP, which it
  // has already enforced in that unit. Read STORED_SIZE_PROBE_SQL's header before
  // changing either term.
  const storedByteSize = requireStoredSize(quota?.stored_size_bytes);
  if (usedBytes + storedByteSize > APP_QUOTA_BYTES) {
    throw new TRPCError({ code: 'PAYLOAD_TOO_LARGE', message: 'app quota exceeded' });
  }
  if (rowCount + 1 > APP_ROW_LIMIT) {
    throw new TRPCError({ code: 'PAYLOAD_TOO_LARGE', message: 'app row limit exceeded' });
  }

  const key = newUlid();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // GUC drives the shared_kv quota trigger (byte/row accounting).
    await client.query(`SET LOCAL app.current_app_block_id = ${pgQuoteLiteral(appBlockId)}`);
    await client.query(
      `INSERT INTO ${schema}.shared_kv (key, author_user_id, value)
           VALUES ($1, $2, $3::jsonb)`,
      [key, uid, serialized]
    );
    // Seed the counter cache (votes are the source of truth).
    await client.query(
      `INSERT INTO ${schema}.counters (key, count) VALUES ($1, 0)
           ON CONFLICT (key) DO NOTHING`,
      [key]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // SHADOW `data` moderation: only now that the row exists, and never awaited.
  if (moderation.mode === 'shadow') {
    const { readStoredData } = moderation;
    scheduleSharedDataShadow(
      () => scanSharedData(readStoredData(), { isModerator: subjectUser?.isModerator }),
      { appBlockId, rowKey: key, surface: 'append' }
    );
  }

  return { key };
}

/**
 * Author-scoped in-place UPDATE of an OWN published row (fixes "editing creates a
 * new one" — `append` is INSERT-only). GENERIC: it edits any shared_kv row by key,
 * no app-specific concept. Gated identically to `append` (shared:write scope +
 * min-trust, enforced in resolveSharedContext). The row is resolved by `key` in
 * the CALLER'S app schema (derived from the verified token, never client input):
 *   - NOT_FOUND if the key is missing OR hidden (hidden_at IS NOT NULL)
 *   - FORBIDDEN unless author_user_id = the token subject (a non-author cannot edit;
 *     mods use apps.mod.purgeSharedRow, not this)
 * The new title/body run the SAME blocking content-safety belt as append (a
 * policy-violating edit is rejected, no write); the `data` blob gets the same flag-
 * governed leaf moderation as append. The whole value is serialize-guarded
 * + capped, and the per-app quota is re-checked on the byte DELTA (new − old) BEFORE
 * the write. The write is IN PLACE: value + updated_at (+ the generated size_bytes,
 * which the shared_kv UPDATE quota trigger folds into used_bytes) change; the key,
 * author_user_id, created_at, and the row's votes/counters/reports are PRESERVED.
 * Shares append's daily rate-limit bucket so an edit isn't an unbounded write.
 */
export async function updateSharedRow(
  blockToken: string,
  key: string,
  value: SharedValueInput
): Promise<{ ok: true }> {
  const { userId, subjectUser, slug, schema, appBlockId } = await resolveSharedContext(
    blockToken,
    'update'
  );
  // userId is non-null (trust gate ran in the resolver).
  const uid = userId as number;

  // Same daily bucket as append (design H4) so repeated edits can't become an
  // unbounded write — AND it bounds the external-moderation cost the belt incurs.
  const rl = await checkSharedAppendRateLimit(uid, appBlockId);
  if (!rl.allowed) {
    throw new TRPCError({
      code: 'TOO_MANY_REQUESTS',
      message: `Too many submissions — retry in ${rl.retryAfterSeconds}s`,
    });
  }

  const pool = requireAppsDb();

  // Resolve the target row in THIS app's schema (schema is server-derived from the
  // verified token, never client-supplied). Missing OR hidden → NOT_FOUND. The
  // stored size_bytes is the CURRENT byte weight, used for the quota delta below.
  const existing = (
    await pool.query<{ author_user_id: number; size_bytes: number }>(
      `SELECT author_user_id, size_bytes FROM ${schema}.shared_kv
            WHERE key = $1 AND hidden_at IS NULL`,
      [key]
    )
  ).rows[0];
  if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'request not found' });
  // Author gate: only the row's author may edit it. A non-author is FORBIDDEN
  // (mods hide/purge via apps.mod.purgeSharedRow, never this write path).
  if (existing.author_user_id !== uid) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'you can only edit your own submissions',
    });
  }

  // Belt on the NEW title/body + serialize-guard + whole-value byte cap (mirrors
  // append EXACTLY — same helper). A policy-violating edit throws here, before any
  // write, so the stored row is never touched.
  //
  // Only `serialized` is taken — see the matching note in `append`: the wire
  // `byteSize` has already enforced SHARED_VALUE_BYTE_CAP inside the helper and
  // must not reach the delta arithmetic below.
  const { serialized, moderation } = await assertSharedValueSafeAndSerialize({
    schema,
    slug,
    appBlockId,
    uid,
    subjectUser,
    value,
    surface: 'update',
    rowKey: key,
  });

  // Per-app byte quota re-checked on the DELTA (new − old). A shrinking edit always
  // fits; a growing edit must sit within the remaining budget. Row count is
  // UNCHANGED by an in-place update, so there's no row-limit / per-user-row check.
  //
  // "A shrinking edit always fits" is enforced by the `isNonIncreasing` exemption
  // below, not merely by the arithmetic — see the comment on it.
  const quota = (
    await pool.query<{ used_bytes: string | null; stored_size_bytes: number | null }>(
      `SELECT (SELECT used_bytes::text FROM ${schema}.quota WHERE app_block_id = $1) AS used_bytes,
              ${STORED_SIZE_PROBE_SQL}`,
      [appBlockId, serialized]
    )
  ).rows[0];
  const usedBytes = requireFiniteCounter(quota?.used_bytes, 'app used_bytes');
  // 🔴 A SUBTRACTION IS ONLY A DELTA IF BOTH TERMS SHARE A UNIT. `oldBytes` comes
  // straight out of the generated `shared_kv.size_bytes` column, so it is already
  // in stored bytes; the new side must be too, or the difference is not a measure
  // of growth at all. Held in the wire unit this was a repeatable bypass — any
  // value whose wire size is at or below the row's stored size made the delta
  // non-positive, so the gate passed unconditionally while the trigger charged the
  // true stored growth. Read STORED_SIZE_PROBE_SQL's header before touching this.
  const storedByteSize = requireStoredSize(quota?.stored_size_bytes);
  // Already in STORED bytes — it comes straight out of the generated column. The
  // finiteness check mirrors the per-user path (`app-storage.service`'s `set`) and
  // exists because a NaN here would fail open through BOTH arms of the gate below:
  // `NaN <= 0` is false (no exemption) and `NaN > CAP` is false (no refusal), so the
  // write would land uncharged. Unreachable with the current DDL — `size_bytes` is a
  // non-null generated `integer` — but the asymmetry with the `storedByteSize` guard
  // above is exactly the kind a later schema change turns into a hole.
  const oldBytes = Number(existing.size_bytes ?? 0);
  if (!Number.isFinite(oldBytes)) {
    throw new Error('app shared storage: stored row size is not numeric');
  }
  const netDelta = storedByteSize - oldBytes;

  // 🔴 AN EDIT THAT DOES NOT GROW THE STORED BYTES MUST NEVER BE REFUSED BY A BYTE
  // CEILING, and this exemption is part of the unit fix rather than a separate
  // policy change — without it the fix above TRAPS the authors of an over-quota app.
  //
  // `usedBytes` is what is stored NOW, not a projection, so once a counter sits above
  // the cap the gate refuses any write for which `used + netDelta > CAP` — and since
  // `netDelta` is at best a reclaim, that means **a shrink is refused unless it is big
  // enough to land the counter back under the cap**, i.e. iff `used > CAP + |netDelta|`.
  // A no-op re-save (`netDelta === 0`) is then refused at any overrun at all. So the
  // action that would bring the app back under its ceiling is the one refused, exactly
  // when the overrun exceeds what one edit can reclaim.
  //
  // ⚠️ Not "every shrink at or above the cap is refused" — an earlier draft of this
  // comment said that and it is wrong in two measurable places, both covered by tests
  // in `apps-shared.router.quota.stored-units.behavior.test.ts`: at `used === CAP`
  // exactly a no-op passes (`CAP + 0 > CAP` is false), and at `used = CAP + 2_000` a
  // 6,000-byte reclaim passes. Overstating it hides what the exemption is actually for.
  //
  // The fallback exits are narrow but not singular: the author's own `withdraw` (which
  // hard-deletes the row and cascades its votes and counter — NOT its reports, whose
  // `key` is deliberately not an FK so the audit trail survives a purge), a moderator's
  // `apps.mod.purgeSharedRow` with `action: 'delete'`, and — because `quota` is SHARED
  // with the per-user `kv` table through the same trigger — any `storage.delete` on the
  // per-user path. All of them destroy data to reclaim bytes; none lets an author simply
  // correct an oversized row, which is what this exemption restores.
  //
  // A counter can reach the over-cap state from a lowered cap, from trigger drift
  // (`kv_quota_trigger` no-ops when the GUC is unset), or — the reason this matters on
  // this commit specifically — from the pre-fix bypass this change closes.
  //
  // It was previously reachable only BY ACCIDENT, and only at a SMALL overrun. The old
  // delta was `wireNew − storedOld`, carrying a systematic negative bias (~33% of the
  // row on a separator-dense value), so a no-op re-save computed a comfortably negative
  // number and passed while the overrun stayed under that bias. Correcting the unit
  // removes the bias, and with it the escape hatch — so the exemption has to be stated
  // deliberately instead.
  //
  // 🔴 THE EXEMPTION IS SAFE ONLY BECAUSE `netDelta` IS NOW IN THE STORED UNIT. Both
  // terms are `octet_length(value::text)` over jsonb, i.e. exactly what
  // `shared_kv.size_bytes` holds and the trigger sums, so `netDelta <= 0` really does
  // mean "this write stores no more than the row already did". Held in the wire unit
  // the same condition was satisfiable indefinitely by writes that GREW the stored
  // bytes, which is the bypass itself. Do not reintroduce a wire-unit term here.
  // (Identical reasoning, and the identical warning, on the per-user path — see the
  // `isNonIncreasing` block in `app-storage.service`'s `set`.)
  //
  // What it cannot skip: SHARED_VALUE_BYTE_CAP is already enforced per value before any
  // of this, and the row population is unchanged by an in-place update so no row gate is
  // in play. ⚠️ It is NOT bounded by the trigger "reconciling" afterwards — an earlier
  // draft claimed that, and `kv_quota_trigger` only ever applies a DELTA
  // (`used_bytes = used_bytes + (NEW.size_bytes - OLD.size_bytes)`), so it propagates
  // this write faithfully and cannot correct pre-existing drift.
  //
  // 🔴 AND DO NOT SUBSTITUTE "a periodic recompute will fix it". The provisioner's own
  // comment on the trigger says one exists ("the periodic recompute in P7 reconciles"),
  // but a full enumeration of `src/` finds no job that recomputes app-level
  // `quota.used_bytes` from the rows: the only `sum(size_bytes)` outside tests is in
  // `user-storage-purge.service`, which sums `kv` for ONE user and cannot see
  // `shared_kv` at all. So app-level drift, once present, is currently permanent — which
  // is precisely why this exemption has to exist rather than being deferred to a
  // reconciler.
  //
  // `append` needs no equivalent, for a stronger reason than a sign argument: its gate
  // is ABSOLUTE (`usedBytes + storedByteSize > CAP`), not a delta, so there is no
  // non-increasing case for an exemption to recognise. Do not "harmonise" the two by
  // giving append a delta.
  const isNonIncreasing = netDelta <= 0;
  if (!isNonIncreasing && usedBytes + netDelta > APP_QUOTA_BYTES) {
    throw new TRPCError({ code: 'PAYLOAD_TOO_LARGE', message: 'app quota exceeded' });
  }

  // In-place UPDATE under the quota GUC (the shared_kv UPDATE trigger reclaims the
  // byte delta into quota.used_bytes automatically). Author-gated + visibility-
  // gated in the WHERE too — belt-and-suspenders against a race between the SELECT
  // above and this write. Only `value`/`updated_at` change → key, author_user_id,
  // created_at and the FK'd votes/counters/reports are all PRESERVED.
  const client = await pool.connect();
  let updated = 0;
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL app.current_app_block_id = ${pgQuoteLiteral(appBlockId)}`);
    const result = await client.query(
      `UPDATE ${schema}.shared_kv
              SET value = $2::jsonb, updated_at = now()
            WHERE key = $1 AND author_user_id = $3 AND hidden_at IS NULL`,
      [key, serialized, uid]
    );
    updated = result.rowCount ?? 0;
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  // Lost a race (row vanished / was hidden / reassigned between SELECT and UPDATE).
  if (updated === 0) throw new TRPCError({ code: 'NOT_FOUND', message: 'request not found' });

  // SHADOW `data` moderation, after the edit landed — see `appendSharedRow`.
  if (moderation.mode === 'shadow') {
    const { readStoredData } = moderation;
    scheduleSharedDataShadow(
      () => scanSharedData(readStoredData(), { isModerator: subjectUser?.isModerator }),
      { appBlockId, rowKey: key, surface: 'update' }
    );
  }

  return { ok: true as const };
}

/**
 * Up-vote a request. FK-checked (H2: a vote on a non-existent request rejects
 * NOT_FOUND) + visibility-checked (hidden rows can't be voted). The counter
 * increment is ATOMICALLY gated on the vote row actually inserting (H1: a double
 * vote is a no-op, the counter never inflates). Rate-limited per (user, app).
 */
export async function voteSharedRow(blockToken: string, key: string): Promise<{ count: number }> {
  const { userId, schema, appBlockId } = await resolveSharedContext(blockToken, 'vote');
  const uid = userId as number;

  const rl = await checkSharedVoteRateLimit(uid, appBlockId);
  if (!rl.allowed) {
    throw new TRPCError({
      code: 'TOO_MANY_REQUESTS',
      message: `Too many votes — retry in ${rl.retryAfterSeconds}s`,
    });
  }

  const pool = requireAppsDb();
  // Visibility/existence pre-check → NOT_FOUND for hidden OR missing (H2). The
  // FK on votes.key is the belt for a race between this and the insert.
  const exists = (
    await pool.query(`SELECT 1 FROM ${schema}.shared_kv WHERE key = $1 AND hidden_at IS NULL`, [
      key,
    ])
  ).rowCount;
  if (!exists) throw new TRPCError({ code: 'NOT_FOUND', message: 'request not found' });

  try {
    // Atomic insert-gated counter (design H1). EXCLUDED.count = |ins| ∈ {0,1}.
    const rows = (
      await pool.query<{ count: string }>(
        `WITH ins AS (
               INSERT INTO ${schema}.votes (key, user_id) VALUES ($1, $2)
               ON CONFLICT (key, user_id) DO NOTHING
               RETURNING 1
             )
             INSERT INTO ${schema}.counters AS c (key, count)
             VALUES ($1, (SELECT count(*) FROM ins))
             ON CONFLICT (key) DO UPDATE
               SET count = c.count + EXCLUDED.count
             RETURNING c.count::text AS count`,
        [key, uid]
      )
    ).rows;
    return { count: Number(rows[0]?.count ?? '0') };
  } catch (err) {
    // FK violation (key vanished mid-op) → NOT_FOUND (H2).
    if (isForeignKeyViolation(err)) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'request not found' });
    }
    throw err;
  }
}

/**
 * Withdraw an up-vote. Symmetric to vote: the counter decrements by exactly the
 * number of vote rows deleted (0 or 1); the `CHECK(count >= 0)` constraint blocks
 * any underflow (H1). Rate-limited on the same per (user, app) vote bucket.
 */
export async function unvoteSharedRow(blockToken: string, key: string): Promise<{ count: number }> {
  const { userId, schema, appBlockId } = await resolveSharedContext(blockToken, 'unvote');
  const uid = userId as number;

  const rl = await checkSharedVoteRateLimit(uid, appBlockId);
  if (!rl.allowed) {
    throw new TRPCError({
      code: 'TOO_MANY_REQUESTS',
      message: `Too many votes — retry in ${rl.retryAfterSeconds}s`,
    });
  }

  const pool = requireAppsDb();
  const rows = (
    await pool.query<{ count: string }>(
      `WITH del AS (
             DELETE FROM ${schema}.votes WHERE key = $1 AND user_id = $2 RETURNING 1
           )
           UPDATE ${schema}.counters
              SET count = count - (SELECT count(*) FROM del)
            WHERE key = $1
           RETURNING count::text AS count`,
      [key, uid]
    )
  ).rows;
  return { count: Number(rows[0]?.count ?? '0') };
}

/**
 * Author withdraws their OWN request (design LOCKED #4). Deletes the shared_kv
 * row ONLY when author_user_id = subject; the FK cascade drops its votes +
 * counter. SET LOCAL GUC so the quota trigger reclaims the bytes/row.
 */
export async function withdrawSharedRow(
  blockToken: string,
  key: string
): Promise<{ ok: true; deleted: boolean }> {
  const { userId, schema, appBlockId } = await resolveSharedContext(blockToken, 'withdraw');
  const uid = userId as number;

  // This op had NO bucket while every other write on the surface had one — a
  // gap worth closing on its own terms, and one a REST ingress would widen.
  // Own per-minute bucket; the window/ceiling rationale (and why it is NOT the
  // append daily bucket and NOT the shared vote bucket) lives beside the
  // constants in shared-storage-rate-limit.ts.
  const rl = await checkSharedWithdrawRateLimit(uid, appBlockId);
  if (!rl.allowed) {
    throw new TRPCError({
      code: 'TOO_MANY_REQUESTS',
      message: `Too many withdrawals — retry in ${rl.retryAfterSeconds}s`,
    });
  }

  const pool = requireAppsDb();
  const client = await pool.connect();
  let deleted: boolean;
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL app.current_app_block_id = ${pgQuoteLiteral(appBlockId)}`);
    const result = await client.query(
      `DELETE FROM ${schema}.shared_kv WHERE key = $1 AND author_user_id = $2`,
      [key, uid]
    );
    await client.query('COMMIT');
    deleted = (result.rowCount ?? 0) > 0;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  if (deleted) {
    await syncStoreItem({ appBlockId, itemKey: key, change: 'withdrawn', authorUserId: uid });
  }
  return { ok: true as const, deleted };
}

/**
 * The item's store card (an app sub-listing) follows an in-app withdraw or moderator hide,
 * from the server, so the store never depends on the app to clean up. Best-effort: the
 * shared-storage write has already committed in the apps database.
 */
async function syncStoreItem(args: SyncSubListingForSharedRowArgs): Promise<void> {
  try {
    const { syncSubListingForSharedRow } = await import(
      '~/server/services/blocks/app-sub-listing.service'
    );
    await syncSubListingForSharedRow(args);
  } catch (err) {
    logToAxiom({
      name: 'app-sub-listing-shared-sync-failed',
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    }).catch(() => null);
  }
}

/**
 * User report (design M5). Files a shared_kv_reports row for mod review. Requires
 * the write scope + trust gate (only eligible users can report, to bound report
 * spam). Does not hide the row — a moderator decides via `apps.mod.purgeSharedRow`.
 */
export async function reportSharedRow(
  blockToken: string,
  key: string,
  reasonInput?: string
): Promise<{ ok: true }> {
  const { userId, slug, schema, appBlockId } = await resolveSharedContext(blockToken, 'report');
  const uid = userId as number;

  // F1 (pre-GA): `report` is now block-reachable (PageBlockHost / IframeHost),
  // and each report files a row. Every OTHER shared write op is rate-limited; this
  // one was not — so a trusted user could loop it into report-table growth. Bound
  // the per-(user, app) report velocity on its own daily bucket (fail-open, like the
  // other buckets — the containment is defence-in-depth, not the auth boundary).
  const rl = await checkSharedReportRateLimit(uid, appBlockId);
  if (!rl.allowed) {
    throw new TRPCError({
      code: 'TOO_MANY_REQUESTS',
      message: `Too many reports — retry in ${rl.retryAfterSeconds}s`,
    });
  }

  const pool = requireAppsDb();
  const exists = (await pool.query(`SELECT 1 FROM ${schema}.shared_kv WHERE key = $1`, [key]))
    .rowCount;
  if (!exists) throw new TRPCError({ code: 'NOT_FOUND', message: 'request not found' });
  const reason = reasonInput ?? 'user-report';

  // F1 dedup: a repeat report of the SAME row by the SAME reporter is a no-op —
  // no 2nd row, no 2nd alert. `filed` is false when this (reporter, key) pair
  // already has a report row, and the observability emit below is skipped entirely.
  // Only a genuinely-new report fires it (distinct keys / distinct reporters are
  // unaffected).
  const filed = await insertUserSharedReportDeduped(schema, {
    key,
    reporterUserId: uid,
    reason,
  });
  if (!filed) return { ok: true as const };

  // FIX 1 (pre-GA gate 1 — make abuse OBSERVABLE): a user report previously
  // filed a `shared_kv_reports` row that NOTHING reads, so ordinary abuse
  // (harassment / brigading / spam that dodged the auto-audit) was invisible.
  // Emit a structured, alertable event mirroring the auto-block emit above —
  // METADATA ONLY (userId / slug / appBlockId / reason / reported key), NEVER the
  // reported content itself. Fire-and-forget (`.catch`) so a logging outage can
  // never fail a legitimate report.
  //
  // This emit is now the ONLY outbound side effect of a report. The mod-Discord
  // webhook this path used to fire alongside it has been removed as redundant: it
  // carried the same metadata this event already carries, to a surface that cannot
  // be triaged, ranked or ruled on and that scrolls away. The durable record is the
  // `shared_kv_reports` row filed just above; a moderator acts on a reported row via
  // `apps.mod.purgeSharedRow`.
  logToAxiom(
    {
      name: 'app-blocks-shared-storage-report',
      type: 'warning',
      userId: uid,
      slug,
      appBlockId,
      reason,
      key,
    },
    'block-audit'
  ).catch(() => {});

  return { ok: true as const };
}

export const appsSharedRouter = router({
  /** @see listSharedRows — the shared implementation, also behind GET /api/v1/blocks/shared-storage/list. */
  list: publicProcedure
    .input(
      blockTokenInput.extend({
        prefix: z.string().max(SHARED_PREFIX_MAX).optional(),
        limit: z
          .number()
          .int()
          .min(1)
          .max(SHARED_LIST_LIMIT_MAX)
          .default(SHARED_LIST_LIMIT_DEFAULT),
        cursor: z.string().max(SHARED_CURSOR_MAX).optional(),
        // civitai/civitai#5354 Q3 — see `listSharedRows`' JSDoc.
        // ⚠ NOT justified by the REST/bridge non-divergence rule, which an earlier
        // draft of this comment cited. That rule holds because both paths call
        // THIS function with the same authz and SQL, and it keeps holding whether
        // or not the argument lists match — it is about the shared callee, not
        // about parity of inputs. `mine` is here because the bridge hosts forward
        // it (PageBlockHost.tsx / IframeHost.tsx, both in this change), which is
        // what makes the parameter reachable by a block at all.
        mine: z.boolean().optional(),
      })
    )
    .query(async ({ input }) =>
      listSharedRows(input.blockToken, {
        prefix: input.prefix,
        limit: input.limit,
        cursor: input.cursor,
        mine: input.mine,
      })
    ),

  /** @see getSharedRow — also behind GET /api/v1/blocks/shared-storage/item. */
  get: publicProcedure
    .input(blockTokenInput.extend({ key: sharedKeyInput }))
    .query(async ({ input }) => getSharedRow(input.blockToken, input.key)),

  /**
   * Aggregate vote count for a single key. Delegates to `getSharedCounts` with a
   * one-element array — the batch query already returns 0 for a missing/hidden
   * key, so there is no separate single-key SQL to keep in step.
   */
  getCount: publicProcedure
    .input(blockTokenInput.extend({ key: sharedKeyInput }))
    .query(async ({ input }) => {
      const { counts } = await getSharedCounts(input.blockToken, [input.key]);
      return { count: counts[input.key] ?? 0 };
    }),

  /** @see getSharedCounts — also behind GET /api/v1/blocks/shared-storage/counts. */
  getCounts: publicProcedure
    .input(
      blockTokenInput.extend({
        keys: z.array(sharedKeyInput).min(1).max(SHARED_COUNTS_KEYS_MAX),
      })
    )
    .query(async ({ input }) => getSharedCounts(input.blockToken, input.keys)),

  /** @see appendSharedRow — also behind POST /api/v1/blocks/shared-storage/append. */
  append: publicProcedure
    .input(blockTokenInput.extend({ value: sharedValueInput }))
    .mutation(async ({ input }) => appendSharedRow(input.blockToken, input.value)),

  /** @see updateSharedRow — also behind POST /api/v1/blocks/shared-storage/update. */
  update: publicProcedure
    .input(blockTokenInput.extend({ key: sharedKeyInput, value: sharedValueInput }))
    .mutation(async ({ input }) => updateSharedRow(input.blockToken, input.key, input.value)),

  /** @see voteSharedRow — also behind POST /api/v1/blocks/shared-storage/vote. */
  vote: publicProcedure
    .input(blockTokenInput.extend({ key: sharedKeyInput }))
    .mutation(async ({ input }) => voteSharedRow(input.blockToken, input.key)),

  /** @see unvoteSharedRow — also behind POST /api/v1/blocks/shared-storage/unvote. */
  unvote: publicProcedure
    .input(blockTokenInput.extend({ key: sharedKeyInput }))
    .mutation(async ({ input }) => unvoteSharedRow(input.blockToken, input.key)),

  /** @see withdrawSharedRow — also behind POST /api/v1/blocks/shared-storage/withdraw. */
  withdraw: publicProcedure
    .input(blockTokenInput.extend({ key: sharedKeyInput }))
    .mutation(async ({ input }) => withdrawSharedRow(input.blockToken, input.key)),

  /** @see reportSharedRow — also behind POST /api/v1/blocks/shared-storage/report. */
  report: publicProcedure
    .input(
      blockTokenInput.extend({
        key: sharedKeyInput,
        reason: z.string().max(SHARED_REASON_MAX).optional(),
      })
    )
    .mutation(async ({ input }) => reportSharedRow(input.blockToken, input.key, input.reason)),
});

// ── App Blocks play-counts (block REST endpoints) ─────────────────────────────
// A monotonic per-key counter surface over the SAME `counters` table the
// vote-tally uses, for app-defined counters (e.g. `playcount:<collectionId>`).
// Reuses resolveSharedContext so ALL the shared-storage security holds verbatim:
// per-app schema isolation (sanitizeAppSlug), approved-block + revocation checks,
// the per-op scope assertion, the fail-closed Flipt kill-switch, and — for the
// WRITE (increment) — the min-trust gate + write-scope. This is the anti-inflation
// posture the coordinator required: a sub-trust caller is DENIED (the app treats
// increment as best-effort/fire-and-forget), so a fresh/sybil account can't pump
// a count.

// Per-app counter keys are bounded to the shared key shape (≤64 chars) — same
// bound as the vote `key` input.
const COUNTER_KEY_MAX = 64;

/**
 * Increment (by 1) the counter for `key` in THIS app's shared schema. The
 * `counters.key` column FK-references `shared_kv.key`, so we first upsert a tiny
 * ANCHOR `shared_kv` row for the key (value `{}`) inside the same txn (under the
 * quota GUC), then upsert the counter. Rate-limited on the SAME per-(user, app)
 * vote bucket as the shared vote path. Returns the new count. The KEY is app-chosen text
 * that `getTop` returns to every reader, so it gets the same flag-governed local
 * moderation as a `data` leaf (see `shared-data-moderation.ts`).
 *
 * NOTE (best-effort/anti-abuse): the per-user shared_kv row cap that `append`
 * enforces is intentionally NOT applied here — counter keys are app-global
 * (one anchor row per key across ALL users), created at most once per key. The
 * write-scope + min-trust gate + rate limit + the app byte/row quota trigger are
 * the bounds. Counter anchor rows carry a distinct app-chosen key prefix (e.g.
 * `playcount:`), so an app that also runs a request feed keeps them separable.
 */
export async function incrementSharedCounter(
  blockToken: string,
  key: string
): Promise<{ key: string; count: number }> {
  const { userId, subjectUser, slug, schema, appBlockId } = await resolveSharedContext(
    blockToken,
    'increment'
  );
  const uid = userId as number; // non-null (write path ran the trust gate)

  const rl = await checkSharedVoteRateLimit(uid, appBlockId);
  if (!rl.allowed) {
    throw new TRPCError({
      code: 'TOO_MANY_REQUESTS',
      message: `Too many increments — retry in ${rl.retryAfterSeconds}s`,
    });
  }

  // The key is app-chosen text that `getTop` hands to every reader, so it is moderated as one
  // leaf, under the same two flags as `data` (see `shared-data-moderation.ts`).
  //
  // 🔴 A COUNTER KEY IS SCANNED ONLY ON THE INCREMENT THAT CREATES IT — IN BOTH MODES. A key's text
  // never changes after creation, so every later increment of an existing key reads nothing, which
  // keeps two blocklist reads and an event off every increment of a hot counter. Keys that already
  // existed before either flag was on are NOT re-checked per increment: they are covered by an
  // offline replay run before the enforce flip (the live count of such keys was 0 when measured).
  //
  // "Creates" is decided by the anchor INSERT below actually inserting, inside the write
  // transaction, so it cannot race a moderator purge or a concurrent creator. Shadow scans after the
  // commit. Enforce must scan BEFORE the key exists, but not inside the transaction: the anchor
  // INSERT fires the quota trigger, which holds this app's quota-row lock until commit, and a
  // blocklist read must not hold every other shared write of the app behind it. So an enforce
  // increment that would create the key rolls back, scans with no transaction open, and — if the
  // key is clean — runs once more without the check (by then it may already exist, which is fine:
  // whoever created it was scanned the same way).
  const moderationMode = await resolveSharedDataModerationMode(appBlockId);
  const pool = requireAppsDb();

  /** One increment transaction. `null` = it would have created the key and was rolled back. */
  const runIncrement = async (
    rollBackCreate: boolean
  ): Promise<{ createdKey: boolean; count: number } | null> => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // GUC drives the shared_kv quota trigger (byte/row accounting on the anchor).
      await client.query(`SET LOCAL app.current_app_block_id = ${pgQuoteLiteral(appBlockId)}`);
      // Anchor row so the counters FK holds. INSERT-or-ignore: created once per key.
      const anchor = await client.query(
        `INSERT INTO ${schema}.shared_kv (key, author_user_id, value)
         VALUES ($1, $2, '{}'::jsonb)
         ON CONFLICT (key) DO NOTHING`,
        [key, uid]
      );
      const createdKey = (anchor.rowCount ?? 0) > 0;
      if (rollBackCreate && createdKey) {
        await client.query('ROLLBACK');
        return null;
      }
      const rows = (
        await client.query<{ count: string }>(
          `INSERT INTO ${schema}.counters AS c (key, count)
           VALUES ($1, 1)
           ON CONFLICT (key) DO UPDATE SET count = c.count + 1
           RETURNING c.count::text AS count`,
          [key]
        )
      ).rows;
      await client.query('COMMIT');
      return { createdKey, count: Number(rows[0]?.count ?? '0') };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  };

  let outcome = await runIncrement(moderationMode === 'enforce');
  if (!outcome) {
    // Enforce, and this increment would create the key: scan it now, with no transaction open.
    const scan = await enforceScan(
      () => scanCounterKey(key, { isModerator: subjectUser?.isModerator }),
      { appBlockId, surface: 'counter' }
    );
    // Records the scan; on a hit, files the consequences against the caller (the would-be creator)
    // and throws, so nothing was ever written.
    await refuseSharedTextHit(scan, await sharedTextBlockingHit(scan), {
      schema,
      slug,
      appBlockId,
      uid,
      rowKey: key,
      surface: 'counter',
    });
    outcome = await runIncrement(false);
    if (!outcome) throw new Error('unreachable: runIncrement(false) never rolls back');
  }
  if (moderationMode === 'shadow' && outcome.createdKey) {
    scheduleSharedDataShadow(() => scanCounterKey(key, { isModerator: subjectUser?.isModerator }), {
      appBlockId,
      rowKey: key,
      surface: 'counter',
    });
  }
  return { key, count: outcome.count };
}

/**
 * Top-N counters (by count DESC) whose key matches `prefix` in THIS app's shared
 * schema. READ op (anon-allowed by the resolver; the block REST endpoint gates on
 * the shared:read scope). Hidden anchor rows are excluded. `limit` is bounded by
 * the caller. Returns `[{ key, count }]`.
 */
export async function getTopSharedCounters(
  blockToken: string,
  prefix: string,
  limit: number
): Promise<Array<{ key: string; count: number }>> {
  const { schema } = await resolveSharedContext(blockToken, 'getTop');
  const pool = requireAppsDb();
  // Escape LIKE metacharacters in the app-supplied prefix (same escape as list).
  const escapedPrefix = (prefix ?? '').replace(/([\\%_])/g, '\\$1');
  const rows = (
    await pool.query<{ key: string; count: string }>(
      `SELECT c.key, c.count::text AS count
         FROM ${schema}.counters c
         JOIN ${schema}.shared_kv s ON s.key = c.key
        WHERE s.hidden_at IS NULL
          AND c.key LIKE $1 ESCAPE '\\'
        ORDER BY c.count DESC, c.key ASC
        LIMIT $2`,
      [`${escapedPrefix}%`, limit]
    )
  ).rows;
  return rows.map((r) => ({ key: r.key, count: Number(r.count) }));
}

/** Shared key-shape validator for the block counter endpoints (≤64 chars). */
export function assertValidCounterKey(key: unknown): string {
  if (typeof key !== 'string' || key.length < 1 || key.length > COUNTER_KEY_MAX) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'invalid counter key' });
  }
  return key;
}

/**
 * Cross-app moderator surface (design M4). SESSION-authed (moderatorProcedure) —
 * NOT reachable by a block token. Hides OR hard-deletes any (appBlockId, key)
 * shared row across ANY app, cascades its votes/counter (hard-delete), and files a
 * Report row. The app slug is derived server-side from the AppBlock row, never
 * from client input.
 */
export const appsModRouter = router({
  /**
   * PER-USER storage moderation (`apps.mod.userStorage.*`) — preview + targeted
   * purge + account-wide purge. A DIFFERENT surface from `purgeSharedRow` below:
   * that one is row-scoped on `shared_kv` (app-global, cross-user readable, with
   * votes cascading off it), this one is user-scoped on `kv` (the user's own
   * self-scoped data) plus its `user_quota` accounting. Neither reaches the
   * other's tables — see `user-storage-purge.service.ts` for why they stay apart.
   */
  userStorage: appsModUserStorageRouter,

  purgeSharedRow: moderatorProcedure
    .input(
      z.object({
        appBlockId: z.string().min(1).max(64),
        key: sharedKeyInput,
        action: z.enum(['hide', 'delete']),
        reason: z.string().max(500).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const block = await dbRead.appBlock.findUnique({
        where: { id: input.appBlockId },
        select: { id: true, blockId: true },
      });
      if (!block) throw new TRPCError({ code: 'NOT_FOUND', message: 'app block not found' });
      const slug = sanitizeAppSlug(block.blockId);
      if (!slug) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'invalid app slug' });
      }
      const schema = appSchemaIdent(slug);
      const pool = requireAppsDb();

      let affected = 0;
      if (input.action === 'hide') {
        const result = await pool.query(
          `UPDATE ${schema}.shared_kv
              SET hidden_at = now(), hidden_by = $2
            WHERE key = $1 AND hidden_at IS NULL`,
          [input.key, ctx.user.id]
        );
        affected = result.rowCount ?? 0;
      } else {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query(
            `SET LOCAL app.current_app_block_id = ${pgQuoteLiteral(input.appBlockId)}`
          );
          const result = await client.query(`DELETE FROM ${schema}.shared_kv WHERE key = $1`, [
            input.key,
          ]);
          await client.query('COMMIT');
          affected = result.rowCount ?? 0;
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        } finally {
          client.release();
        }
      }

      // Hidden or deleted in the app ⇒ hidden in the store, whether or not this call changed
      // the shared row (it may have been hidden already).
      await syncStoreItem({
        appBlockId: block.id,
        itemKey: input.key,
        change: 'hidden',
        moderatorId: ctx.user.id,
      });

      // File the Report row (kept even after a hard delete — key is not FK'd here).
      await insertSharedReport(schema, {
        key: input.key,
        reporterUserId: ctx.user.id,
        reason: `mod:${input.action}${input.reason ? `:${input.reason}` : ''}`,
      }).catch(() => {});

      return { ok: true as const, action: input.action, affected };
    }),
});

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Shared belt + serialize + cap path used by BOTH `append` (create) and `update`
 * (author-scoped in-place edit) so the two are moderated identically (no drift).
 *
 * Runs the BLOCKING content-safety belt on the MODERATED title/body (Fix 2: text is
 * stored RAW — XSS is contained at the text-render + opaque-origin-sandbox layers,
 * never escaped at rest). On a policy block it files a Report row (minor/POI/audit)
 * and emits the metadata-only, fire-and-forget abuse alert (legal-block for
 * minor/POI; the separate lower-urgency content-block for a general audit hit) — the
 * SAME observability append historically had inline — then throws BAD_REQUEST.
 *
 * `data` is the app-owned payload: it is folded into the stored value but NEVER runs the
 * title/body belt. Its strings and object keys get the LOCAL leaf moderation in
 * `shared-data-moderation.ts` instead, governed by two per-app flags: off (the shipped
 * default — `data` is not read at all), shadow (scanned after the write commits, recorded,
 * never rejected — the caller schedules that from the returned `moderation`), or enforce
 * (scanned here, before the write, and rejected via `refuseSharedTextHit`). It holds
 * PLAIN-JSON app state round-tripped as JSON (superjson-special types are NOT preserved),
 * and because `z.unknown()` does no validation, JSON.stringify can THROW (BigInt /
 * circular) — guarded to a clean BAD_REQUEST, never an unhandled 500. The whole
 * serialized value is bounded by SHARED_VALUE_BYTE_CAP.
 *
 * Returns the store-ready serialized JSON + its byte size (for the caller's per-app
 * quota accounting). Runs BEFORE any DB write, so no row is ever written on failure.
 */
async function assertSharedValueSafeAndSerialize(params: {
  schema: string;
  slug: string;
  appBlockId: string;
  uid: number;
  subjectUser: SessionUser | null;
  value: { title: string; body?: string; data?: unknown };
  surface: 'append' | 'update';
  /** The row being edited (update). A create has no key until it is written. */
  rowKey?: string;
}): Promise<{
  serialized: string;
  byteSize: number;
  /** For the caller's post-commit shadow scan. `readStoredData` parses `serialized` back. */
  moderation: { mode: SharedDataModerationMode; readStoredData: () => unknown };
}> {
  const { schema, slug, appBlockId, uid, subjectUser, value } = params;

  let safe: { title: string; body?: string };
  try {
    safe = await assertSharedTextSafe({
      title: value.title,
      body: value.body,
      userId: uid,
      isModerator: subjectUser?.isModerator,
    });
  } catch (e) {
    if (e instanceof SharedContentBlockedError) {
      await fileSharedBlockConsequences(
        { schema, slug, appBlockId, uid },
        { policy: e.category, category: e.category, reason: `auto:${e.category}` }
      );
      throw new TRPCError({ code: 'BAD_REQUEST', message: e.message, cause: e });
    }
    throw e;
  }

  const storedValue = {
    title: safe.title,
    ...(safe.body != null ? { body: safe.body } : {}),
    ...(value.data !== undefined ? { data: value.data } : {}),
  };
  let serialized: string;
  try {
    serialized = JSON.stringify(storedValue);
  } catch {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'value is not serializable' });
  }
  const byteSize = Buffer.byteLength(serialized, 'utf8');
  if (byteSize > SHARED_VALUE_BYTE_CAP) {
    throw new TRPCError({ code: 'PAYLOAD_TOO_LARGE', message: 'value exceeds size cap' });
  }

  // `data` moderation (see `shared-data-moderation.ts` for the modes). Runs AFTER the title/body
  // belt and the byte cap, so a value that fails either is refused exactly as before, and the walk
  // is bounded by SHARED_VALUE_BYTE_CAP. Both flags OFF ⇒ nothing below parses or scans anything.
  //
  // 🔴 The scan reads the SERIALIZED value parsed back, not `value.data`: that is the exact JSON
  // that will be stored and later rendered, so a superjson-revived `Date`, a `toJSON` override or a
  // dropped `undefined` is seen in its stored form rather than guessed at. Pinned by the
  // revived-`URL` / `Date` cases in `apps-shared.router.test.ts` (a scan of `value.data` reads a
  // revived `URL` as an object with no keys, and passes it).
  const mode = await resolveSharedDataModerationMode(appBlockId);
  // A thunk, so shadow mode parses off the request path too (inside the deferred scan).
  const readStoredData = () =>
    value.data === undefined ? undefined : (JSON.parse(serialized) as { data?: unknown }).data;
  if (mode === 'enforce') {
    const scan = await enforceScan(
      () => scanSharedData(readStoredData(), { isModerator: subjectUser?.isModerator }),
      { appBlockId, surface: params.surface }
    );
    await refuseSharedTextHit(scan, await sharedTextBlockingHit(scan), {
      schema,
      slug,
      appBlockId,
      uid,
      rowKey: params.rowKey ?? '',
      surface: params.surface,
    });
  }
  return { serialized, byteSize, moderation: { mode, readStoredData } };
}

/**
 * The consequences of a blocked shared-storage write, in ONE place for every surface that blocks
 * one — the title/body belt above, and `data` leaves / counter keys below — so a change to who gets
 * reported or alerted cannot land on one and miss the other.
 *
 * - minor / POI / audit file a Report row for mod review (link, pattern, size and overflow are user
 *   error or list hygiene, not reportable abuse);
 * - TWO DISTINCT alerts, kept separate so the legal-urgency channel is not diluted: minor/POI →
 *   `…-legal-block` / `type:error`; a general audit block → `…-content-block` / `type:warning`.
 *
 * METADATA ONLY (never the content text); fire-and-forget (an alert emit must never block or fail
 * the op). `field` is set only for the `data` / counter-key surfaces, so the title/body events are
 * exactly what they were.
 */
async function fileSharedBlockConsequences(
  ctx: { schema: string; slug: string; appBlockId: string; uid: number },
  block: {
    /** What decides the consequence. `data`'s `audit_regex` is the title/body `audit`. */
    policy: string;
    /** What the alert reports. */
    category: string;
    reason: string;
    field?: 'data' | 'counterKey';
  }
): Promise<void> {
  const { policy } = block;
  if (policy === 'minor' || policy === 'poi' || policy === 'audit') {
    await insertSharedReport(ctx.schema, {
      key: null,
      reporterUserId: ctx.uid,
      reason: block.reason,
    }).catch(() => undefined);
  }
  const alert =
    policy === 'minor' || policy === 'poi'
      ? { name: 'app-blocks-shared-storage-legal-block', type: 'error' }
      : policy === 'audit'
      ? { name: 'app-blocks-shared-storage-content-block', type: 'warning' }
      : null;
  if (alert) {
    logToAxiom(
      {
        ...alert,
        category: block.category,
        ...(block.field ? { field: block.field } : {}),
        userId: ctx.uid,
        slug: ctx.slug,
        appBlockId: ctx.appBlockId,
      },
      'block-audit'
    ).catch(() => undefined);
  }
}

/**
 * Run an ENFORCE scan, turning an infrastructure failure (the blocklist or benign-phrase read)
 * into a clean refusal rather than a raw 500 — the same contract the title/body belt keeps in
 * `assertSharedTextSafe`. It fails CLOSED: an unread write is not let through. The refusal is
 * escalated to server-fault severity so the outage is logged as one, not as user error, and the
 * failure is logged by error NAME only.
 */
async function enforceScan(
  run: () => Promise<SharedTextScan>,
  ctx: { appBlockId: string; surface: SharedDataSurface }
): Promise<SharedTextScan> {
  try {
    return await run();
  } catch (error) {
    logToAxiom(
      {
        name: 'app-blocks-shared-data-moderation-scan-failed',
        type: 'error',
        appBlockId: ctx.appBlockId,
        surface: ctx.surface,
        error: error instanceof Error ? error.name : typeof error,
      },
      'block-audit'
    ).catch(() => undefined);
    throw escalateToServerFault(
      new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Content could not be reviewed right now. Please try again.',
      })
    );
  }
}

/**
 * The hit an ENFORCE scan is refused for, or `null` to let the write through.
 *
 * 🔴 A PATTERN-list hit counts only while `user-content-pattern-enforce` is on — the same rule the
 * title/body belt follows inside `throwOnBlockedUserContent`, where a pattern hit is recorded but not
 * enforced until that flag flips. Otherwise turning this surface's enforce flag on would enforce the
 * pattern list on `data` while the same row's title is only recorded. The flag is read only when a
 * pattern hit exists, as there.
 */
async function sharedTextBlockingHit(scan: SharedTextScan): Promise<SharedTextHit | null> {
  const enforcePatterns = scan.hits.some((h) => h.category === 'pattern')
    ? await getFliptBoolean(FLIPT_FEATURE_FLAGS.USER_CONTENT_PATTERN_ENFORCE)
    : false;
  return blockingHit(scan, { enforcePatterns });
}

/**
 * ENFORCE half of shared-text moderation for `data` leaves and counter keys: record the scan, then,
 * when `hit` is set, reject it with the SAME consequences a title/body hit has
 * (`fileSharedBlockConsequences`, attributed to the caller — the writer of the text) and a
 * BAD_REQUEST carrying only a generic message (never the matched term). An overflow (a blob too
 * deep, too wide or too long to read in full) is rejected too: an unread leaf must not pass by being
 * past a cap. With `hit` null it only records.
 *
 * The recording is not awaited and never throws, so it cannot change the outcome either way. An
 * enforce-mode record carries no user text in any column — not the leaf, the key, the path's keys
 * or the matched substring (see `sharedDataHitRows`).
 */
async function refuseSharedTextHit(
  scan: SharedTextScan,
  hit: SharedTextHit | null,
  ctx: {
    schema: string;
    slug: string;
    appBlockId: string;
    uid: number;
    rowKey: string;
    surface: SharedDataSurface;
  }
): Promise<void> {
  void recordSharedDataScan(scan, {
    appBlockId: ctx.appBlockId,
    rowKey: ctx.rowKey,
    surface: ctx.surface,
    mode: 'enforce',
    blocked: hit != null,
  });
  if (!hit) return;

  const field = ctx.surface === 'counter' ? 'counterKey' : 'data';
  await fileSharedBlockConsequences(ctx, {
    policy: hit.category === 'audit_regex' ? 'audit' : hit.category,
    category: hit.category,
    reason: `auto:${field}:${hit.category}`,
    field,
  });

  const message =
    hit.category === 'link'
      ? 'Content contains a blocked link'
      : hit.category === 'overflow'
      ? 'Data is too large or too deeply nested to review'
      : 'Content flagged for review';
  throw new TRPCError({ code: 'BAD_REQUEST', message });
}

async function insertSharedReport(
  schema: string,
  args: { key: string | null; reporterUserId: number | null; reason: string }
): Promise<void> {
  const pool = requireAppsDb();
  await pool.query(
    `INSERT INTO ${schema}.shared_kv_reports (id, key, reporter_user_id, reason)
     VALUES ($1, $2, $3, $4)`,
    [`skr_${newUlid()}`, args.key, args.reporterUserId, args.reason]
  );
}

/**
 * F1 — file a USER report row with per-(reporter, key) dedup. A single
 * conditional INSERT that no-ops when this reporter already has a report row for
 * this key. Returns true iff a NEW row was filed — the caller then emits the
 * abuse alert; false on a duplicate (skip it, so a re-report can't grow the table
 * or re-emit the same alert).
 *
 * `reporter_user_id` and `key` are both non-null on the user-report path (the
 * subject uid + a validated key), so `WHERE NOT EXISTS` is exact. It is scoped to
 * the (reporter, key) pair, so it never collides with the auto-report rows
 * (`key IS NULL`) or another user's report of the same key. NOTE (honest bound):
 * under two TRULY-simultaneous identical reports READ COMMITTED can admit both —
 * the per-(user, app) report rate limit is the hard ceiling; this collapses the
 * common repeat-click / retry case, which is the actual report-spam vector.
 */
async function insertUserSharedReportDeduped(
  schema: string,
  args: { key: string; reporterUserId: number; reason: string }
): Promise<boolean> {
  const pool = requireAppsDb();
  const res = await pool.query(
    `INSERT INTO ${schema}.shared_kv_reports (id, key, reporter_user_id, reason)
     SELECT $1, $2, $3, $4
     WHERE NOT EXISTS (
       SELECT 1 FROM ${schema}.shared_kv_reports
       WHERE reporter_user_id = $3 AND key = $2
     )`,
    [`skr_${newUlid()}`, args.key, args.reporterUserId, args.reason]
  );
  return (res.rowCount ?? 0) > 0;
}

function isForeignKeyViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err != null &&
    'code' in err &&
    (err as { code?: unknown }).code === '23503'
  );
}
