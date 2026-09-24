// PER-VIEWER App Storage — the W4-KV-v0 datastore (`app_<slug>.kv`).
//
// This module is the IMPLEMENTATION. It has two callers and no others:
//   - `appsStorageRouter` (`~/server/routers/apps.router`), mounted at
//     `trpc.apps.storage.*` — the postMessage BRIDGE transport;
//   - `/api/v1/blocks/app-storage/{get,set,delete,list,quota}` — the REST
//     transport, for apps running on `@civitai/sdk` rather than the bridge.
//
// It lived in `apps.router.ts` until the REST twins were added. It moved here so
// a route module can reach the implementation WITHOUT module-evaluating
// `appsRouter` — which composes `appsSharedRouter` and the moderator router
// `appsModRouter` and drags their whole transitive service graph into any
// importer's cold start.
//
// Everything auth-gates on the block JWT — no civitai session is involved, and
// nothing here reads a tRPC `ctx`. That is what makes one body serve both
// transports: every viewer binding comes from `parseSubjectUserId(claims.sub)`
// off the VERIFIED token inside `resolveStorageContext`, never from ambient
// request state. The iframe is never trusted with raw DB credentials or query
// construction; it sends a typed message (or an HTTP request), and the function
// scopes the read/write to the resolved (app, instance, user) tuple.
//
// v1 will add `apps.sql.*` (arbitrary query under a `storage:sql` scope) and
// `apps.migrate.*` (per-app schema migrations from the repo's `migrations/`
// directory).

import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import { dbRead, dbWrite } from '~/server/db/client';
import { parseSubjectUserId, verifyBlockToken } from '~/server/middleware/block-scope.middleware';
import { BlockRevocation } from '~/server/services/block-revocation.service';
import { isAppBlocksAuthorEnabled, isAppBlocksEnabled } from '~/server/services/app-blocks-flag';
import { sessionClient } from '~/server/auth/session-client';
import type { SessionUser } from '~/types/session';
import { AppStorageProvisioner } from '~/server/services/apps/storage-provision.service';
import {
  appStorageLatencyHistogram,
  appStorageOpsCounter,
  appStorageQuotaExceededCounter,
  appStorageUserQuotaUntrackedCounter,
} from '~/server/prom/client';
import { logToAxiom } from '~/server/logging/client';
import { requireAppsDb } from '~/server/db/appsDb';
import { appSchemaIdent, sanitizeAppSlug } from '~/server/utils/apps-slug';

/**
 * App Blocks authoring gate: storage procedures are `publicProcedure` +
 * block-token authed — the viewer is resolved from the JWT subject, not
 * `ctx.user`. Re-assert the resolved viewer is an app AUTHOR here (mod OR the
 * app-dev-testers cohort, via the appBlocksAuthor capability) — defense-in-depth
 * per call. Same capability and same refusal message as blocks.router's
 * `assertViewerIsAppDeveloper`, but NOT the same function: this one additionally
 * null-guards the subject (see below), takes `op`, and counts every refusal on
 * `appStorageOpsCounter`. Keep those three when reconciling the two.
 *
 * FAIL-CLOSED ON AN UNHYDRATABLE SUBJECT IS STRUCTURAL HERE, the same shape
 * `assertAppBlocksEnabledForTokenUser` below uses (different code and message —
 * this gate throws FORBIDDEN, that one UNAUTHORIZED): a subject the session hub
 * cannot resolve is refused BEFORE any flag evaluation. Handing
 * `isAppBlocksAuthorEnabled` an `undefined` user instead takes its no-user
 * branch — no moderator floor, then a contextless GLOBAL eval of
 * `app-blocks-author` (entityId `'global'`, empty context), which is fail-closed
 * only until a base-enabled GA flip: a plain base-`enabled: true` flag matches
 * every entityId, the global one included. That matters on THIS gate in
 * particular, because the review-preview branch returns before
 * `assertAppBlocksEnabledForTokenUser` runs, so this is the only subject check
 * that branch makes.
 *
 * Otherwise: a hydrated subject holding neither the moderator floor nor the
 * author cohort → FORBIDDEN.
 *
 * SCOPE: this is the AUTHORING capability, so it belongs ONLY on paths that are
 * genuinely an author/reviewer action — today just the mod review-preview
 * ("run for real") branch, whose rows land in the reviewing MOD's own namespace.
 * The ordinary per-user storage path must NOT use it: reading and writing your
 * own saved data inside an app you are allowed to RUN is a CONSUMER capability
 * (see assertAppBlocksEnabledForTokenUser below).
 *
 * Takes `op` only to label the refusal counter — every OTHER refusal in
 * `resolveStorageContext` is counted, and a capability refusal that is not
 * leaves the "valid token, refused anyway" case visible only in a raw request
 * log (audit 🟡-4).
 */
async function assertViewerIsAppDeveloper(userId: number, op: StorageOp): Promise<void> {
  const user = (await sessionClient.getSessionUserById(userId)) as SessionUser | null;
  // Structural fail-closed: refuse an unhydratable subject outright, before the
  // capability is evaluated. Distinct message from the capability refusal below
  // AND from the run gate's, so all three stay separable in a log and in a test.
  if (!user) {
    appStorageOpsCounter.inc({ op, outcome: 'unauthorized' });
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'review token subject could not be resolved',
    });
  }
  if (!(await isAppBlocksAuthorEnabled({ user }))) {
    appStorageOpsCounter.inc({ op, outcome: 'unauthorized' });
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Apps authoring is not enabled for this account',
    });
  }
}

/**
 * App Blocks RUN gate, evaluated against the BLOCK TOKEN'S SUBJECT.
 *
 * WHY THIS EXISTS — the `enforceAppBlocksFlag` middleware below evaluates
 * `app-blocks-enabled` against `ctx.user`, the request's SESSION user. These
 * procedures are `publicProcedure` authenticated by a block JWT, so the identity
 * that actually owns the rows being read/written is the TOKEN SUBJECT, which the
 * middleware never looks at (and which is absent entirely from `ctx` on a
 * no-session call). The kill-switch has to bind that subject too, or the
 * per-subject half of the gate does not exist.
 *
 * The subject is hydrated the same way blocks.router's gate hydrates it: the FULL
 * server-side SessionUser via `sessionClient.getSessionUserById` (the
 * authoritative hub-backed resolver, never a client-supplied value) so
 * `buildFliptContext` sees the subject's real `isModerator`/`tier` and the
 * segment match cannot be spoofed.
 *
 * FAIL-CLOSED HERE IS STRUCTURAL, NOT INHERITED FROM THE FLAG'S BASE STATE — and
 * it is NOT the only way this gate departs from blocks.router's same-named
 * helper. It also takes `op` and increments `appStorageOpsCounter` on both of its
 * refusals, where blocks.router's `assertAppBlocksEnabledForTokenUser` takes only
 * a userId and counts nothing. Keep all three when reconciling the two. A subject
 * that cannot be hydrated (deleted account, transient session-hub miss) is refused
 * BEFORE any flag evaluation, rather than being passed to `isAppBlocksEnabled` as
 * `undefined`. That overload takes the no-user branch — a GLOBAL eval
 * (entityId `'global'`, empty context; see `isAppBlocksEnabled` in
 * app-blocks-flag.ts) — which refuses today only because `app-blocks-enabled` is
 * base-`false`, so no segment can match. A plain base-`enabled: true` flag (the
 * documented GA shape) matches EVERY entityId, the contextless global one
 * included; on that config the `undefined` path would ADMIT an unresolvable
 * subject and `set` would write rows on its behalf for the rest of the token's
 * lifetime. The explicit null check removes that dependency: the refusal holds
 * on every flag configuration. `resolveSharedContext` in apps-shared.router.ts
 * takes the same approach on its write path (`if (userId == null) throw`, and
 * `assertSharedWriteTrust` opens with `if (!user) return deny(...)`).
 *
 * This is the RUN capability, NOT the authoring one: per-user storage is a
 * consumer surface (your own saved data, in an app you are allowed to open), so
 * gating it on `app-blocks-author` locked every non-author out of every stateful
 * app. Same reasoning the shared-storage resolver already applies — see
 * `resolveSharedContext` in apps-shared.router.ts, which deliberately does not
 * reuse the author gate.
 *
 * `op` labels the refusal counter — see assertViewerIsAppDeveloper above.
 */
