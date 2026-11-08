import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isPaidAccessActive, type ModelVersionTerms } from '@civitai/buzz';
import { prefixCacheKey } from '@civitai/redis';
import { EntityAccessPermission } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import {
  getModelVersionAccessPermissions,
  GIFT_PERMISSIONS_KEY,
  grantModelVersionAccess,
} from '~/server/services/model-version-access.service';
import { bustOrchestratorModelCache } from '~/server/services/orchestrator/models';
import { getPaidAccess } from '~/server/services/paid-access.service';
import {
  throwBadRequestError,
  throwNotFoundError,
  throwRateLimitError,
} from '~/server/utils/errorHandling';
import {
  GIFT_INDEX_PAGE_MAX,
  GIFT_LIVE_CODES_MAX_PER_VERSION,
  GIFT_LIST_HISTORY,
  GIFT_MINT_MAX_PER_CALL,
} from '~/server/services/model-version-gift.constants';
import { checkFixedWindow } from '~/server/utils/public-api-rate-limit';
import { ModelStatus } from '~/shared/utils/prisma/enums';

const GIFT_CLAIM_RATE_LIMIT = { max: 10, windowSeconds: 60 };
const GIFT_MINT_RATE_LIMIT = { max: 20, windowSeconds: 3600 };

export const GIFT_CODE_PREFIX = 'cvg_';
// Crockford base32: no I, L, O or U. 26 characters of 5 bits each is 130 bits of entropy.
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const GIFT_CODE_LENGTH = 26;
const INVALID_GIFT_MESSAGE = 'This gift is invalid, expired or no longer available.';

export function generateGiftCode() {
  // 32 divides 256, so masking a byte to 5 bits is unbiased.
  const bytes = randomBytes(GIFT_CODE_LENGTH);
  let body = '';
  for (const byte of bytes) body += CROCKFORD[byte & 31];
  return GIFT_CODE_PREFIX + body;
}

/** The canonical form of a typed or pasted code, or null when it cannot be one. */
export function normalizeGiftCode(input: string) {
  let body = input.trim().replace(/-/g, '').toUpperCase();
  if (body.startsWith(GIFT_CODE_PREFIX.toUpperCase())) body = body.slice(GIFT_CODE_PREFIX.length);
  body = body.replace(/[IL]/g, '1').replace(/O/g, '0');
  if (body.length !== GIFT_CODE_LENGTH) return null;
  for (const ch of body) if (!CROCKFORD.includes(ch)) return null;
  return GIFT_CODE_PREFIX + body;
}

export function hashGiftCode(normalizedCode: string) {
  return createHash('sha256').update(normalizedCode).digest('hex');
}

function newCodeRow(code: string) {
  return { codeHash: hashGiftCode(code), codeHint: code.slice(-4) };
}

async function assertRateLimit(
  name: string,
  userId: number,
  { max, windowSeconds }: { max: number; windowSeconds: number }
) {
  const result = await checkFixedWindow(
    prefixCacheKey(`model-gift:${name}:user:${userId}`),
    max,
    windowSeconds
  );
  if (!result.allowed) throw throwRateLimitError('Too many attempts. Please try again shortly.');
}

async function getGiftableVersion(modelVersionId: number) {
  const version = await dbRead.modelVersion.findUnique({
    where: { id: modelVersionId },
    select: {
      id: true,
      status: true,
      model: { select: { id: true, userId: true, status: true } },
    },
  });
  if (!version) throw throwNotFoundError('Model version not found.');
  const paidAccess = (await getPaidAccess('ModelVersion', [modelVersionId]))[modelVersionId];
  const gateActive = !!paidAccess && isPaidAccessActive(paidAccess);
  const terms = (paidAccess?.terms ?? {}) as ModelVersionTerms;
  const permissions = terms.download
    ? EntityAccessPermission.EarlyAccessGeneration + EntityAccessPermission.EarlyAccessDownload
    : EntityAccessPermission.EarlyAccessGeneration;
  return { version, gateActive, permissions };
}

/** Owner or moderator: listing and revoking. Minting goes through `assertOwnsVersion`. */
async function assertCanManageGifts({
  userId,
  isModerator,
  modelVersionId,
}: {
  userId: number;
  isModerator?: boolean;
  modelVersionId: number;
}) {
  const giftable = await getGiftableVersion(modelVersionId);
  if (giftable.version.model.userId !== userId && !isModerator)
    throw new TRPCError({ code: 'FORBIDDEN', message: 'You do not own this model version.' });
  return giftable;
}

