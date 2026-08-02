import type { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { netNewStickerPlacements } from '~/shared/utils/sticker-token';

/**
 * Where a sticker was placed. Required, never inferred: DMs are free and
 * unlimited, so a caller that forgot to say where it was would silently get the
 * free path.
 */
export type StickerSurface = 'chat' | 'comment';

/** Surfaces that spend a use. DMs are deliberately free (§4b.3). */
const CONSUMES: Record<StickerSurface, boolean> = { chat: false, comment: true };

/**
 * Spends one use per placement, atomically and all-or-nothing.
 *
 * The balance check and the decrement are the same statement — a read-then-write
 * would let two concurrent submissions both pass a check against the same
 * balance. Zero rows updated means insufficient (or not owned), and the whole
 * transaction rolls back, so a submission is never partially charged.
 */
export async function spendStickerUses({
  userId,
  surface,
  content,
  previousContent,
}: {
  userId: number;
  surface: StickerSurface;
  content: string;
  previousContent?: string;
}) {
  if (!CONSUMES[surface]) return;

  const delta = netNewStickerPlacements(content, previousContent ?? '');
  if (!delta.size) return;

  await dbWrite.$transaction(async (tx) => {
    for (const [cosmeticId, count] of delta) {
      // Picks the holding with the most headroom (unlimited first). A user can
      // hold several rows for one cosmetic — the PK is
      // [userId, cosmeticId, claimKey] — so this can't assume a single row.
      const updated = await tx.$queryRaw<{ remaining: number | null }[]>`
        WITH target AS (
          SELECT "userId", "cosmeticId", "claimKey"
          FROM "UserCosmetic"
          WHERE "userId" = ${userId}
            AND "cosmeticId" = ${cosmeticId}
            AND ("remaining" IS NULL OR "remaining" >= ${count})
          ORDER BY ("remaining" IS NULL) DESC, "remaining" DESC
          LIMIT 1
        )
        UPDATE "UserCosmetic" uc
        SET "remaining" = CASE
          WHEN uc."remaining" IS NULL THEN NULL
          ELSE uc."remaining" - ${count}
        END
        FROM target t
        WHERE uc."userId" = t."userId"
          AND uc."cosmeticId" = t."cosmeticId"
          AND uc."claimKey" = t."claimKey"
        RETURNING uc."remaining"
      `;

      if (!updated.length)
        throw throwBadRequestError(
          "You don't have enough uses left on one of these stickers. Remove it or buy more."
        );
    }
  });
}

/** Remaining balance per owned sticker; NULL entries are unlimited. */
export async function getStickerBalances(userId: number) {
  const rows = await dbWrite.$queryRaw<{ cosmeticId: number; remaining: number | null }[]>`
    SELECT uc."cosmeticId", MAX(uc."remaining") AS "remaining"
    FROM "UserCosmetic" uc
    JOIN "Cosmetic" c ON c.id = uc."cosmeticId"
    WHERE uc."userId" = ${userId} AND c.type = 'Sticker'::"CosmeticType"
    GROUP BY uc."cosmeticId"
  `;

  // A NULL anywhere for a cosmetic means unlimited, and MAX ignores NULLs — so
  // re-check for an unlimited holding rather than trusting the aggregate.
  const unlimited = await dbWrite.$queryRaw<{ cosmeticId: number }[]>`
    SELECT DISTINCT "cosmeticId" FROM "UserCosmetic"
    WHERE "userId" = ${userId} AND "remaining" IS NULL
  `;
  const unlimitedIds = new Set(unlimited.map((r) => r.cosmeticId));

  return new Map(
    rows.map((r) => [r.cosmeticId, unlimitedIds.has(r.cosmeticId) ? null : r.remaining])
  );
}

export const stickerUsesFromCosmeticData = (data: Prisma.JsonValue | null | undefined) => {
  const uses = (data as { uses?: unknown } | null | undefined)?.uses;
  return typeof uses === 'number' && Number.isFinite(uses) && uses > 0 ? Math.floor(uses) : null;
};