async function assertAppBlocksEnabledForTokenUser(userId: number, op: StorageOp): Promise<void> {
  const user = (await sessionClient.getSessionUserById(userId)) as SessionUser | null;
  // Structural fail-closed: refuse an unhydratable subject outright. Distinct
  // message so the two refusals below are separable in a log AND in a test —
  // they are different conditions, not one gate spelled twice.
  if (!user) {
    appStorageOpsCounter.inc({ op, outcome: 'unauthorized' });
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'block token subject could not be resolved',
    });
  }
  if (!(await isAppBlocksEnabled({ user }))) {
    appStorageOpsCounter.inc({ op, outcome: 'unauthorized' });
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Apps are not enabled' });
  }
}

// 50 MB per-app quota. Soft-cap warnings + dynamic quotas are deferred
// to v1; v0 hard-rejects writes that would cross this threshold.
const APP_QUOTA_BYTES = 50 * 1024 * 1024;

// 64 KB per individual KV value, checked in the WIRE unit
// (`Buffer.byteLength(JSON.stringify(v))`). 🔴 It bounds what one call SENDS, not
// what one call STORES, and at per-user scope those diverge enough to matter:
// measured, the largest value this cap admits — 9,362 x `1e308`, 65,535 wire
// bytes — stores 2,911,582 bytes, 44.4x. So a single call can add more stored
// bytes than the entire 2 MiB USER_QUOTA_BYTES budget. The byte ceilings below,
// which are enforced in the stored unit, are what actually bind; the residual is
// that the pre-flight read is one write out of date, so a racing pair can reach
// ~4.8 MiB against a 2 MiB cap rather than ~2 MiB + 64 KiB. See the units block
// in `set` for the expansion measurements.
// v1 SQL access removes this cap (quota tracker becomes the only ceiling).
const PER_VALUE_BYTE_CAP = 64 * 1024;

// 1 million rows per app — companion budget to APP_QUOTA_BYTES. Trigger
// keeps row_count current; gate runs on the cheap counter read.
const APP_ROW_LIMIT = 1_000_000;

// Per-USER sub-budget beneath the two app ceilings above. Both app budgets are
// keyed on app_block_id while `kv` rows are keyed per user, so before these
// existed one account could spend the entire app budget and — because only the
// owning user may delete their own rows — no other user of the app could ever
// reclaim it. These are an anti-monopoly clamp, not a fair share: a fair share of
// 50MB across a popular app's user count lands below a single PER_VALUE_BYTE_CAP
// write.
//
// SIZED AGAINST THE OBSERVED DISTRIBUTION, not a guess. Measured 2026-09-09 over
// every provisioned app schema holding a `kv` table, the largest per-user
// footprint was 0.65 MiB across 49 rows; the next two were 0.47 MiB and 0.30 MiB,
// and every other account was under 20 KiB. A 1 MiB cap would have put that top
// account at 65% of its ceiling — 1.5x headroom on a live, growing app, close
// enough that ordinary continued use would start refusing its writes. 2 MiB gives
// ~3.1x headroom over the largest thing anyone is actually doing while keeping the
// property the cap exists for: it still takes 25 distinct accounts, not one, to
// exhaust the app's 50 MiB.
//
// So this is NOT an "outlier clamp" in the sense of a bound no real workload
// approaches — the top account is within one order of magnitude of it, and that
// is a recorded decision rather than an oversight. Re-measure before moving the
// number again; do not re-derive it from this comment.
//
// The row cap is the comfortable one: the widest observed user holds 49 rows
// against 1000, so 1000 accounts rather than one are needed to exhaust
// APP_ROW_LIMIT and no real workload is anywhere near it.
const USER_QUOTA_BYTES = 2 * 1024 * 1024;
const USER_ROW_LIMIT = 1_000;

const STORAGE_LOG = 'app-storage-trpc';

// Postgres `undefined_table`. A LEFT JOIN tolerates a missing ROW; it does not
// tolerate a missing RELATION, and `user_quota` only exists in schemas that have
// been through AppStorageProvisioner.provision since it was added.
const PG_UNDEFINED_TABLE = '42P01';

function isUndefinedTable(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === PG_UNDEFINED_TABLE
  );
}

/**
 * Count an UNEXPECTED fault on a storage procedure.
 *
 * Every deliberate refusal on these paths increments its own `outcome`
 * (`unauthorized` / `not_found` / `quota_exceeded` / `payload_too_large` /
 * `error`) immediately before throwing a `TRPCError`, so a `TRPCError` arriving
 * here has already been counted and must not be counted twice. Anything else — a
 * pool checkout failure, a missing relation, a constraint violation, a Redis
 * failure inside `resolveStorageContext` — was counted NOWHERE on the read paths
 * and only INSIDE the write transaction on the two mutations. A fault before
 * `BEGIN` (the pre-flight quota round trip, say) therefore showed up solely as
 * the `ok` series falling to zero, with no error series for an alert to fire on.
 *
 * The discriminator is the error type, not a flag threaded through the body: a
 * refusal is always a `TRPCError`, a fault never is. A future `TRPCError` thrown
 * without its own `.inc` would go uncounted — that is the pre-existing contract
 * this preserves, and the reason each refusal counts itself at the throw site.
 */
function countStorageFault(op: StorageOp, err: unknown): void {
  if (err instanceof TRPCError) return;
  appStorageOpsCounter.inc({ op, outcome: 'error' });
}

// H2: evaluated with the request user's context (`ctx.user`) so the live
// `moderators`-segmented Flipt flag resolves ON for a moderator and OFF for a
// non-mod / anon caller — same eval the client gate uses. `ctx.user` is the
// server-side session user, so `isModerator` can't be spoofed by the client.