/** Minting hands out free access to a paid version, so it is the owner's alone, never a moderator's. */
const assertOwnsVersion = (userId: number, modelVersionId: number) =>
  assertCanManageGifts({ userId, isModerator: false, modelVersionId });

// Namespaces the advisory lock so it never collides with another single-key lock on the same id.
const GIFT_MINT_LOCK_CLASS = 0x47490001;

/**
 * Runs `insert` only if it keeps the version within its live-code cap. The per-version lock makes
 * the count and the insert atomic: without it two mints each count under the cap and together pass it.
 */
export async function insertWithinLiveCap<T>(
  client: Pick<typeof dbWrite, '$transaction'>,
  modelVersionId: number,
  adding: number,
  insert: (tx: Prisma.TransactionClient) => Promise<T>
) {
  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${GIFT_MINT_LOCK_CLASS}::int, ${modelVersionId}::int)`;
    const [{ live }] = await tx.$queryRaw<{ live: number }[]>`
      SELECT count(*)::int AS live
        FROM "ModelVersionGiftLink"
       WHERE "modelVersionId" = ${modelVersionId}
         AND "revokedAt" IS NULL
         AND ("expiresAt" IS NULL OR "expiresAt" > now())
         AND ("maxRedemptions" IS NULL OR "redemptionCount" < "maxRedemptions")
    `;
    if (live + adding > GIFT_LIVE_CODES_MAX_PER_VERSION)
      throw throwBadRequestError(
        `A model version can have at most ${GIFT_LIVE_CODES_MAX_PER_VERSION} live gift codes.`
      );
    return insert(tx);
  });
}

function assertGated(gateActive: boolean) {
  if (!gateActive)
    throw throwBadRequestError('Gifts can only be created for a gated model version.');
}

export async function createGiftLink({
  userId,
  modelVersionId,
  maxRedemptions,
  expiresAt,
  label,
}: {
  userId: number;
  modelVersionId: number;
  maxRedemptions?: number | null;
  expiresAt?: Date | null;
  label?: string | null;
}) {
  await assertRateLimit('mint', userId, GIFT_MINT_RATE_LIMIT);
  const { gateActive } = await assertOwnsVersion(userId, modelVersionId);
  assertGated(gateActive);
  const code = generateGiftCode();
  const link = await insertWithinLiveCap(dbWrite, modelVersionId, 1, (tx) =>
    tx.modelVersionGiftLink.create({
      data: {
        modelVersionId,
        createdById: userId,
        ...newCodeRow(code),
        maxRedemptions: maxRedemptions ?? null,
        expiresAt: expiresAt ?? null,
        label: label ?? null,
      },
      select: { id: true },
    })
  );
  return { id: link.id, code };
}

export async function mintGiftCodes({
  userId,
  modelVersionId,
  count,
  expiresAt,
  label,
}: {
  userId: number;
  modelVersionId: number;
  count: number;
  expiresAt?: Date | null;
  label?: string | null;
}) {
  if (!Number.isInteger(count) || count < 1 || count > GIFT_MINT_MAX_PER_CALL)
    throw throwBadRequestError(`count must be between 1 and ${GIFT_MINT_MAX_PER_CALL}.`);
  await assertRateLimit('mint', userId, GIFT_MINT_RATE_LIMIT);
  const { gateActive } = await assertOwnsVersion(userId, modelVersionId);
  assertGated(gateActive);
  const batchId = randomUUID();
  const codes = Array.from({ length: count }, generateGiftCode);
  await insertWithinLiveCap(dbWrite, modelVersionId, count, (tx) =>
    tx.modelVersionGiftLink.createMany({
      data: codes.map((code) => ({
        modelVersionId,
        createdById: userId,
        ...newCodeRow(code),
        batchId,
        maxRedemptions: 1,
        expiresAt: expiresAt ?? null,
        label: label ?? null,
      })),
    })
  );
  return { batchId, codes };
}

export async function listGiftLinks({
  userId,
  isModerator,
  modelVersionId,
}: {
  userId: number;
  isModerator?: boolean;
  modelVersionId: number;
}) {
  await assertCanManageGifts({ userId, isModerator, modelVersionId });
  return queryGiftList(dbWrite, modelVersionId);
}

/** One bulk batch's summary columns, over its "ModelVersionGiftLink" rows grouped by "batchId". */
const batchSummarySql = Prisma.sql`
  min("label") AS "label",
  count(*)::int AS "total",
  count(*) FILTER (WHERE "redemptionCount" > 0)::int AS "claimed",
  count(*) FILTER (
    WHERE "revokedAt" IS NULL AND "redemptionCount" < "maxRedemptions"
      AND ("expiresAt" IS NULL OR "expiresAt" > now())
  )::int AS "live",
  min("createdAt") AS "createdAt",
  max("expiresAt") AS "expiresAt"
