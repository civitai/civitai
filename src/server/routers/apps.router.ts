// App Blocks tRPC root (W4-KV-v0).
//
// Mounted at `trpc.apps.*`. v0 ships a single sub-router (`storage`) for
// the KV datastore. v1 will add `apps.sql.*` (arbitrary query under a
// `storage:sql` scope) and `apps.migrate.*` (per-app schema migrations
// from the repo's `migrations/` directory).
//
// Every procedure auth-gates on the block JWT — no civitai session is
// involved. The iframe is never trusted with raw DB credentials or query
// construction; it sends a typed bridge message, the host calls one of
// these procedures, and the procedure scopes the read/write to the
// resolved (app, instance, user) tuple.

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
import { middleware, publicProcedure, router } from '~/server/trpc';
import { appsSharedRouter, appsModRouter } from '~/server/routers/apps-shared.router';

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

// 64 KB per individual KV value — a single oversized write can't burn
// through quota on a single call. v1 SQL access removes this cap (quota
// tracker becomes the only ceiling).
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
const enforceAppBlocksFlag = middleware(async ({ ctx, next, type }) => {
  if (await isAppBlocksEnabled({ user: ctx.user })) return next();
  // Mutations + queries both refuse when the flag is dark — anything else
  // gives the block a misleading-success path. The block already gates
  // its own UI on host signals, so a clean UNAUTHORIZED is fine.
  if (type === 'query') {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Apps are not enabled' });
  }
  throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Apps are not enabled' });
});

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
async function resolveStorageContext(blockToken: string, op: StorageOp): Promise<{
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
  // and nothing else, so without this an uninstall, a mod toggling the instance
  // off, or a publisher ban leaves every already-minted token reading and writing
  // until natural expiry. The REST `withBlockScope` middleware and
  // `resolveSharedContext` both enforce it; this path was the remaining gap.
  // Placed before the run-for-real branch so it binds EVERY storage op, not only
  // the approved-app ones.
  if (await BlockRevocation.isRevoked(claims.blockInstanceId)) {
    appStorageOpsCounter.inc({ op, outcome: 'unauthorized' });
    throw new TRPCError({ code: 'FORBIDDEN', message: 'block instance revoked' });
  }

  // The DECLARED-scope gate (A5 / design-gaps H4). Reads need apps:storage:read;
  // mutations need apps:storage:write. This runs for BOTH the approved and the
  // run-for-real paths — a review token only carries the scope if the PENDING
  // manifest declared it AND it survived the run-for-real allowlist clamp.
  const requiredScope: string = op === 'set' || op === 'delete'
    ? 'apps:storage:write'
    : 'apps:storage:read';

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

const blockTokenInput = z.object({ blockToken: z.string().min(1) });

const keyInput = z.string().min(1).max(200);

export const appsStorageRouter = router({
  /**
   * Read a key for the (block_instance, user) tuple. Returns null when
   * the key doesn't exist OR when the viewer is anon (no per-anon
   * storage in v0). Treating anon as a clean-null lets blocks render
   * defaults without a 401 round-trip.
   */
  get: publicProcedure
    .use(enforceAppBlocksFlag)
    .input(blockTokenInput.extend({ key: keyInput }))
    .query(async ({ input }) => {
      const stopTimer = appStorageLatencyHistogram.startTimer({ op: 'get' });
      try {
        const { userId, schema, blockInstanceId } = await resolveStorageContext(
          input.blockToken,
          'get'
        );
        if (userId == null) {
          appStorageOpsCounter.inc({ op: 'get', outcome: 'ok' });
          return { value: null as unknown };
        }
        const pool = requireAppsDb();
        const rows = (
          await pool.query<{ value: unknown }>(
            `SELECT value FROM ${schema}.kv
               WHERE block_instance_id = $1 AND user_id = $2 AND key = $3`,
            [blockInstanceId, userId, input.key]
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
    }),

  /**
   * Upsert a value. Validates 64KB per-value cap pre-flight, then checks
   * the running quota; the trigger function updates the quota row after
   * the write lands so subsequent calls see fresh used_bytes. Anon
   * writers hit UNAUTHORIZED — anon viewers have no stable identifier
   * to scope writes to.
   */
  set: publicProcedure
    .use(enforceAppBlocksFlag)
    .input(
      blockTokenInput.extend({
        key: keyInput,
        // value is intentionally `unknown` here — the server-side cap is
        // by byte-size, not by structural shape. Apps choose their own
        // value schema; the cap keeps the per-write budget bounded.
        value: z.unknown(),
      })
    )
    .mutation(async ({ input }) => {
      const stopTimer = appStorageLatencyHistogram.startTimer({ op: 'set' });
      try {
      const { userId, slug, schema, appBlockId, blockInstanceId } = await resolveStorageContext(
        input.blockToken,
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
      // in the wire unit, so a single value can occupy up to ~1.5x its nominal
      // 64KB on disk. That is pre-existing behaviour and it is NOT a ceiling
      // bypass — both byte ceilings below are enforced in the stored unit and bind
      // regardless. Tightening the per-value cap would refuse writes that succeed
      // today, so it is left alone deliberately.
      const serialized = JSON.stringify(input.value ?? null);
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
        // The Axiom line alone was NOT enough, for the same reason
        // countStorageFault's docstring gives about faults: a state observable
        // only by going and reading logs is not a state anything can alert on,
        // and nothing schedules the backfill that ends it, so it can persist
        // indefinitely with no bound. The counter is the alertable half — it is
        // the series that says "this app has been running with its per-user
        // sub-budget unenforced", and the series that returns to zero once the
        // backfill has actually reached every app.
        appStorageUserQuotaUntrackedCounter.inc({ app_block_id: appBlockId });
        logToAxiom(
          { event: 'user_quota_relation_missing', appBlockId, slug },
          STORAGE_LOG
        ).catch(() => undefined);
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
          [blockInstanceId, userId, input.key, serialized]
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
            key: input.key,
          },
          STORAGE_LOG
        ).catch(() => {});
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
      // 🔴 These two gates deliberately do NOT test `userQuotaTracked`. They used
      // to, and it was a condition that read as a guard while guarding nothing:
      // mutants deleting `userQuotaTracked &&` from either gate survived the full
      // suite, because in the fallback the query returns literal '0' for both
      // per-user counters and the arithmetic is then identical either way. Writing
      // a condition that cannot change an outcome is worse than omitting it — it
      // reads as coverage and stops anyone looking.
      //
      // Identical for a bounded reason, not by luck: `netDelta` is at most
      // `storedByteSize`, `storedByteSize` is at most ~1.5x PER_VALUE_BYTE_CAP
      // (64KiB, the largest jsonb expansion being the ~1.5x of a dense array), so
      // `0 + netDelta` cannot exceed ~96KiB against a 2MiB USER_QUOTA_BYTES, and
      // `0 + 1` cannot exceed a 1,000-row USER_ROW_LIMIT. Lowering either ceiling
      // near those numbers would make the distinction real again; today it is not.
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
            key: input.key,
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
          [blockInstanceId, userId, input.key, serialized]
        );
        await client.query('COMMIT');
      } catch (err) {
        // ROLLBACK only — the `error` outcome is counted once by the procedure's
        // catch-all below, which also covers every fault BEFORE this transaction
        // opens (the quota round trip, the pool checkout, token resolution).
        // Counting here as well would double-count exactly the faults that do
        // reach the write.
        await client.query('ROLLBACK').catch(() => {});
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
          key: input.key,
          // Both units, named. `sizeBytes` is the wire size (the unit the block
          // sees and the unit PER_VALUE_BYTE_CAP is in); `storedBytes` is what
          // `kv.size_bytes` and every quota counter will carry. Correlating a
          // write against quota growth needs the second one.
          sizeBytes: byteSize,
          storedBytes: storedByteSize,
          isInsert,
        },
        STORAGE_LOG
      ).catch(() => {});
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
          detail: { action: 'storage.set', key: input.key, outcome: 'ok' },
        });
      })().catch(() => {});
      return { ok: true as const, sizeBytes: byteSize };
      } catch (err) {
        countStorageFault('set', err);
        throw err;
      } finally {
        stopTimer();
      }
    }),

  delete: publicProcedure
    .use(enforceAppBlocksFlag)
    .input(blockTokenInput.extend({ key: keyInput }))
    .mutation(async ({ input }) => {
      const stopTimer = appStorageLatencyHistogram.startTimer({ op: 'delete' });
      try {
        const { userId, schema, appBlockId, blockInstanceId } = await resolveStorageContext(
          input.blockToken,
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
            [blockInstanceId, userId, input.key]
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
                key: input.key,
              },
              STORAGE_LOG
            ).catch(() => {});
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
                detail: { action: 'storage.delete', key: input.key, outcome: 'ok' },
              });
            })().catch(() => {});
          }
          return { ok: true as const, deleted };
        } catch (err) {
          // ROLLBACK only; the `error` outcome is counted once by the catch-all
          // below (see the same note on `set`).
          await client.query('ROLLBACK').catch(() => {});
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
    }),

  /**
   * Cursor-paginated key list for the (block_instance, user) tuple.
   * Returns key + updated_at only — values are fetched on demand via
   * `get(key)`. `cursor` is the base64 of the last key returned;
   * `nextCursor` is undefined when fewer than `limit` rows came back.
   */
  list: publicProcedure
    .use(enforceAppBlocksFlag)
    .input(
      blockTokenInput.extend({
        prefix: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(200).default(50),
        cursor: z.string().max(400).optional(),
      })
    )
    .query(async ({ input }) => {
      const stopTimer = appStorageLatencyHistogram.startTimer({ op: 'list' });
      try {
        const { userId, schema, blockInstanceId } = await resolveStorageContext(
          input.blockToken,
          'list'
        );
        if (userId == null) {
          appStorageOpsCounter.inc({ op: 'list', outcome: 'ok' });
          return { keys: [], nextCursor: undefined as string | undefined };
        }

        const pool = requireAppsDb();
        const afterKey = input.cursor
          ? Buffer.from(input.cursor, 'base64').toString('utf8')
          : '';
        // % escape so a user-supplied prefix can't break out via wildcards
        const escapedPrefix = (input.prefix ?? '').replace(/([\\%_])/g, '\\$1');
        const prefixPattern = `${escapedPrefix}%`;

        const rows = (
          await pool.query<{ key: string; updated_at: Date }>(
            `SELECT key, updated_at FROM ${schema}.kv
               WHERE block_instance_id = $1 AND user_id = $2
                 AND key LIKE $3 ESCAPE '\\'
                 AND key > $4
               ORDER BY key
               LIMIT $5`,
            [blockInstanceId, userId, prefixPattern, afterKey, input.limit]
          )
        ).rows;

        const nextCursor =
          rows.length === input.limit
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
    }),

  /**
   * The CALLER'S OWN usage against their own caps, so a settings panel can show
   * "used 12 KB of 2 MB" without hard-coding the cap on the client.
   *
   * Deliberately NOT the app-wide aggregate it used to return. This procedure is
   * reachable by everyone who may RUN the app, and the app aggregate sums other
   * users' rows — a cross-user readout on the one surface whose entire invariant
   * is that a caller only ever sees their own data. It was not actionable either:
   * only the owning user can delete their own rows, so a consumer shown "49 of
   * 50 MB used" cannot free any of it.
   *
   * `AppStorageProvisioner.getQuota` still computes the app aggregate, and this
   * used to say it was "retained for the moderator surface". That was wrong on
   * the facts: it has NO production caller at all — verified 2026-09-09, the only
   * references anywhere are its own definition and its unit tests, and
   * `appsModRouter` exposes no storage-usage readout. Why it is still here is not
   * recorded anywhere, so no reason is asserted for it; it is simply unreferenced.
   *
   * The consequence is worth stating rather than implying: after this change
   * NOTHING reports how close an app is to its 50MB / 1M-row ceiling, so the app
   * ceilings are observable only through `app_blocks_storage_quota_exceeded_total`
   * (`ceiling="app"`) firing after the fact.
   *
   * Field names are unchanged, so the host bridge and the SDK's
   * APP_STORAGE_QUOTA_RESULT contract carry through untouched; what moved is the
   * scope each number describes.
   */
  getQuota: publicProcedure
    .use(enforceAppBlocksFlag)
    .input(blockTokenInput)
    .query(async ({ input }) => {
      const stopTimer = appStorageLatencyHistogram.startTimer({ op: 'getQuota' });
      try {
        const { userId, slug, schema, appBlockId, reviewPreview } = await resolveStorageContext(
          input.blockToken,
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
    }),
});

export const appsRouter = router({
  storage: appsStorageRouter,
  // SHARED (app-global / cross-user) storage — the public-write surface (voting +
  // community lists). Block-token authed with its OWN resolver (resolveSharedContext:
  // trust gate, NOT the app-author gate) + dedicated fail-closed flag. See
  // apps-shared.router.ts.
  shared: appsSharedRouter,
  // Cross-app moderator surface for shared storage (session moderatorProcedure —
  // NOT block-token reachable). Purge/hide any shared row + file a report.
  mod: appsModRouter,
});

// Postgres literal quoting — used ONLY for the regex-validated appBlockId
// in the SET LOCAL GUC where $1 placeholders are not accepted. The
// AppBlock.id format is `apb_<26 ULID chars>`; quote-doubling is
// belt-and-suspenders since the AppBlock PK is server-issued.
function pgQuoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