/**
 * Shared verify + resolve. Returns the validated tuple every storage
 * procedure needs:
 *  - userId  — null for anon (caller decides whether to allow)
 *  - slug    — sanitized from claims.blockId, identifier-safe
 *  - appBlockId — the AppBlock.id PK (quota row key)
 *  - blockInstanceId — from claims, untouched
 *
 * Throws TRPCError UNAUTHORIZED on token failures, NOT_FOUND when the
 * AppBlock has been deleted or isn't approved.
 */
async function resolveStorageContext(
  blockToken: string,
  op: StorageOp
): Promise<{
  userId: number | null;
  slug: string;
  /** The resolved, quoted Postgres schema the op MUST read/write — either the
   *  approved app's `app_<slug>` schema OR (run-for-real) the disposable,
   *  per-publishRequest `apprev_<pubreq>` preview schema. */
  schema: string;
  appBlockId: string;
  blockInstanceId: string;
  /** True when this resolved to the run-for-real preview namespace. */
  reviewPreview: boolean;
}> {
  const claims = await verifyBlockToken(blockToken);
  if (!claims) {
    appStorageOpsCounter.inc({ op, outcome: 'unauthorized' });
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'invalid block token' });
  }
  const slug = sanitizeAppSlug(claims.blockId);
  if (!slug) {
    appStorageOpsCounter.inc({ op, outcome: 'error' });
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'block id is not a valid storage slug',
    });
  }

  // Per-instance revocation. `verifyBlockToken` checks the signature and expiry
  // and nothing else, so without this an uninstall or a mod toggling the instance
  // off leaves every already-minted token reading and writing until natural
  // expiry. A publisher ban writes one too, as of clawgate #618 — into a SEPARATE
  // keyspace, which `isRevoked` checks alongside the install one. The install writer
  // `revokeInstance` has two call sites (`uninstallFromModel`, `toggleEnabled(false)`,
  // both `block-registry.service.ts`); the ban writer `revokeInstanceForBan` has one
  // (`revokeBlockInstancesForPublisher`, called from `toggleBan`). See
  // `block-scope.middleware.ts` for why the keyspaces are split and for what the ban leg
  // does and does not cover.
  // The REST `withBlockScope` middleware and
  // `resolveSharedContext` both enforce it; this path was the remaining gap.
  // Placed before the run-for-real branch so it binds EVERY storage op, not only
  // the approved-app ones.

  // `claims.sub` is passed for the same reason the two runtime guards pass it: the
  // subject-scoped ban keyspace. Latent on THIS path today — it requires an `approved`
  // AppBlock row and an ephemeral app has none — but the argument costs nothing and
  // the alternative is a silent trap pointed at unsubmitted-app storage.
  if (await BlockRevocation.isRevoked(claims.blockInstanceId, claims.sub)) {
    appStorageOpsCounter.inc({ op, outcome: 'unauthorized' });
    throw new TRPCError({ code: 'FORBIDDEN', message: 'block instance revoked' });
  }

  // The DECLARED-scope gate (A5 / design-gaps H4). Reads need apps:storage:read;
  // mutations need apps:storage:write. This runs for BOTH the approved and the
  // run-for-real paths — a review token only carries the scope if the PENDING
  // manifest declared it AND it survived the run-for-real allowlist clamp.
  const requiredScope: string =
    op === 'set' || op === 'delete' ? 'apps:storage:write' : 'apps:storage:read';

  // ── MOD REVIEW SANDBOX "run for real" (#2831) ──────────────────────────────
  // ONLY when the verified token carries the signed `reviewRunForReal` claim: a
  // moderator opted in to run an UNAPPROVED app for real against their OWN
  // account. Resolve a DISPOSABLE, per-publishRequest, ISOLATED preview schema
  // instead of the approved `app_<slug>` schema (which may not exist yet). This
  // branch is GATED entirely on the signed claim — a normal (render-only) review
  // token, or any prod token, never reaches it and keeps failing closed on the
  // approved-status check below, byte-identical to before. Cross-user shared
  // storage is untouched (apps:storage:shared:* lives in a different resolver and
  // is never granted in run-for-real).
  if (claims.reviewRunForReal === true) {
    if (!Array.isArray(claims.scopes) || !claims.scopes.includes(requiredScope)) {
      appStorageOpsCounter.inc({ op, outcome: 'unauthorized' });
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: `storage ${op} requires the ${requiredScope} scope`,
      });
    }
    const userId = parseSubjectUserId(claims.sub);
    // Self-bound: reads/writes land in the reviewing MOD's own rows. A non-mod
    // subject can't hold a review token (mint is mod-gated); assert developer.
    if (userId != null) {
      await assertViewerIsAppDeveloper(userId, op);
    }
    // The preview namespace is keyed on the publishRequestId (the token's
    // `appBlockId` claim = `pubreq_<ULID>`), so it is isolated per pending app AND
    // never aliases the eventual approved `app_<slug>` schema.
    const publishRequestId = claims.appBlockId;
    // ORPHAN GUARD: a run-for-real token lives 4h, but the review preview only
    // exists while the request is PENDING (teardown drops the preview schema on
    // approve/reject). A still-valid token used AFTER the decision must NOT
    // re-provision a fresh `apprev_` schema that nothing would ever tear down
    // again. Mirror the mint's pending-only gate: refuse (and do NOT provision)
    // once the request has left the pending state. Read from the PRIMARY so a
    // just-landed approve/reject isn't missed to replication lag.
    const pr = await dbWrite.appBlockPublishRequest.findUnique({
      where: { id: publishRequestId },
      select: { status: true },
    });
    if (!pr || pr.status !== 'pending') {
      appStorageOpsCounter.inc({ op, outcome: 'unauthorized' });
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'review preview is no longer active for this request',
      });
    }
    // Provision on demand (idempotent; fast-paths once the schema exists).
    const { schema } = await AppStorageProvisioner.provisionReviewPreview({ publishRequestId });
    return {
      userId,
      slug,
      schema,
      appBlockId: publishRequestId,
      blockInstanceId: claims.blockInstanceId,
      reviewPreview: true,
    };
  }

  // 🔴 STRICTER THAN THE SHARED PREDICATE, AND THAT IS A STATEMENT ABOUT THIS TARGET
  // RATHER THAN ABOUT APPROVAL. The run-for-real branch above is this resolver's ONLY
  // exemption. `resolveAppBlockApprovalVerdict`
  // (`~/server/services/blocks/block-approval.service`) — the shared predicate behind the
  // REST middleware and the tRPC bridge — also exempts a token with no backing row and an
  // owner running a suspended app in their own live dev tunnel; neither can apply here,
  // because per-user KV has to resolve to a REAL Postgres schema and a plain dev token
  // names none. `resolveSharedContext` (`apps-shared.router`) is stricter still and
  // exempts nothing. Three rules, one policy plus two structural narrowings — ledgered
  // with their rationales, and enforced on growth and shrink, in
  // `src/server/services/__tests__/no-unguarded-block-rest-token.test.ts`.
  const block = await dbRead.appBlock.findUnique({
    where: { appId_blockId: { appId: claims.appId, blockId: claims.blockId } },
    select: { id: true, status: true },
  });
  if (!block) {
    appStorageOpsCounter.inc({ op, outcome: 'not_found' });
    throw new TRPCError({ code: 'NOT_FOUND', message: 'app block not found' });
  }
  if (block.status !== 'approved') {
    appStorageOpsCounter.inc({ op, outcome: 'unauthorized' });
    throw new TRPCError({ code: 'FORBIDDEN', message: 'app block is not approved' });
  }
  // A5 / design-gaps H4: storage is a DECLARED, approved scope — not an
  // ambient capability. Before touching appsDb, assert the token actually
  // carries the storage scope appropriate to the op. The scope only reaches
  // the token if it was in the manifest AND in the block's approvedScopes
  // snapshot (block-tokens/index.ts), so this re-checks the issuance contract
  // at the point of use. (Previously resolveStorageContext never inspected
  // claims.scopes, so a block approved for e.g. only models:read:self could
  // still read/write 50MB of per-user KV it never disclosed.)
  if (!Array.isArray(claims.scopes) || !claims.scopes.includes(requiredScope)) {
    appStorageOpsCounter.inc({ op, outcome: 'unauthorized' });
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: `storage ${op} requires the ${requiredScope} scope`,
    });
  }

  const userId = parseSubjectUserId(claims.sub);
  // Per-subject kill-switch. A non-null subject must hold the RUN capability
  // (`app-blocks-enabled`) — the same capability the block-token mint gates on
  // (`getFeatureFlags({ user }).appBlocks`), so anyone who could legitimately
  // open this app can also read and write their OWN storage in it.
  //
  // This used to assert the AUTHORING capability (`app-blocks-author`), left over
  // from the pre-GA phase when the two cohorts were the same people. Once the run
  // cohort widened past the author cohort, every non-author with a perfectly valid
  // token got a 403 on all five storage ops, which makes any stateful app
  // unusable — both saving new state and reading back what was already saved.
  // Per-user storage is a consumer capability, not an authoring one.
  //
  // Anon subjects (userId === null) fall through to each op's existing
  // anon-handling (clean-null for reads, UNAUTHORIZED for writes).
  if (userId != null) {
    await assertAppBlocksEnabledForTokenUser(userId, op);
  }
  return {
    userId,
    slug,
    schema: appSchemaIdent(slug),
    appBlockId: block.id,
    blockInstanceId: claims.blockInstanceId,
    reviewPreview: false,
  };
}