`;

export async function queryGiftList(
  client: Pick<typeof dbWrite, '$queryRaw'>,
  modelVersionId: number
) {
  // Bulk codes come back as one row per batch. Live rows sort first and are bounded by
  // GIFT_LIVE_CODES_MAX_PER_VERSION, so every one is listed (revoking needs its id), with room for at
  // least GIFT_LIST_HISTORY spent ones. The primary: Creator Studio re-reads right after a write.
  const [links, batches] = await Promise.all([
    client.$queryRaw<GiftLinkSummary[]>`
      SELECT * FROM (
        SELECT "id", "codeHint", "label", "maxRedemptions", "redemptionCount", "expiresAt",
               "revokedAt", "createdAt",
               ("revokedAt" IS NULL AND ("expiresAt" IS NULL OR "expiresAt" > now())
                 AND ("maxRedemptions" IS NULL OR "redemptionCount" < "maxRedemptions")) AS "live"
          FROM "ModelVersionGiftLink"
         WHERE "modelVersionId" = ${modelVersionId} AND "batchId" IS NULL
      ) l
      ORDER BY "live" DESC, "createdAt" DESC
      LIMIT ${GIFT_LIVE_CODES_MAX_PER_VERSION + GIFT_LIST_HISTORY}
    `,
    client.$queryRaw<GiftBatchSummary[]>`
      SELECT * FROM (
        SELECT "batchId", ${batchSummarySql}
          FROM "ModelVersionGiftLink"
         WHERE "modelVersionId" = ${modelVersionId} AND "batchId" IS NOT NULL
         GROUP BY "batchId"
      ) b
      ORDER BY ("live" > 0) DESC, "createdAt" DESC
      LIMIT ${GIFT_LIVE_CODES_MAX_PER_VERSION + GIFT_LIST_HISTORY}
    `,
  ]);
  return { links, batches };
}

export type GiftLinkSummary = {
  id: number;
  codeHint: string;
  label: string | null;
  maxRedemptions: number | null;
  redemptionCount: number;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  live: boolean;
};

export type GiftBatchSummary = {
  batchId: string;
  label: string | null;
  total: number;
  claimed: number;
  live: number;
  createdAt: Date;
  expiresAt: Date | null;
};

type GiftIndexVersion = {
  modelVersionId: number;
  versionName: string;
  modelId: number;
  modelName: string;
};
export type GiftIndexItem =
  | ({ kind: 'link' } & Omit<GiftLinkSummary, 'live'> & GiftIndexVersion)
  | ({ kind: 'batch' } & GiftBatchSummary & GiftIndexVersion);

type GiftIndexRow = GiftIndexVersion & {
  kind: 'link' | 'batch';
  key: string;
  createdAt: Date;
  expiresAt: Date | null;
  label: string | null;
  id: number | null;
  codeHint: string | null;
  maxRedemptions: number | null;
  redemptionCount: number | null;
  revokedAt: Date | null;
  total: number | null;
  claimed: number | null;
  live: number | null;
};

/** Opaque keyset cursor over (createdAt, key). */
export function encodeGiftIndexCursor(row: { createdAt: Date; key: string }) {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.key}`).toString('base64url');
}

export function decodeGiftIndexCursor(cursor: string) {
  const [at, key] = Buffer.from(cursor, 'base64url').toString().split('|');
  // Exactly what encodeGiftIndexCursor writes, and a real date: the timestamp cast refuses month 13.
  if (!at || !key || Number.isNaN(Date.parse(at)) || new Date(at).toISOString() !== at)
    throw throwBadRequestError('Invalid cursor.');
  return { createdAt: at, key };
}

/**
 * The owner's links and bulk batches across every version of every model they own, newest first.
 * A link's key is its id and a batch's its batchId, so the two never collide.
 */
