// App Blocks SHARED (app-global / cross-user) storage tRPC router.
//
// Mounted at `trpc.apps.shared.*` (block-token authed) + `trpc.apps.mod.*`
// (session moderatorProcedure). This is the FIRST App Blocks surface that opens
// the per-app datastore to PUBLIC cross-user writes — today per-user KV is
// reachable only by mods + app-dev-testers (apps.router `assertViewerIsAppDeveloper`).
// Every control here exists because a community app serves GENERAL users; see the
// hardened design (`shared-storage-design.md`, "HARDENED per design security
// review"). Read that before touching auth/counter/trust logic.
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
import { isAppBlocksSharedStorageEnabled } from '~/server/services/app-blocks-flag';
import { sessionClient } from '~/server/auth/session-client';
import type { SessionUser } from '~/types/session';
import { Flags } from '~/shared/utils/flags';
import { OnboardingSteps } from '~/server/common/enums';
import {
  assertSharedTextSafe,
  SharedContentBlockedError,
  SHARED_TITLE_MAX,
  SHARED_BODY_MAX,
} from '~/server/services/apps/shared-content-safety';
import {
  checkSharedAppendRateLimit,
  checkSharedVoteRateLimit,
} from '~/server/utils/shared-storage-rate-limit';
import { moderatorProcedure, publicProcedure, router } from '~/server/trpc';

// ── Limits (design M2/M3) ─────────────────────────────────────────────────────
// The app quota row is SHARED with the per-user kv path; these mirror the
// apps.router ceilings so shared writes and per-user writes share one 50MB / 1M
// budget. Votes/counters/reports carry NO quota trigger → excluded from bytes.
const APP_QUOTA_BYTES = 50 * 1024 * 1024;
const APP_ROW_LIMIT = 1_000_000;
// Per individual shared value (title+body already capped; this bounds the jsonb).
const SHARED_VALUE_BYTE_CAP = 8 * 1024;
// Per-USER row cap on shared_kv (design M2): one hostile-but-trusted account can't
// exhaust the app row budget on its own.
const SHARED_KV_PER_USER_ROW_CAP = 50;

// ── Min-trust gate (design H3 / MIN-TRUST GATE) ───────────────────────────────
// Account must be older than this to write/vote (anti-sybil). Starts at 7d.
const MIN_ACCOUNT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// Flag-toggleable STRONG anti-sybil lever (design H5): require a paid tier to
// write/vote. OFF by default — flip to true (or wire to a flag) if sybil pressure
// materializes. `free`/absent tier fails when on.
const REQUIRE_PAID_TIER = false;

type SharedOp = 'list' | 'getCount' | 'append' | 'vote' | 'unvote' | 'withdraw' | 'report';
const READ_OPS: ReadonlySet<SharedOp> = new Set<SharedOp>(['list', 'getCount']);

const SHARED_READ_SCOPE = 'apps:storage:shared:read';
const SHARED_WRITE_SCOPE = 'apps:storage:shared:write';

/**
 * The min-trust gate (design H3). Reuses EXISTING civitai trust signals hydrated
 * from `SessionUser` — no new trust score. FAIL-CLOSED: a vanished subject (null),
 * banned, muted, onboarding-incomplete, unverified email, or too-new account is
 * DENIED. `asserts` narrows `user` to non-null for the caller.
 *
 * Signals (all AND-ed):
 *   sub!=anon (caller passes non-null) · !bannedAt · !muted ·
 *   onboarding-complete (Flags.hasFlag(onboarding, Buzz)) · emailVerified present ·
 *   account age ≥ MIN_ACCOUNT_AGE_MS · [optional] paid tier.
 */