type StorageOp = 'get' | 'set' | 'delete' | 'list' | 'getQuota';

const keyInput = z.string().min(1).max(200);

/**
 * The per-op WIRE SHAPES, exported so the `/api/v1/blocks/app-storage/*` REST
 * twins parse with the SAME spelling instead of a second copy of these bounds.
 * A re-spelled bound is the shape that drifts silently: both transports would
 * still "validate the key", just against different maxima.
 *
 * `blockToken` is deliberately NOT part of them. It is the ONE field the two
 * transports genuinely spell differently — on the bridge it rides inside the
 * input object, on REST it rides in the `Authorization` header — so it stays out
 * of the shared shape rather than being faked into the REST body.
 */
export const appStorageKeyInput = z.object({ key: keyInput });
export const appStorageSetInput = z.object({
  key: keyInput,
  // value is intentionally `unknown` here — the server-side cap is
  // by byte-size, not by structural shape. Apps choose their own
  // value schema; the cap keeps the per-write budget bounded.
  value: z.unknown(),
});
export const appStorageListInput = z.object({
  prefix: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  cursor: z.string().max(400).optional(),
});

/**
 * 🔴 APP STORAGE: ONE BODY, TWO TRANSPORTS.
 *
 * The five functions below hold the ENTIRE implementation of per-viewer app
 * storage. The `appsStorageRouter` procedures (the postMessage bridge) and the
 * `/api/v1/blocks/app-storage/*` REST routes are both thin callers of them, so
 * there is exactly one spelling of every control and neither transport can
 * drift from the other.
 *
 * WHY EXTRACTED FUNCTIONS RATHER THAN A tRPC CALLER, since #5068 set the other
 * precedent for the four workflow routes. That choice turned on facts that are
 * simply not true here, and copying it would have made this surface worse:
 *
 *   1. `submitWorkflow` READS `ctx`. None of these five does — every resolver
 *      destructured `({ input })` only, and every viewer binding comes from
 *      `parseSubjectUserId(claims.sub)` off the VERIFIED token inside
 *      `resolveStorageContext`. There is no context to reconstruct.
 *   2. #5068's caller needs a 20-field `publicApiContext2`-shaped context
 *      literal, which is a second copy of a constant set (`TokenScope.Full`
 *      among them). A caller here would have been a THIRD copy. These
 *      functions need no context at all, so that constant is not re-spelled.
 *   3. The one middleware these procedures carry, `enforceAppBlocksFlag`,
 *      evaluates `isAppBlocksEnabled({ user: ctx.user })`. On ANY REST
 *      transport `ctx.user` is undefined, so a caller would evaluate that flag
 *      GLOBALLY — its base value, matching no segment. A caller therefore does
 *      NOT preserve that gate, it DEGRADES it. What actually binds is
 *      `assertAppBlocksEnabledForTokenUser(userId, op)`, which
 *      `resolveStorageContext` runs against the hydrated TOKEN SUBJECT — and
 *      which, living inside these functions, runs identically on BOTH
 *      transports. Extraction keeps the gate that binds.
 *   4. They are short, `ctx`-free procedure bodies — precisely the criteria
 *      #5054 / #5055 used to extract the six SHARED-storage bodies into
 *      `getSharedRow` & co. in `apps-shared.router.ts`. This is that surface's
 *      sibling and it follows that precedent, not the workflow one.
 *
 * The bodies below are a PURE MOVE out of the five resolvers: the only edit is
 * `input.<field>` -> `<field>`, mechanically, for the six fields those bodies
 * referenced. No control was re-spelled, reordered or re-derived.
 */

/**
 * Read one key for the (block_instance, viewer) tuple.
 *
 * Extracted from the `apps.storage.get` procedure body so the REST twin
 * (`/api/v1/blocks/app-storage/get`) and the postMessage bridge run ONE
 * implementation. See `APP STORAGE: ONE BODY, TWO TRANSPORTS` above.
 */
export async function getAppStorageValue(blockToken: string, key: string) {
  const stopTimer = appStorageLatencyHistogram.startTimer({ op: 'get' });
  try {
    const { userId, schema, blockInstanceId } = await resolveStorageContext(blockToken, 'get');
    if (userId == null) {
      appStorageOpsCounter.inc({ op: 'get', outcome: 'ok' });
      return { value: null as unknown };
    }
    const pool = requireAppsDb();
    const rows = (
      await pool.query<{ value: unknown }>(
        `SELECT value FROM ${schema}.kv
           WHERE block_instance_id = $1 AND user_id = $2 AND key = $3`,
        [blockInstanceId, userId, key]
      )
    ).rows;
    appStorageOpsCounter.inc({ op: 'get', outcome: 'ok' });
    return { value: rows[0]?.value ?? null };
  } catch (err) {
    countStorageFault('get', err);
    throw err;
  } finally {
    stopTimer();
  }
}