export function giftIndexSql({
  userId,
  cursor,
  limit,
}: {
  userId: number;
  cursor: { createdAt: string; key: string } | null;
  limit: number;
}) {
  return Prisma.sql`
    WITH owned AS (
      SELECT mv.id, mv.name AS "versionName", m.id AS "modelId", m.name AS "modelName"
        FROM "ModelVersion" mv
        JOIN "Model" m ON m.id = mv."modelId"
       WHERE m."userId" = ${userId}
    ), items AS (
      SELECT 'link' AS kind, l.id::text AS key, l."modelVersionId", l."createdAt", l."expiresAt",
             l.label, l.id, l."codeHint", l."maxRedemptions", l."redemptionCount", l."revokedAt",
             NULL::int AS total, NULL::int AS claimed, NULL::int AS live
        FROM "ModelVersionGiftLink" l
       WHERE l."modelVersionId" IN (SELECT id FROM owned) AND l."batchId" IS NULL
      UNION ALL
      -- Aggregates every batch of the creator's on each page; past a few thousand batches, move the
      -- cursor and a LIMIT into each branch.
      SELECT 'batch', b."batchId", b."modelVersionId", b."createdAt", b."expiresAt", b.label,
             NULL, NULL, NULL, NULL, NULL, b.total, b.claimed, b.live
        FROM (
          SELECT "batchId", "modelVersionId", ${batchSummarySql}
            FROM "ModelVersionGiftLink"
           WHERE "modelVersionId" IN (SELECT id FROM owned) AND "batchId" IS NOT NULL
           GROUP BY "batchId", "modelVersionId"
        ) b
    )
    SELECT i.*, o."versionName", o."modelId", o."modelName"
      FROM items i
      JOIN owned o ON o.id = i."modelVersionId"
     ${
       cursor
         ? Prisma.sql`WHERE (i."createdAt", i.key) < (${cursor.createdAt}::timestamp(3), ${cursor.key})`
         : Prisma.empty
     }
     ORDER BY i."createdAt" DESC, i.key DESC
     LIMIT ${limit + 1}
  `;
}

/** Shapes one page of `giftIndexSql` rows: the extra row only says there is a next page. */
export function toGiftIndexPage(rows: GiftIndexRow[], limit: number) {
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const items: GiftIndexItem[] = page.map((r) => {
    const version = {
      modelVersionId: r.modelVersionId,
      versionName: r.versionName,
      modelId: r.modelId,
      modelName: r.modelName,
    };
    return r.kind === 'link'
      ? {
          kind: 'link',
          id: r.id as number,
          codeHint: r.codeHint as string,
          label: r.label,
          maxRedemptions: r.maxRedemptions,
          redemptionCount: r.redemptionCount as number,
          expiresAt: r.expiresAt,
          revokedAt: r.revokedAt,
          createdAt: r.createdAt,
          ...version,
        }
      : {
          kind: 'batch',
          batchId: r.key,
          label: r.label,
          total: r.total as number,
          claimed: r.claimed as number,
          live: r.live as number,
          createdAt: r.createdAt,
          expiresAt: r.expiresAt,
          ...version,
        };
  });
  return {
    items,
    nextCursor: rows.length > limit && last ? encodeGiftIndexCursor(last) : null,
  };
}

/** Every gift link and batch on the caller's own models. Owner only: moderators use the per-version list. */
export async function listMyGiftLinks({
  userId,
  cursor,
  limit = GIFT_INDEX_PAGE_MAX,
  fresh = false,
}: {
  userId: number;
  cursor?: string | null;
  limit?: number;
  /** Read the primary: the caller has just written (a revoke) and must see it. */
  fresh?: boolean;
}) {
  const take = Math.min(Math.max(1, Math.floor(limit)), GIFT_INDEX_PAGE_MAX);
  const decoded = cursor ? decodeGiftIndexCursor(cursor) : null;
  const rows = await (fresh ? dbWrite : dbRead).$queryRaw<GiftIndexRow[]>(
    giftIndexSql({ userId, cursor: decoded, limit: take })
  );
  return toGiftIndexPage(rows, take);
}

/** Revokes one link, or every link of a bulk batch. Already-granted access is kept. */
export async function revokeGiftLinks({
  userId,
  isModerator,
  modelVersionId,
  id,
  batchId,
}: {
  userId: number;
  isModerator?: boolean;
  modelVersionId: number;
  id?: number;
  batchId?: string;
}) {
  if ((id == null) === (batchId == null))
    throw throwBadRequestError('Pass exactly one of id or batchId.');
  await assertCanManageGifts({ userId, isModerator, modelVersionId });
  const { count } = await dbWrite.modelVersionGiftLink.updateMany({
    where: {
      modelVersionId,
      ...(id != null ? { id } : { batchId }),
      revokedAt: null,
    },
    data: { revokedAt: new Date(), revokedById: userId },
  });
  if (count === 0) throw throwNotFoundError('No active gift link to revoke.');
  return { revoked: count };
}

export type GiftRedemptionOutcome = 'granted' | 'unavailable';

/**
 * The atomic part of a claim, in one transaction: record the redemption, take a slot under the cap,
 * grant. The cap holds under concurrency because the conditional UPDATE re-checks its WHERE against
 * the row it locks, so racing claims on the last slot serialise and the loser updates 0 rows.
 */
