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
// Per individual shared value (the whole jsonb: the moderated title+body PLUS the
// optional opaque app-owned `data` blob). Raised from 8KB → 64KB so apps can store
// real structured state in `data`; still tightly bounded and enforced BEFORE the DB
// write, and the bytes count toward the per-app `size_bytes`/quota + row caps below.
const SHARED_VALUE_BYTE_CAP = 64 * 1024;
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

type SharedOp =
  | 'list'
  | 'getCount'
  | 'append'
  | 'vote'
  | 'unvote'
  | 'withdraw'
  | 'report'
  // App Blocks play-counts (block REST endpoints /api/v1/blocks/shared-storage/*):
  //   - 'increment' is a WRITE (min-trust gated like append/vote — anti-inflation)
  //   - 'getTop' is a READ (anon-allowed like list/getCount)
  | 'increment'
  | 'getTop';
const READ_OPS: ReadonlySet<SharedOp> = new Set<SharedOp>(['list', 'getCount', 'getTop']);

const SHARED_READ_SCOPE = 'apps:storage:shared:read';
const SHARED_WRITE_SCOPE = 'apps:storage:shared:write';

/**
 * The min-trust gate (design H3). Reuses EXISTING civitai trust signals hydrated
 * from `SessionUser` — no new trust score. FAIL-CLOSED: a vanished subject (null),
 * banned, muted, onboarding-incomplete, unverified-AND-no-OAuth, or too-new account
 * is DENIED. `asserts` narrows `user` to non-null for the caller.
 *
 * "Verified email" is satisfied by `emailVerified` OR a linked OAuth account
 * (`hasLinkedOAuth`, a row in the `Account` table). Rationale: civitai's
 * `emailVerified` is only ever set by the email-CHANGE flow — OAuth sign-in
 * (GitHub/Google/Discord, ~69% of active users) never sets it, so the raw check
 * locked out most legitimate users. A linked OAuth account is a provider-verified
 * identity and a STRONGER anti-sybil signal than an unverified civitai email
 * (minting N GitHub/Google accounts is harder than N unverified civitai accounts).
 * A user with NEITHER a verified email NOR an OAuth link genuinely still needs to
 * verify, so that case keeps the original deny.
 *
 * Signals (all AND-ed):
 *   sub!=anon (caller passes non-null) · !bannedAt · !muted ·
 *   onboarding-complete (Flags.hasFlag(onboarding, Buzz)) ·
 *   (emailVerified present OR hasLinkedOAuth) ·
 *   account age ≥ MIN_ACCOUNT_AGE_MS · [optional] paid tier.
 */
