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
import { dbRead } from '~/server/db/client';
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

/**
 * App Blocks authoring gate: storage procedures are `publicProcedure` +
 * block-token authed — the viewer is resolved from the JWT subject, not
 * `ctx.user`. Re-assert the resolved viewer is an app AUTHOR here (mod OR the
 * app-dev-testers cohort, via the appBlocksAuthor capability) — defense-in-depth
 * per call (mint is also author-gated). Mirrors blocks.router's
 * assertViewerIsAppDeveloper so a KV-using block works for the whole author
 * loop. Fail-closed: an unhydratable subject → undefined → mod-floor misses +
 * Flipt eval can't match → FORBIDDEN. Throws FORBIDDEN otherwise.
 */
async function assertViewerIsAppDeveloper(userId: number): Promise<void> {
  const user = (await sessionClient.getSessionUserById(userId)) as SessionUser | null;
  if (!(await isAppBlocksAuthorEnabled({ user: user ?? undefined }))) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Apps authoring is not enabled for this account',
    });
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
  appBlockId: string;
  blockInstanceId: string;
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
  // at the point of use. Reads need apps:storage:read; mutations need
  // apps:storage:write. (Previously resolveStorageContext never inspected
  // claims.scopes, so a block approved for e.g. only models:read:self could
  // still read/write 50MB of per-user KV it never disclosed.)
  const requiredScope: string = op === 'set' || op === 'delete'
    ? 'apps:storage:write'
    : 'apps:storage:read';
  if (!Array.isArray(claims.scopes) || !claims.scopes.includes(requiredScope)) {
    appStorageOpsCounter.inc({ op, outcome: 'unauthorized' });
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: `storage ${op} requires the ${requiredScope} scope`,
    });
  }

  const userId = parseSubjectUserId(claims.sub);
  // Phase 2: moderator-only until GA. A non-null subject must be a moderator;
  // anon subjects (userId === null) fall through to each op's existing
  // anon-handling (clean-null for reads, UNAUTHORIZED for writes) — block-token
  // minting is itself mod-gated so an anon mod token can't be minted anyway.
  if (userId != null) {
    await assertViewerIsAppDeveloper(userId);
  }
  return {
    userId,
    slug,
    appBlockId: block.id,
    blockInstanceId: claims.blockInstanceId,
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
        const { userId, slug, blockInstanceId } = await resolveStorageContext(
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
            `SELECT value FROM ${appSchemaIdent(slug)}.kv
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
      const { userId, slug, appBlockId, blockInstanceId } = await resolveStorageContext(
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
      const schema = appSchemaIdent(slug);

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
      // for ops/debug visibility; this row populates /apps/installed.
      void (async () => {
        const { recordScopeInvocation } = await import(
          '~/server/services/blocks/user-app-surface.service'
        );
        await recordScopeInvocation({
          userId,
          appBlockId,
          blockInstanceId,
          scope: 'apps:storage',
          endpoint: `storage:set:${input.key}`,
          statusCode: 200,
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
        const { userId, slug, appBlockId, blockInstanceId } = await resolveStorageContext(
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
        const schema = appSchemaIdent(slug);
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
                endpoint: `storage:delete:${input.key}`,
                statusCode: 200,
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
        const { userId, slug, blockInstanceId } = await resolveStorageContext(
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
            `SELECT key, updated_at FROM ${appSchemaIdent(slug)}.kv
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
        const { slug, appBlockId } = await resolveStorageContext(input.blockToken, 'getQuota');
        const quota = await AppStorageProvisioner.getQuota({ slug, appBlockId });
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
});

// Postgres literal quoting — used ONLY for the regex-validated appBlockId
// in the SET LOCAL GUC where $1 placeholders are not accepted. The
// AppBlock.id format is `apb_<26 ULID chars>`; quote-doubling is
// belt-and-suspenders since the AppBlock PK is server-issued.
function pgQuoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