/**
 * Upsert one value for the (block_instance, viewer) tuple.
 *
 * Extracted from the `apps.storage.set` procedure body — the byte-cap, the two
 * quota ceilings, the stored-vs-wire unit handling and the activity row are all
 * this one copy. See `APP STORAGE: ONE BODY, TWO TRANSPORTS` above.
 */
export async function setAppStorageValue(blockToken: string, key: string, value: unknown) {
  const stopTimer = appStorageLatencyHistogram.startTimer({ op: 'set' });
  try {
    const { userId, slug, schema, appBlockId, blockInstanceId } = await resolveStorageContext(
      blockToken,
      'set'
    );
    if (userId == null) {
      appStorageOpsCounter.inc({ op: 'set', outcome: 'unauthorized' });
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'storage requires an authenticated viewer',
      });
    }

    // 🔴 TWO DIFFERENT BYTE UNITS LIVE IN THIS PROCEDURE. Keep them apart.
    //
    //   `byteSize`        — JS wire bytes, `Buffer.byteLength(JSON.stringify(v))`.
    //                       This is the unit PER_VALUE_BYTE_CAP is enforced in and
    //                       the unit reported back to the block, so a block can
    //                       predict a PAYLOAD_TOO_LARGE from the value it holds.
    //   `storedByteSize`  — what Postgres will store, `octet_length(value::text)`
    //                       over JSONB. This is the unit `kv.size_bytes` carries
    //                       and therefore the unit every quota COUNTER is in.
    //
    // They are not the same number and not a fixed multiple of each other (see
    // the netDelta block below). Anything compared against `usedBytes` /
    // `userUsedBytes` / a *_QUOTA_BYTES ceiling must be in the stored unit;
    // anything compared against PER_VALUE_BYTE_CAP or handed to the block must be
    // in the wire unit.
    //
    // Residual, named rather than silently fixed: PER_VALUE_BYTE_CAP is checked
    // in the wire unit, so a value's stored size is NOT bounded by it — and the
    // expansion has no useful fixed multiplier. Postgres never emits scientific
    // notation for a number, so `1e308` costs 6 wire bytes and stores 309.
    // Measured against Postgres: a 5,000-element dense integer array is 1.50x,
    // `Array(9000).fill(1e308)` is 63,001 wire -> 2,799,000 stored (44.4x), and
    // the largest all-`1e308` array the cap admits (9,362 elements, 65,535 wire)
    // stores 2,911,582 bytes. Treat it as unbounded in practice for
    // numeric-heavy payloads; 2,911,582 is the measured worst case under the cap.
    // That is pre-existing behaviour and it is NOT a ceiling
    // bypass — both byte ceilings below are enforced in the stored unit and bind
    // regardless. Tightening the per-value cap would refuse writes that succeed
    // today, so it is left alone deliberately.
    const serialized = JSON.stringify(value ?? null);
    const byteSize = Buffer.byteLength(serialized, 'utf8');
    if (byteSize > PER_VALUE_BYTE_CAP) {
      appStorageOpsCounter.inc({ op: 'set', outcome: 'payload_too_large' });
      throw new TRPCError({
        code: 'PAYLOAD_TOO_LARGE',
        message: `value exceeds ${PER_VALUE_BYTE_CAP / 1024}KB cap`,
      });
    }

    const pool = requireAppsDb();

    // Pre-flight quota read. used_bytes already reflects all previous
    // writes through the trigger. Worst case the gate is one write
    // out of date (a near-simultaneous write from another tab); we
    // accept a single value's overshoot in exchange for not holding a
    // row lock for the duration of the write.
    //
    // The caller's own counter rides along on the SAME round trip via a LEFT
    // JOIN, so the per-user gate below costs no extra query and no SUM() over
    // the writer's rows — the counter is maintained by kv_user_quota_trigger in
    // the same transaction as the write.
    //
    // DEPLOY ORDER (why the fallback exists). `user_quota` is created by
    // AppStorageProvisioner.provision, whose only callers are new-version
    // approval and the manual admin backfill endpoint — nothing schedules it.
    // So at deploy this code is serving every already-provisioned app whose
    // schema predates the table, and a LEFT JOIN against a relation that does
    // not exist is a hard `42P01`, not a null-filled row: every `set` on every
    // live app would fail until a human ran the backfill. Attempt the joined
    // read, and on `42P01` fall back to the app counters alone with the
    // per-user counters at zero.
    //
    // The fallback leaves the per-user gate INERT for that app rather than
    // failing closed, which is the correct trade: the two app-wide ceilings
    // above still apply, the pre-existing 64KB per-value cap still applies, and
    // an app that has not been backfilled is by construction an app that was
    // running without a per-user cap yesterday. Refusing its writes to enforce a
    // counter that does not exist would convert a missing upgrade into an
    // outage. A `42P01` from a missing `quota` still propagates — the fallback
    // query reads `quota` too, so it raises the same error a second time.
    type QuotaRow = {
      used_bytes: string;
      row_count: string;
      user_used_bytes: string;
      user_row_count: string;
    };
    let quotaRows: QuotaRow[];
    try {
      quotaRows = (
        await pool.query<QuotaRow>(
          `SELECT q.used_bytes::text, q.row_count::text,
                COALESCE(u.used_bytes, 0)::text AS user_used_bytes,
                COALESCE(u.row_count, 0)::text  AS user_row_count
           FROM ${schema}.quota q
           LEFT JOIN ${schema}.user_quota u
             ON u.app_block_id = q.app_block_id AND u.user_id = $2
          WHERE q.app_block_id = $1`,
          [appBlockId, userId]
        )
      ).rows;
    } catch (err) {
      if (!isUndefinedTable(err)) throw err;
      quotaRows = (
        await pool.query<QuotaRow>(
          `SELECT q.used_bytes::text, q.row_count::text,
                '0' AS user_used_bytes,
                '0' AS user_row_count
           FROM ${schema}.quota q
          WHERE q.app_block_id = $1`,
          [appBlockId]
        )
      ).rows;
      // Loud, because an inert gate that nobody can see is how this ships
      // twice. One line per write on an un-upgraded app is a small, bounded
      // population and exactly the signal that says "run the backfill".
      //
      // The Axiom line alone was NOT enough, for the same shape
      // countStorageFault's docstring describes about faults: a condition with no
      // error SERIES of its own is not a condition anything can alert on — there
      // it showed up solely as the `ok` series falling to zero. A state
      // observable only by going and reading logs has the same gap,
      // and nothing schedules the backfill that ends it, so it can persist
      // indefinitely with no bound. The counter is the alertable half — it is
      // the series that says "this app has been running with its per-user
      // sub-budget unenforced", and the series that returns to zero once the
      // backfill has actually reached every app.
      appStorageUserQuotaUntrackedCounter.inc({ app_block_id: appBlockId });
      logToAxiom({ event: 'user_quota_relation_missing', appBlockId, slug }, STORAGE_LOG).catch(
        () => undefined
      );
    }
    const usedBytes = Number(quotaRows[0]?.used_bytes ?? '0');
    const rowCount = Number(quotaRows[0]?.row_count ?? '0');
    const userUsedBytes = Number(quotaRows[0]?.user_used_bytes ?? '0');
    const userRowCount = Number(quotaRows[0]?.user_row_count ?? '0');

    // For an update we need the old size to know the net delta; skipping a
    // pre-flight read on update would let an in-place shrink falsely fail the
    // quota gate. Fetch it once cheaply — together with the NEW size, because
    // both sides of the subtraction have to be in the counter's unit.
    //
    // 🔴 WHY THE NEW SIZE COMES FROM POSTGRES AND NOT FROM `byteSize`.
    // `kv.size_bytes` is `GENERATED ALWAYS AS (octet_length(value::text))` over a
    // JSONB column (storage-provision.service.ts), and the quota trigger sums
    // that column, so the counters are in stored bytes. Postgres' jsonb output
    // function is not `JSON.stringify`: it emits `, ` after every separator and
    // `: ` after every object key. Measured against Postgres: `[1,2,3]` stores 9
    // bytes where JSON.stringify gives 7; `{"a":1,"b":2}` stores 16 against 13; a
    // 5,000-element integer array stores 15,000 against 10,001 — 1.4999x. Scalars
    // (`null`, `"hello"`) agree exactly, which is why a JS-unit delta looks
    // correct on the simplest fixtures.
    //
    // `byteSize - oldSize` therefore was not a measure of growth at all, and the
    // non-increasing exemption below is built on top of that quantity. Held in
    // the wire unit it was a repeatable bypass of BOTH byte ceilings: writing,
    // each pass, the largest value whose WIRE size is <= the row's STORED size
    // keeps the computed delta <= 0 forever while the stored bytes grow ~1.5x per
    // pass, so the exemption skipped the app and per-user byte gates on every one
    // of those writes and neither ceiling ever bound. Reproduced end to end
    // against the provisioner's own DDL and trigger — see the seam test in
    // `apps.router.storage.stored-units.behavior.test.ts`.
    //
    // So ask Postgres for the new size using the same expression the generated
    // column uses, on the same round trip as the old size. `old_size_bytes` is
    // NULL exactly when no row exists: `value` is NOT NULL and `size_bytes` is
    // generated from it, so a row that exists can never carry NULL there. That
    // NULL is what distinguishes an insert from an update.
    //
    // This is a PREDICTION of what the write will store, not a read of what it
    // stored — it is evaluated in a separate statement before the INSERT. It is
    // exact for the same reason the two agree at all: identical input text
    // through identical casts (`$4::jsonb`, then jsonb -> text) evaluated by the
    // same server. That identity is asserted in the seam test against rows
    // Postgres actually wrote, rather than asserted here in prose.
    const sizeRows = (
      await pool.query<{ new_size_bytes: number; old_size_bytes: number | null }>(
        `SELECT octet_length($4::jsonb::text) AS new_size_bytes,
              (SELECT size_bytes FROM ${schema}.kv
                WHERE block_instance_id = $1 AND user_id = $2 AND key = $3)
                AS old_size_bytes`,
        [blockInstanceId, userId, key, serialized]
      )
    ).rows;
    // A `SELECT <expr>` with no FROM returns exactly one row on every Postgres,
    // and both byte gates are computed from it. Absorbing a missing or
    // non-numeric row into a 0 would make `netDelta` 0 or NaN, and BOTH of those
    // sail through the gates below — 0 reads as a non-increasing write and NaN
    // makes every `>` comparison false. Fail loudly instead; this is not a
    // TRPCError, so `countStorageFault` records it as `outcome: 'error'`.
    // 🔴 `Number.isFinite(Number(x))` alone is NOT enough here: `Number(null)` is
    // 0, which is finite, so a NULL `new_size_bytes` would pass the check and
    // then produce `netDelta === 0` — a non-increasing write, which takes the
    // exemption and skips both byte ceilings. That is the same fail-open this
    // guard exists to prevent, reached through the guard rather than around it.
    // Reject the null explicitly, before the coercion.
    const sizeRow = sizeRows[0];
    const rawNewSize = sizeRow?.new_size_bytes ?? null;
    const storedByteSize = Number(rawNewSize);
    if (sizeRow == null || rawNewSize == null || !Number.isFinite(storedByteSize)) {
      throw new Error('app storage: stored-size probe returned no usable row');
    }
    const rawOldSize = sizeRow.old_size_bytes ?? null;
    const oldSize = rawOldSize == null ? 0 : Number(rawOldSize);
    if (!Number.isFinite(oldSize)) {
      throw new Error('app storage: stored-size probe returned a non-numeric old size');
    }
    const isInsert = rawOldSize == null;
    const netDelta = storedByteSize - oldSize;

    // A write that does not grow the stored bytes can never push a counter past
    // a ceiling, so it must never be refused by one — and refusing it is worse
    // than pointless, it is a trap with no exit. `usedBytes` and `userUsedBytes`
    // are what is stored NOW, not a projection: a counter already at or above a
    // ceiling (a cap lowered under existing data, a pre-existing account, a
    // counter drifted by a failed transaction) makes `used + netDelta > CAP`
    // true for a SHRINK as well as a growth, so the one action that would bring
    // the account back under the cap is the action refused. The only other route
    // back is `storage.delete`, which the app has to expose an affordance for.
    //
    // 🔴 THE PREMISE IS LOAD-BEARING AND IT IS A CLAIM ABOUT UNITS. The sentence
    // above is true of `netDelta` only because `netDelta` is now
    // `storedByteSize - oldSize`, i.e. both terms are `octet_length(value::text)`
    // over JSONB — the exact quantity `kv.size_bytes` holds and the quota trigger
    // sums. When the left term was a JS wire byte count the sentence was FALSE:
    // `netDelta <= 0` was satisfiable indefinitely by writes that grew the stored
    // bytes ~1.5x each time, and the exemption then removed both byte gates on
    // every one of them. Do not reintroduce a wire-unit term here.
    //
    // The exemption is still bounded by what it cannot skip: the two row-count
    // gates below are `isInsert`-guarded and unconditional, PER_VALUE_BYTE_CAP is
    // enforced before any of this, and the quota trigger reconciles the counters
    // from the rows themselves after the write.
    //
    // `netDelta <= 0` implies an UPDATE, never an INSERT: `oldSize` is 0 on an
    // insert and the smallest value Postgres will store is `null` at
    // `octet_length('null')` = 4 bytes, so netDelta is >= 4 there. That is why
    // the two row-count gates below stay unconditional — they are already
    // `isInsert`-guarded, and a non-increasing write adds no row.
    const isNonIncreasing = netDelta <= 0;

    if (!isNonIncreasing && usedBytes + netDelta > APP_QUOTA_BYTES) {
      appStorageOpsCounter.inc({ op: 'set', outcome: 'quota_exceeded' });
      appStorageQuotaExceededCounter.inc({ app_block_id: appBlockId, ceiling: 'app' });
      logToAxiom(
        {
          event: 'quota_exceeded',
          appBlockId,
          usedBytes,
          // Stored bytes, not wire bytes — this sits beside `usedBytes`, which
          // is the trigger-maintained counter, and the gate that refused is
          // `usedBytes + netDelta`. A wire byte count here reads as the number
          // that was compared and is not.
          attemptedBytes: storedByteSize,
          netDeltaBytes: netDelta,
          key: key,
        },
        STORAGE_LOG
      ).catch(() => {
        // swallow — best-effort logging must never break the quota refusal it is observing.
      });
      throw new TRPCError({
        code: 'PAYLOAD_TOO_LARGE',
        message: 'app quota exceeded',
      });
    }
    if (isInsert && rowCount + 1 > APP_ROW_LIMIT) {
      appStorageOpsCounter.inc({ op: 'set', outcome: 'quota_exceeded' });
      appStorageQuotaExceededCounter.inc({ app_block_id: appBlockId, ceiling: 'app' });
      throw new TRPCError({
        code: 'PAYLOAD_TOO_LARGE',
        message: 'app row limit exceeded',
      });
    }

    // Sub-budget beneath the two app ceilings above: refusing here leaves the
    // app's remaining budget available to every OTHER user of the app, which is
    // the whole point — the app-wide gates alone let one account take it all.
    //
    // 🔴 These two gates deliberately do NOT test `userQuotaTracked`. Mutants
    // deleting `userQuotaTracked &&` from either gate survived the full suite,
    // because in the fallback the query returns literal '0' for both per-user
    // counters and no fixture in the suite makes the two arms diverge.
    //
    // For the ROW gate that survival is exact — `0 + 1 > 1000` is false either
    // way, so the condition genuinely could not change an outcome there. Writing
    // a condition that cannot change an outcome is worse than omitting it: it
    // reads as coverage and stops anyone looking.
    //
    // 🔴 For the BYTE gate it is NOT exact, and the removal DOES change
    // behaviour. `netDelta` is at most `storedByteSize`, but `storedByteSize` is
    // NOT bounded by PER_VALUE_BYTE_CAP — that cap is enforced in the wire unit,
    // and the largest value it admits stores 2,911,582 bytes (measured; see the
    // units block above), past the 2 MiB USER_QUOTA_BYTES on its own. So on an
    // un-backfilled schema, where the fallback pins `userUsedBytes` at 0, this
    // gate now REFUSES that class of write with `per-user storage quota
    // exceeded`, citing a per-user quota the app is not tracking. Kept
    // deliberately: refusing a multi-megabyte single value is the behaviour we
    // want whether or not the counter exists, and the untracked state is carried
    // by the counter named below. Do NOT restore the flag to "fix" this, and do
    // not read this block as saying the two arms cannot diverge.
    //
    // "We did not enforce" stays distinct from "we enforced against zero" where
    // that distinction is actually consumable: the
    // `app_blocks_storage_user_quota_untracked_total` counter and the
    // `user_quota_relation_missing` log on the fallback branch above. The flag
    // itself is gone — it had no reader left that could act on it.
    if (!isNonIncreasing && userUsedBytes + netDelta > USER_QUOTA_BYTES) {
      appStorageOpsCounter.inc({ op: 'set', outcome: 'quota_exceeded' });
      appStorageQuotaExceededCounter.inc({ app_block_id: appBlockId, ceiling: 'user' });
      logToAxiom(
        {
          event: 'user_quota_exceeded',
          appBlockId,
          userId,
          userUsedBytes,
          // Stored bytes — same reasoning as the app-ceiling log above.
          attemptedBytes: storedByteSize,
          netDeltaBytes: netDelta,
          key: key,
        },
        STORAGE_LOG
      ).catch(() => undefined);
      throw new TRPCError({
        code: 'PAYLOAD_TOO_LARGE',
        message: 'per-user storage quota exceeded',
      });
    }
    if (isInsert && userRowCount + 1 > USER_ROW_LIMIT) {
      appStorageOpsCounter.inc({ op: 'set', outcome: 'quota_exceeded' });
      appStorageQuotaExceededCounter.inc({ app_block_id: appBlockId, ceiling: 'user' });
      throw new TRPCError({
        code: 'PAYLOAD_TOO_LARGE',
        message: 'per-user row limit exceeded',
      });
    }

    // Single connection so SET LOCAL is bound to the same backend that
    // runs the trigger. SET LOCAL ends with COMMIT/ROLLBACK.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // current_setting() in the trigger uses the GUC `app.current_app_block_id`.
      // SET LOCAL has no parameter form — quote the literal via the regex-validated
      // appBlockId. (We don't accept it from the user; it came out of the AppBlock
      // PK lookup above.)
      await client.query(`SET LOCAL app.current_app_block_id = ${pgQuoteLiteral(appBlockId)}`);
      await client.query(
        `INSERT INTO ${schema}.kv (block_instance_id, user_id, key, value)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (block_instance_id, user_id, key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [blockInstanceId, userId, key, serialized]
      );
      await client.query('COMMIT');
    } catch (err) {
      // ROLLBACK only — the `error` outcome is counted once by the procedure's
      // catch-all below, which also covers every fault BEFORE this transaction
      // opens (the quota round trip, the pool checkout, token resolution).
      // Counting here as well would double-count exactly the faults that do
      // reach the write.
      await client.query('ROLLBACK').catch(() => {
        // swallow — the transaction is already failing; a ROLLBACK fault must not mask the
        // original error rethrown below.
      });
      throw err;
    } finally {
      client.release();
    }

    appStorageOpsCounter.inc({ op: 'set', outcome: 'ok' });
    logToAxiom(
      {
        event: 'set',
        appBlockId,
        blockInstanceId,
        userId,
        key: key,
        // Both units, named. `sizeBytes` is the wire size (the unit the block
        // sees and the unit PER_VALUE_BYTE_CAP is in); `storedBytes` is what
        // `kv.size_bytes` and every quota counter will carry. Correlating a
        // write against quota growth needs the second one.
        sizeBytes: byteSize,
        storedBytes: storedByteSize,
        isInsert,
      },
      STORAGE_LOG
    ).catch(() => {
      // swallow — best-effort logging must never break the write it is observing.
    });
    // User-facing audit: unify the W4 storage feed into the same Activity
    // tab that surfaces workflow + scope events. Axiom log above stays
    // for ops/debug visibility; this row populates /apps/activity.
    void (async () => {
      const { recordScopeInvocation } = await import(
        '~/server/services/blocks/user-app-surface.service'
      );
      await recordScopeInvocation({
        userId,
        appBlockId,
        blockInstanceId,
        scope: 'apps:storage',
        // Templated, NOT `storage:set:<key>` — `endpoint` is the GROUP BY key
        // of the `topEndpoints` rollup, so a per-key value makes the column
        // unbounded and every bucket count 1. The key is already carried as
        // the per-row payload in `detail` below, so nothing is lost.
        endpoint: 'storage:set',
        statusCode: 200,
        // W13 richer detail — structured ref for the render-time sentence.
        detail: { action: 'storage.set', key: key, outcome: 'ok' },
      });
    })().catch(() => {
      // swallow — the user-facing audit row is best-effort; it must never break the write
      // it records.
    });
    return { ok: true as const, sizeBytes: byteSize };
  } catch (err) {
    countStorageFault('set', err);
    throw err;
  } finally {
    stopTimer();
  }
}

/**
 * Delete one key for the (block_instance, viewer) tuple.
 *
 * Extracted from the `apps.storage.delete` procedure body.
 * See `APP STORAGE: ONE BODY, TWO TRANSPORTS` above.
 */
export async function deleteAppStorageValue(blockToken: string, key: string) {
  const stopTimer = appStorageLatencyHistogram.startTimer({ op: 'delete' });
  try {
    const { userId, schema, appBlockId, blockInstanceId } = await resolveStorageContext(
      blockToken,
      'delete'
    );
    if (userId == null) {
      appStorageOpsCounter.inc({ op: 'delete', outcome: 'unauthorized' });
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'storage requires an authenticated viewer',
      });
    }
    const pool = requireAppsDb();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL app.current_app_block_id = ${pgQuoteLiteral(appBlockId)}`);
      const result = await client.query(
        `DELETE FROM ${schema}.kv
          WHERE block_instance_id = $1 AND user_id = $2 AND key = $3`,
        [blockInstanceId, userId, key]
      );
      await client.query('COMMIT');
      appStorageOpsCounter.inc({ op: 'delete', outcome: 'ok' });
      const deleted = (result.rowCount ?? 0) > 0;
      if (deleted) {
        logToAxiom(
          {
            event: 'delete',
            appBlockId,
            blockInstanceId,
            userId,
            key: key,
          },
          STORAGE_LOG
        ).catch(() => {
          // swallow — best-effort logging must never break the delete it is observing.
        });
        // User-facing audit row — only on actual deletion (a no-op
        // delete shouldn't appear in the user's activity feed).
        void (async () => {
          const { recordScopeInvocation } = await import(
            '~/server/services/blocks/user-app-surface.service'
          );
          await recordScopeInvocation({
            userId,
            appBlockId,
            blockInstanceId,
            scope: 'apps:storage',
            // Templated, NOT `storage:delete:<key>` — bounded aggregation
            // key; the key itself rides in `detail` below (see set above).
            endpoint: 'storage:delete',
            statusCode: 200,
            // W13 richer detail — structured ref for the render-time sentence.
            detail: { action: 'storage.delete', key: key, outcome: 'ok' },
          });
        })().catch(() => {
          // swallow — the user-facing audit row is best-effort; it must never break the delete
          // it records.
        });
      }
      return { ok: true as const, deleted };
    } catch (err) {
      // ROLLBACK only; the `error` outcome is counted once by the catch-all
      // below (see the same note on `set`).
      await client.query('ROLLBACK').catch(() => {
        // swallow — the transaction is already failing; a ROLLBACK fault must not mask the
        // original error rethrown below.
      });
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    countStorageFault('delete', err);
    throw err;
  } finally {
    stopTimer();
  }
}