export async function redeemGiftLink(
  client: Pick<typeof dbWrite, '$transaction'>,
  {
    giftLinkId,
    userId,
    modelVersionId,
    permissions,
    addedById,
  }: {
    giftLinkId: number;
    userId: number;
    modelVersionId: number;
    permissions: number;
    addedById: number;
  }
): Promise<GiftRedemptionOutcome> {
  try {
    return await client.$transaction(async (tx) => {
      const inserted = await tx.$executeRaw`
        INSERT INTO "ModelVersionGiftRedemption" ("giftLinkId", "userId")
        VALUES (${giftLinkId}, ${userId})
        ON CONFLICT DO NOTHING
      `;
      // A repeat claim takes no new slot. It re-grants while the link is live, because the first grant
      // can be gone (the early-access refund deletes the whole EntityAccess row).
      const taken =
        inserted === 0
          ? (
              await tx.$queryRaw<unknown[]>`
                SELECT 1 FROM "ModelVersionGiftLink"
                 WHERE id = ${giftLinkId}
                   AND "revokedAt" IS NULL
                   AND ("expiresAt" IS NULL OR "expiresAt" > now())
                 FOR SHARE
              `
            ).length
          : await tx.$executeRaw`
              UPDATE "ModelVersionGiftLink"
                 SET "redemptionCount" = "redemptionCount" + 1
               WHERE id = ${giftLinkId}
                 AND "revokedAt" IS NULL
                 AND ("expiresAt" IS NULL OR "expiresAt" > now())
                 AND ("maxRedemptions" IS NULL OR "redemptionCount" < "maxRedemptions")
            `;
      if (taken === 0) throw new GiftUnavailable();

      await grantModelVersionAccess({
        client: tx,
        userId,
        modelVersionId,
        permissions,
        meta: { giftLinkId, [GIFT_PERMISSIONS_KEY]: permissions },
        addedById,
      });
      return 'granted' as const;
    });
  } catch (error) {
    if (error instanceof GiftUnavailable) return 'unavailable';
    throw error;
  }
}

class GiftUnavailable extends Error {}

export async function claimGift({ userId, code }: { userId: number; code: string }) {
  // Before the lookup, so failed guesses count against the limit too.
  await assertRateLimit('claim', userId, GIFT_CLAIM_RATE_LIMIT);

  const normalized = normalizeGiftCode(code);
  if (!normalized) throw throwBadRequestError(INVALID_GIFT_MESSAGE);
  const link = await dbWrite.modelVersionGiftLink.findUnique({
    where: { codeHash: hashGiftCode(normalized) },
    select: { id: true, modelVersionId: true, createdById: true, revokedAt: true, expiresAt: true },
  });
  if (!link || link.revokedAt || (link.expiresAt && link.expiresAt <= new Date()))
    throw throwBadRequestError(INVALID_GIFT_MESSAGE);

  const { version, gateActive, permissions } = await getGiftableVersion(link.modelVersionId);
  const result = { modelVersionId: version.id, modelId: version.model.id };
  // A transfer moves the sales to the new owner; the old owner's live codes must not keep giving it away.
  if (link.createdById !== version.model.userId) throw throwBadRequestError(INVALID_GIFT_MESSAGE);
  if (version.model.userId === userId)
    throw throwBadRequestError('You cannot claim a gift for your own model.');
  if (version.status !== ModelStatus.Published || version.model.status !== ModelStatus.Published)
    throw throwBadRequestError('Gifts can only be claimed for published models.');

  // A slot is never spent on someone who gains nothing: the gate has ended, or they hold it already.
  if (!gateActive) return { ...result, alreadyHadAccess: true };
  const held = await getModelVersionAccessPermissions(userId, version.id);
  if ((held & permissions) === permissions) return { ...result, alreadyHadAccess: true };

  const outcome = await redeemGiftLink(dbWrite, {
    giftLinkId: link.id,
    userId,
    modelVersionId: version.id,
    permissions,
    // The claimer, as purchases record the buyer: the personal-data export keys EntityAccess on
    // addedById, so the creator here would put every recipient in the creator's export.
    addedById: userId,
  });
  if (outcome === 'unavailable') throw throwBadRequestError(INVALID_GIFT_MESSAGE);

  // Not bustMvCache: its caches are per version, and an uncapped link would refresh them per claim.
  await bustOrchestratorModelCache(version.id, userId);
  return { ...result, alreadyHadAccess: false };
}

export type ClaimGiftResult = Awaited<ReturnType<typeof claimGift>>;