export function assertSharedWriteTrust(
  user: SessionUser | null,
  hasLinkedOAuth: boolean
): asserts user is SessionUser {
  const deny = (message: string): never => {
    throw new TRPCError({ code: 'FORBIDDEN', message });
  };
  if (!user) return deny('Your account is not eligible for this action');
  if (user.bannedAt) return deny('Your account is not eligible for this action');
  if (user.muted) return deny('Your account has been restricted');
  if (!Flags.hasFlag(user.onboarding ?? 0, OnboardingSteps.Buzz)) {
    return deny('Complete onboarding before contributing');
  }
  if (!user.emailVerified && !hasLinkedOAuth) {
    return deny('Verify your email before contributing');
  }
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
export async function resolveSharedContext(blockToken: string, op: SharedOp): Promise<SharedContext> {
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
    // "Verified email" is satisfied by emailVerified OR a linked OAuth account.
    // Only query when emailVerified is absent (the common OAuth case) — a
    // verified-email user short-circuits with NO extra query per write op. The
    // query keys on the SUBJECT `userId` (parsed from the verified block token),
    // never client-forgeable input.
    let hasLinkedOAuth = false;
    if (subjectUser && !subjectUser.emailVerified) {
      hasLinkedOAuth = (await dbRead.account.count({ where: { userId } })) > 0;
    }
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
const sharedKeyInput = z.string().min(1).max(64);

// Structured append payload (design M3: title ≤200, body ≤ few KB).
//
// `title`/`body` are the MODERATED, user-visible TEXT — they run the full
// content-safety belt (assertSharedTextSafe) synchronously on every append.
//
// `data` is an OPTIONAL, opaque, app-owned, UNMODERATED structured payload stored
// alongside the moderated text. It is NOT run through the content-safety belt: it
// is opaque app-structured state (e.g. an app's own saved-config JSON), rendered
// ONLY inside the app's opaque-origin iframe sandbox — the SAME trust boundary as
// the rest of shared storage (all approved apps are `unverified` tier → no
// `allow-same-origin`, so even hostile bytes in `data` run in an origin that can't
// touch civitai). 🔴 Apps MUST place all user-VISIBLE TEXT in `title`/`body`
// (which is moderated); `data` must carry ONLY opaque app structure, never a text
// surface shown to other users outside the sandbox. Size is bounded by the whole-
// value SHARED_VALUE_BYTE_CAP (below) and its bytes count toward the app quota.
const appendValueInput = z.object({
  title: z.string().min(1).max(SHARED_TITLE_MAX),
  body: z.string().max(SHARED_BODY_MAX).optional(),
  data: z.unknown().optional(),
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

      // BLOCKING content safety → RAW, store-ready text (Fix 2: escape-at-rest
      // removed; XSS is contained at the text-render + opaque-origin-sandbox layers,
      // never at rest — see shared-content-safety.ts C2 note).
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
          // FIX 1 (pre-GA gate 1 — make abuse OBSERVABLE): the `shared_kv_reports`
          // table has no reader yet, so a moderation-blocked append would otherwise
          // be silent. Emit a structured, alertable event (METADATA ONLY — NEVER the
          // content text) so any auto-blocked write is observable before the
          // mod-queue wiring lands. `link`/`size` stay unalerted (user error, not
          // reportable abuse). Fire-and-forget (`.catch`) — an alert emit must NEVER
          // block or fail the op.
          //
          // TWO DISTINCT signals (kept separate so the legal-urgency channel is not
          // diluted): minor/POI are a HARD legal escalation (CSAM/minor) → the
          // `…-legal-block` / `type:error` event; a general `audit` block (harassment
          // / spam that trips external moderation) → the lower-urgency
          // `…-content-block` / `type:warning` event. Same metadata-only shape.
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
          } else if (e.category === 'audit') {
            logToAxiom(
              {
                name: 'app-blocks-shared-storage-content-block',
                type: 'warning',
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

      // `safe.title`/`safe.body` are the MODERATED text; `input.value.data` is the
      // opaque app-owned payload stored VERBATIM and UNMODERATED (see the
      // appendValueInput note — belt runs on title/body only). Its bytes are folded
      // into the serialized value below, so the whole-value cap + the app quota
      // bound it exactly like the text.
      const storedValue = {
        title: safe.title,
        ...(safe.body != null ? { body: safe.body } : {}),
        ...(input.value.data !== undefined ? { data: input.value.data } : {}),
      };
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
      const { userId, slug, schema, appBlockId } = await resolveSharedContext(
        input.blockToken,
        'report'
      );
      const uid = userId as number;
      const pool = requireAppsDb();
      const exists = (
        await pool.query(`SELECT 1 FROM ${schema}.shared_kv WHERE key = $1`, [input.key])
      ).rowCount;
      if (!exists) throw new TRPCError({ code: 'NOT_FOUND', message: 'request not found' });
      const reason = input.reason ?? 'user-report';
      await insertSharedReport(schema, {
        key: input.key,
        reporterUserId: uid,
        reason,
      });

      // FIX 1 (pre-GA gate 1 — make abuse OBSERVABLE): a user report previously
      // filed a `shared_kv_reports` row that NOTHING reads, so ordinary abuse
      // (harassment / brigading / spam that dodged the auto-audit) was invisible.
      // Emit a structured, alertable event mirroring the auto-block emit above —
      // METADATA ONLY (userId / slug / appBlockId / reason / reported key), NEVER the
      // reported content itself. Fire-and-forget (`.catch`) so a logging outage can
      // never fail a legitimate report.
      logToAxiom(
        {
          name: 'app-blocks-shared-storage-report',
          type: 'warning',
          userId: uid,
          slug,
          appBlockId,
          reason,
          key: input.key,
        },
        'block-audit'
      ).catch(() => {});
      // Also fire the mod-Discord notify if the webhook is wired (same pattern as
      // the W1 publish-request flow). Self-contained + fire-and-forget: never awaited
      // in a way that can block/fail the report, and swallows its own errors.
      void notifyModsOfSharedReport({
        slug,
        appBlockId,
        reportedKey: input.key,
        reporterUserId: uid,
        reason,
      });

      return { ok: true as const };
    }),
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
 * vote bucket as the shared vote path. Returns the new count.
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
  const { userId, schema, appBlockId } = await resolveSharedContext(blockToken, 'increment');
  const uid = userId as number; // non-null (write path ran the trust gate)

  const rl = await checkSharedVoteRateLimit(uid, appBlockId);
  if (!rl.allowed) {
    throw new TRPCError({
      code: 'TOO_MANY_REQUESTS',
      message: `Too many increments — retry in ${rl.retryAfterSeconds}s`,
    });
  }

  const pool = requireAppsDb();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // GUC drives the shared_kv quota trigger (byte/row accounting on the anchor).
    await client.query(`SET LOCAL app.current_app_block_id = ${pgQuoteLiteral(appBlockId)}`);
    // Anchor row so the counters FK holds. INSERT-or-ignore: created once per key.
    await client.query(
      `INSERT INTO ${schema}.shared_kv (key, author_user_id, value)
       VALUES ($1, $2, '{}'::jsonb)
       ON CONFLICT (key) DO NOTHING`,
      [key, uid]
    );
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
    return { key, count: Number(rows[0]?.count ?? '0') };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
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

/**
 * Neutralize Discord markdown in reporter-supplied free text before it is embedded
 * in a mod-alerts message. A hostile reporter must NOT be able to plant a masked
 * link `[label](https://phish.example)` (phishing) or other markdown/formatting in
 * the mod channel. We strip the structural markdown characters — masked-link
 * brackets/parens `[ ] ( )`, backticks, and emphasis/strike/spoiler/quote markers
 * `* _ ~ | >` — then collapse whitespace. The caller ALSO wraps the result in an
 * inline code span (belt-and-suspenders: no markdown, no URL auto-link, and no
 * mention ping renders inside a code span). Returns a bounded, single-line string.
 * NOTE: the Axiom copy of `reason` is deliberately left RAW — it is a structured
 * log field, never rendered, so escaping there would only corrupt the record.
 */
export function sanitizeDiscordText(input: string): string {
  return input
    .replace(/[`[\]()*_~|>]/g, ' ') // drop markdown / masked-link structural chars
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

/**
 * FIX 1 — fire-and-forget mod-Discord notify on a USER report of a shared row.
 * Mirrors the W1 publish-request `notifyModsOfNewRequest` pattern: posts to
 * `DISCORD_WEBHOOK_MOD_ALERTS` if it is set, otherwise a no-op. NEVER throws (a
 * Discord outage must not affect the report), and the caller does not await it —
 * so the report op returns immediately. Carries METADATA ONLY: slug / app-block /
 * reported key / reporter id + the reporter's stated reason (bounded to 500 chars
 * by the input schema). It does NOT — and cannot — include the reported content
 * (the op only holds the row key).
 */
async function notifyModsOfSharedReport(opts: {
  slug: string;
  appBlockId: string;
  reportedKey: string;
  reporterUserId: number;
  reason: string;
}): Promise<void> {
  try {
    const { env } = await import('~/env/server');
    if (!env.DISCORD_WEBHOOK_MOD_ALERTS) return;
    const baseUrl = (process.env.NEXTAUTH_URL ?? '').replace(/\/$/, '');
    const appUrl = baseUrl ? `${baseUrl}/${opts.slug}` : opts.slug;
    const payload = {
      embeds: [
        {
          title: `Shared-storage report: ${opts.slug}`,
          url: appUrl,
          color: 0xe03131,
          fields: [
            { name: 'App block', value: `\`${opts.appBlockId}\``, inline: true },
            { name: 'Reported by', value: `user #${opts.reporterUserId}`, inline: true },
            { name: 'Row key', value: `\`${opts.reportedKey}\`` },
            // Reporter free text: markdown-neutralized + code-span-wrapped so a
            // hostile reason can't plant a masked/phishing link in the mod channel
            // (the other fields are already backtick-wrapped).
            { name: 'Reason', value: `\`${sanitizeDiscordText(opts.reason) || 'user-report'}\`` },
          ],
          footer: { text: 'App Blocks shared storage' },
          timestamp: new Date().toISOString(),
        },
      ],
    };
    await fetch(env.DISCORD_WEBHOOK_MOD_ALERTS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5_000),
    }).catch(() => {
      /* fire and forget */
    });
  } catch {
    /* never let Discord break a report */
  }
}

function isForeignKeyViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err != null &&
    'code' in err &&
    (err as { code?: unknown }).code === '23503'
  );
}