/**
 * Cursor-paginated key list for the (block_instance, viewer) tuple.
 *
 * Extracted from the `apps.storage.list` procedure body. `limit` is REQUIRED
 * here: the tRPC input schema applies `.default(50)` before the resolver runs,
 * so the body has always seen a number. The REST twin parses with the SAME
 * exported schema (`appStorageListInput`) rather than re-spelling that default.
 * See `APP STORAGE: ONE BODY, TWO TRANSPORTS` above.
 */
export async function listAppStorageKeys(
  blockToken: string,
  { prefix, limit, cursor }: { prefix?: string; limit: number; cursor?: string }
) {
  const stopTimer = appStorageLatencyHistogram.startTimer({ op: 'list' });
  try {
    const { userId, schema, blockInstanceId } = await resolveStorageContext(blockToken, 'list');
    if (userId == null) {
      appStorageOpsCounter.inc({ op: 'list', outcome: 'ok' });
      return { keys: [], nextCursor: undefined as string | undefined };
    }

    const pool = requireAppsDb();
    const afterKey = cursor ? Buffer.from(cursor, 'base64').toString('utf8') : '';
    // % escape so a user-supplied prefix can't break out via wildcards
    const escapedPrefix = (prefix ?? '').replace(/([\\%_])/g, '\\$1');
    const prefixPattern = `${escapedPrefix}%`;

    const rows = (
      await pool.query<{ key: string; updated_at: Date }>(
        `SELECT key, updated_at FROM ${schema}.kv
           WHERE block_instance_id = $1 AND user_id = $2
             AND key LIKE $3 ESCAPE '\\'
             AND key > $4
           ORDER BY key
           LIMIT $5`,
        [blockInstanceId, userId, prefixPattern, afterKey, limit]
      )
    ).rows;

    const nextCursor =
      rows.length === limit
        ? Buffer.from(rows[rows.length - 1].key, 'utf8').toString('base64')
        : undefined;

    appStorageOpsCounter.inc({ op: 'list', outcome: 'ok' });
    return {
      keys: rows.map((r) => ({ key: r.key, updatedAt: r.updated_at })),
      nextCursor,
    };
  } catch (err) {
    countStorageFault('list', err);
    throw err;
  } finally {
    stopTimer();
  }
}

