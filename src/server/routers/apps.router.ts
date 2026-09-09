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
import { isAppBlocksAuthorEnabled, isAppBlocksEnabled } from '~/server/services/app-blocks-flag';
import { sessionClient } from '~/server/auth/session-client';
import type { SessionUser } from '~/types/session';
import { AppStorageProvisioner } from '~/server/services/apps/storage-provision.service';
import {
  appStorageLatencyHistogram,
  appStorageOpsCounter,
  appStorageQuotaExceededCounter,
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

const STORAGE_LOG = 'app-storage-trpc';

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
      const { userId, schema, appBlockId, blockInstanceId } = await resolveStorageContext(
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
      const quotaRows = (
        await pool.query<{ used_bytes: string; row_count: string }>(
          `SELECT used_bytes::text, row_count::text FROM ${schema}.quota WHERE app_block_id = $1`,
          [appBlockId]
        )
      ).rows;
      const usedBytes = Number(quotaRows[0]?.used_bytes ?? '0');
      const rowCount = Number(quotaRows[0]?.row_count ?? '0');

      // For an update we need the old size to know the net delta;
      // skipping a pre-flight read on update would let an in-place
      // shrink falsely fail the quota gate. Fetch it once cheaply.
      const existing = (
        await pool.query<{ size_bytes: number }>(
          `SELECT size_bytes FROM ${schema}.kv
            WHERE block_instance_id = $1 AND user_id = $2 AND key = $3`,
          [blockInstanceId, userId, input.key]
        )
      ).rows;
      const oldSize = existing[0]?.size_bytes ?? 0;
      const isInsert = existing.length === 0;
      const netDelta = byteSize - oldSize;

      if (usedBytes + netDelta > APP_QUOTA_BYTES) {
        appStorageOpsCounter.inc({ op: 'set', outcome: 'quota_exceeded' });
        appStorageQuotaExceededCounter.inc({ app_block_id: appBlockId });
        logToAxiom(
          {
            event: 'quota_exceeded',
            appBlockId,
            usedBytes,
            attemptedBytes: byteSize,
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
        appStorageQuotaExceededCounter.inc({ app_block_id: appBlockId });
        throw new TRPCError({
          code: 'PAYLOAD_TOO_LARGE',
          message: 'app row limit exceeded',
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
        await client.query('ROLLBACK').catch(() => {});
        appStorageOpsCounter.inc({ op: 'set', outcome: 'error' });
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
          sizeBytes: byteSize,
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
          await client.query('ROLLBACK').catch(() => {});
          appStorageOpsCounter.inc({ op: 'delete', outcome: 'error' });
          throw err;
        } finally {
          client.release();
        }
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
      } finally {
        stopTimer();
      }
    }),

  /**
   * Diagnostic / future quota-aware UI. Returns the live quota row plus
   * the v0 limits so a settings panel can show "used 12 MB of 50 MB"
   * without hard-coding the cap on the client.
   */
  getQuota: publicProcedure
    .use(enforceAppBlocksFlag)
    .input(blockTokenInput)
    .query(async ({ input }) => {
      const stopTimer = appStorageLatencyHistogram.startTimer({ op: 'getQuota' });
      try {
        const { slug, schema, appBlockId, reviewPreview } = await resolveStorageContext(
          input.blockToken,
          'getQuota'
        );
        let quota: { usedBytes: number; rowCount: number } | null;
        if (reviewPreview) {
          // Read the preview schema's own quota row directly (the schema is
          // provisioned by resolveStorageContext, so it always exists here).
          const pool = requireAppsDb();
          const rows = (
            await pool.query<{ used_bytes: string; row_count: string }>(
              `SELECT used_bytes::text, row_count::text FROM ${schema}.quota WHERE app_block_id = $1`,
              [appBlockId]
            )
          ).rows;
          quota = {
            usedBytes: Number(rows[0]?.used_bytes ?? '0'),
            rowCount: Number(rows[0]?.row_count ?? '0'),
          };
        } else {
          quota = await AppStorageProvisioner.getQuota({ slug, appBlockId });
        }
        appStorageOpsCounter.inc({ op: 'getQuota', outcome: 'ok' });
        return {
          usedBytes: quota?.usedBytes ?? 0,
          rowCount: quota?.rowCount ?? 0,
          limitBytes: APP_QUOTA_BYTES,
          limitRows: APP_ROW_LIMIT,
        };
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