export function assertSharedWriteTrust(user: SessionUser | null): asserts user is SessionUser {
  const deny = (message: string): never => {
    throw new TRPCError({ code: 'FORBIDDEN', message });
  };
  if (!user) return deny('Your account is not eligible for this action');
  if (user.bannedAt) return deny('Your account is not eligible for this action');
  if (user.muted) return deny('Your account has been restricted');
  if (!Flags.hasFlag(user.onboarding ?? 0, OnboardingSteps.Buzz)) {
    return deny('Complete onboarding before contributing');
  }
  if (!user.emailVerified) return deny('Verify your email before contributing');
  const createdAt = user.createdAt ? new Date(user.createdAt).getTime() : NaN;
  if (!Number.isFinite(createdAt) || Date.now() - createdAt < MIN_ACCOUNT_AGE_MS) {
    return deny('Your account is too new to contribute');
  }
  if (REQUIRE_PAID_TIER && (!user.tier || user.tier === 'free')) {
    return deny('A membership is required to contribute');
  }
}

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
async function resolveSharedContext(blockToken: string, op: SharedOp): Promise<SharedContext> {
  const claims = await verifyBlockToken(blockToken);
  if (!claims) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'invalid block token' });

  const slug = sanitizeAppSlug(claims.blockId);
  if (!slug) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'block id is not a valid storage slug',
    });
  }

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
  // until token expiry. Mirrors block-scope.middleware's check.
  if (await BlockRevocation.isRevoked(claims.blockInstanceId)) {
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
  // the flag segment eval and the trust gate. Fail-closed on a vanished subject.
  const subjectUser =
    userId != null
      ? ((await sessionClient.getSessionUserById(userId)) as SessionUser | null)
      : null;

  // Dedicated fail-closed kill-switch (evaluated with the subject's context so the
  // flag's mod/cohort segments resolve identically to the client gate; anon read →
  // global eval → fail-closed until a base-enabled GA flip).
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
    assertSharedWriteTrust(subjectUser);
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
const sharedKeyInput = z.string().min(1).max(64);

// Structured, moderatable append payload (design M3: title ≤200, body ≤ few KB).
const appendValueInput = z.object({
  title: z.string().min(1).max(SHARED_TITLE_MAX),
  body: z.string().max(SHARED_BODY_MAX).optional(),
});

export const appsSharedRouter = router({
  /**
   * Cursor-paginated list of shared_kv rows (the "requests" feed). shared_kv +
   * counter aggregate ONLY — NEVER the per-user kv, NEVER the raw vote rows.
   * Hidden rows are excluded. Anon may read. Keyset cursor on the ULID key
   * (newest-first, DESC).
   */
  list: publicProcedure
    .input(
      blockTokenInput.extend({
        prefix: z.string().max(64).optional(),
        limit: z.number().int().min(1).max(100).default(50),
        cursor: z.string().max(200).optional(),
      })
    )
    .query(async ({ input }) => {
      const { schema } = await resolveSharedContext(input.blockToken, 'list');
      const pool = requireAppsDb();

      const afterKey = input.cursor
        ? Buffer.from(input.cursor, 'base64').toString('utf8')
        : null;
      const escapedPrefix = (input.prefix ?? '').replace(/([\\%_])/g, '\\$1');
      const prefixPattern = `${escapedPrefix}%`;

      const rows = (
        await pool.query<{
          key: string;
          author_user_id: number;
          value: unknown;
          count: string;
          created_at: Date;
          updated_at: Date;
        }>(
          `SELECT s.key, s.author_user_id, s.value, COALESCE(c.count, 0)::text AS count,
                  s.created_at, s.updated_at
             FROM ${schema}.shared_kv s
             LEFT JOIN ${schema}.counters c ON c.key = s.key
            WHERE s.hidden_at IS NULL
              AND s.key LIKE $1 ESCAPE '\\'
              AND ($2::text IS NULL OR s.key < $2)
            ORDER BY s.key DESC
            LIMIT $3`,
          [prefixPattern, afterKey, input.limit]
        )
      ).rows;

      const nextCursor =
        rows.length === input.limit
          ? Buffer.from(rows[rows.length - 1].key, 'utf8').toString('base64')
          : undefined;

      return {
        items: rows.map((r) => ({
          key: r.key,
          authorUserId: r.author_user_id,
          value: r.value,
          count: Number(r.count),
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        })),
        nextCursor,
      };
    }),

  /**
   * Aggregate vote count for a single key. counters only (never the vote rows).
   * Returns 0 for a missing/hidden key.
   */
  getCount: publicProcedure
    .input(blockTokenInput.extend({ key: sharedKeyInput }))
    .query(async ({ input }) => {
      const { schema } = await resolveSharedContext(input.blockToken, 'getCount');
      const pool = requireAppsDb();
      const rows = (
        await pool.query<{ count: string }>(
          `SELECT COALESCE(c.count, 0)::text AS count
             FROM ${schema}.shared_kv s
             LEFT JOIN ${schema}.counters c ON c.key = s.key
            WHERE s.key = $1 AND s.hidden_at IS NULL`,
          [input.key]
        )
      ).rows;
      return { count: Number(rows[0]?.count ?? '0') };
    }),

  /**
   * Batch aggregate counts. counters only. Unknown/hidden keys resolve to 0.
   */
  getCounts: publicProcedure
    .input(blockTokenInput.extend({ keys: z.array(sharedKeyInput).min(1).max(100) }))
    .query(async ({ input }) => {
      const { schema } = await resolveSharedContext(input.blockToken, 'getCount');
      const pool = requireAppsDb();
      const rows = (
        await pool.query<{ key: string; count: string }>(
          `SELECT s.key, COALESCE(c.count, 0)::text AS count
             FROM ${schema}.shared_kv s
             LEFT JOIN ${schema}.counters c ON c.key = s.key
            WHERE s.key = ANY($1) AND s.hidden_at IS NULL`,
          [input.keys]
        )
      ).rows;
      const counts: Record<string, number> = {};
      for (const k of input.keys) counts[k] = 0;
      for (const r of rows) counts[r.key] = Number(r.count);
      return { counts };
    }),

  /**
   * Create a shared row (a "request"). The server GENERATES a ULID key (C1: never
   * accept a client key on create → user B can't overwrite user A's row).
   * INSERT-only; author = the token subject. Runs the BLOCKING content-safety belt
   * (C2/C3/M1) synchronously, the per-user + per-app row caps + byte quota, and the
   * per-(user,app) daily rate limit — all before the row lands.
   */
  append: publicProcedure
    .input(blockTokenInput.extend({ value: appendValueInput }))
    .mutation(async ({ input }) => {
      const { userId, subjectUser, slug, schema, appBlockId } = await resolveSharedContext(
        input.blockToken,
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

      // BLOCKING content safety → HTML-escaped, store-ready text.
      let safe: { title: string; body?: string };
      try {
        safe = await assertSharedTextSafe({
          title: input.value.title,
          body: input.value.body,
          userId: uid,
          isModerator: subjectUser?.isModerator,
        });
      } catch (e) {
        if (e instanceof SharedContentBlockedError) {
          // C3/M5: minor/POI/audit hits file a Report row for mod review. (link/size
          // are user error, not reportable abuse.)
          if (e.category === 'minor' || e.category === 'poi' || e.category === 'audit') {
            await insertSharedReport(schema, {
              key: null,
              reporterUserId: uid,
              reason: `auto:${e.category}`,
            }).catch(() => {});
          }
          // H-1 (audit): the `shared_kv_reports` table has no reader yet, so the
          // LEGAL-escalation signal (minor/POI) would otherwise be silent. Emit a
          // structured, alertable event (NEVER the content) so a CSAM/minor attempt
          // is observable even before the mod-queue wiring lands (a pre-GA gate).
          if (e.category === 'minor' || e.category === 'poi') {
            logToAxiom(
              {
                name: 'app-blocks-shared-storage-legal-block',
                type: 'error',
                category: e.category,
                userId: uid,
                slug,
                appBlockId,
              },
              'block-audit'
            ).catch(() => {});
          }
          throw new TRPCError({ code: 'BAD_REQUEST', message: e.message });
        }
        throw e;
      }

      const storedValue = { title: safe.title, ...(safe.body != null ? { body: safe.body } : {}) };
      const serialized = JSON.stringify(storedValue);
      const byteSize = Buffer.byteLength(serialized, 'utf8');
      if (byteSize > SHARED_VALUE_BYTE_CAP) {
        throw new TRPCError({ code: 'PAYLOAD_TOO_LARGE', message: 'value exceeds size cap' });
      }

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

      // Per-app byte + row quota (shared with the per-user kv path).
      const quota = (
        await pool.query<{ used_bytes: string; row_count: string }>(
          `SELECT used_bytes::text, row_count::text FROM ${schema}.quota WHERE app_block_id = $1`,
          [appBlockId]
        )
      ).rows[0];
      const usedBytes = Number(quota?.used_bytes ?? '0');
      const rowCount = Number(quota?.row_count ?? '0');
      if (usedBytes + byteSize > APP_QUOTA_BYTES) {
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

      return { key };
    }),

  /**
   * Up-vote a request. FK-checked (H2: a vote on a non-existent request rejects
   * NOT_FOUND) + visibility-checked (hidden rows can't be voted). The counter
   * increment is ATOMICALLY gated on the vote row actually inserting (H1: a double
   * vote is a no-op, the counter never inflates). Rate-limited per (user, app).
   */
  vote: publicProcedure
    .input(blockTokenInput.extend({ key: sharedKeyInput }))
    .mutation(async ({ input }) => {
      const { userId, schema, appBlockId } = await resolveSharedContext(input.blockToken, 'vote');
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
        await pool.query(
          `SELECT 1 FROM ${schema}.shared_kv WHERE key = $1 AND hidden_at IS NULL`,
          [input.key]
        )
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
            [input.key, uid]
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
    }),

  /**
   * Withdraw an up-vote. Symmetric to vote: the counter decrements by exactly the
   * number of vote rows deleted (0 or 1); the `CHECK(count >= 0)` constraint blocks
   * any underflow (H1). Rate-limited on the same per (user, app) vote bucket.
   */
  unvote: publicProcedure
    .input(blockTokenInput.extend({ key: sharedKeyInput }))
    .mutation(async ({ input }) => {
      const { userId, schema, appBlockId } = await resolveSharedContext(input.blockToken, 'unvote');
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
          [input.key, uid]
        )
      ).rows;
      return { count: Number(rows[0]?.count ?? '0') };
    }),

  /**
   * Author withdraws their OWN request (design LOCKED #4). Deletes the shared_kv
   * row ONLY when author_user_id = subject; the FK cascade drops its votes +
   * counter. SET LOCAL GUC so the quota trigger reclaims the bytes/row.
   */
  withdraw: publicProcedure
    .input(blockTokenInput.extend({ key: sharedKeyInput }))
    .mutation(async ({ input }) => {
      const { userId, schema, appBlockId } = await resolveSharedContext(
        input.blockToken,
        'withdraw'
      );
      const uid = userId as number;
      const pool = requireAppsDb();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL app.current_app_block_id = ${pgQuoteLiteral(appBlockId)}`);
        const result = await client.query(
          `DELETE FROM ${schema}.shared_kv WHERE key = $1 AND author_user_id = $2`,
          [input.key, uid]
        );
        await client.query('COMMIT');
        return { ok: true as const, deleted: (result.rowCount ?? 0) > 0 };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    }),

  /**
   * User report (design M5). Files a shared_kv_reports row for mod review. Requires
   * the write scope + trust gate (only eligible users can report, to bound report
   * spam). Does not hide the row — a moderator decides via `apps.mod.purgeSharedRow`.
   */
  report: publicProcedure
    .input(
      blockTokenInput.extend({ key: sharedKeyInput, reason: z.string().max(500).optional() })
    )
    .mutation(async ({ input }) => {
      const { userId, schema } = await resolveSharedContext(input.blockToken, 'report');
      const uid = userId as number;
      const pool = requireAppsDb();
      const exists = (
        await pool.query(`SELECT 1 FROM ${schema}.shared_kv WHERE key = $1`, [input.key])
      ).rowCount;
      if (!exists) throw new TRPCError({ code: 'NOT_FOUND', message: 'request not found' });
      await insertSharedReport(schema, {
        key: input.key,
        reporterUserId: uid,
        reason: input.reason ?? 'user-report',
      });
      return { ok: true as const };
    }),
});

/**
 * Cross-app moderator surface (design M4). SESSION-authed (moderatorProcedure) —
 * NOT reachable by a block token. Hides OR hard-deletes any (appBlockId, key)
 * shared row across ANY app, cascades its votes/counter (hard-delete), and files a
 * Report row. The app slug is derived server-side from the AppBlock row, never
 * from client input.
 */
export const appsModRouter = router({
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

function isForeignKeyViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err != null &&
    'code' in err &&
    (err as { code?: unknown }).code === '23503'
  );
}