/**
 * The CALLER'S OWN usage against their own caps.
 *
 * Extracted from the `apps.storage.getQuota` procedure body.
 * See `APP STORAGE: ONE BODY, TWO TRANSPORTS` above.
 */
export async function getAppStorageQuota(blockToken: string) {
  const stopTimer = appStorageLatencyHistogram.startTimer({ op: 'getQuota' });
  try {
    const { userId, slug, schema, appBlockId, reviewPreview } = await resolveStorageContext(
      blockToken,
      'getQuota'
    );
    let quota: { usedBytes: number; rowCount: number } | null;
    if (userId == null) {
      // Anon has no rows of its own; the per-user path has no anon storage.
      quota = { usedBytes: 0, rowCount: 0 };
    } else if (reviewPreview) {
      // Read the preview schema's own counter directly (the schema is
      // provisioned by resolveStorageContext, so it always exists here).
      const pool = requireAppsDb();
      const rows = (
        await pool.query<{ used_bytes: string; row_count: string }>(
          `SELECT used_bytes::text, row_count::text FROM ${schema}.user_quota
            WHERE app_block_id = $1 AND user_id = $2`,
          [appBlockId, userId]
        )
      ).rows;
      quota = {
        usedBytes: Number(rows[0]?.used_bytes ?? '0'),
        rowCount: Number(rows[0]?.row_count ?? '0'),
      };
    } else {
      quota = await AppStorageProvisioner.getUserQuota({ slug, appBlockId, userId });
    }
    appStorageOpsCounter.inc({ op: 'getQuota', outcome: 'ok' });
    return {
      usedBytes: quota?.usedBytes ?? 0,
      rowCount: quota?.rowCount ?? 0,
      limitBytes: USER_QUOTA_BYTES,
      limitRows: USER_ROW_LIMIT,
    };
  } catch (err) {
    countStorageFault('getQuota', err);
    throw err;
  } finally {
    stopTimer();
  }
}

// Postgres literal quoting — used ONLY for the regex-validated appBlockId
// in the SET LOCAL GUC where $1 placeholders are not accepted. The
// AppBlock.id format is `apb_<26 ULID chars>`; quote-doubling is
// belt-and-suspenders since the AppBlock PK is server-issued.
function pgQuoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
