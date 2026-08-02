import type { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
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
  if (!CONSUMES[surface]) return new Map<number, number>();

  const delta = netNewStickerPlacements(content, previousContent ?? '');
  if (!delta.size) return delta;

  await dbWrite.$transaction(async (tx) => {
    for (const [cosmeticId, count] of delta) {
      // A user can hold several rows for one cosmetic — the PK is
      // [userId, cosmeticId, claimKey], so a purchase and a grant coexist.
      // FOR UPDATE serializes concurrent submissions against these rows, which
      // is what keeps the read-then-drain below safe.
      const holdings = await tx.$queryRaw<{ claimKey: string; remaining: number | null }[]>`
        SELECT "claimKey", "remaining"
        FROM "UserCosmetic"
        WHERE "userId" = ${userId} AND "cosmeticId" = ${cosmeticId}
        ORDER BY ("remaining" IS NULL) DESC, "remaining" DESC
        FOR UPDATE
      `;

      // An unlimited holding is inexhaustible, so nothing is spent.
      if (holdings.some((h) => h.remaining === null)) continue;

      const available = holdings.reduce((sum, h) => sum + (h.remaining ?? 0), 0);
      if (available < count)
        throw throwBadRequestError(
          "You don't have enough uses left on one of these stickers. Remove it or buy more."
        );

      // Drain across holdings rather than requiring one row to cover the whole
      // amount: "I own 4 uses and can't spend 3" is an incomprehensible failure,
      // and it gets likelier exactly as balances run low.
      let owed = count;
      for (const holding of holdings) {
        if (owed <= 0) break;
        const take = Math.min(holding.remaining ?? 0, owed);
        if (take <= 0) continue;
        await tx.$executeRaw`
          UPDATE "UserCosmetic"
          SET "remaining" = "remaining" - ${take}
          WHERE "userId" = ${userId}
            AND "cosmeticId" = ${cosmeticId}
            AND "claimKey" = ${holding.claimKey}
        `;
        owed -= take;
      }
    }
  });

  return delta;
}

/**
 * Append-only usage history. One row per placement, emitted only after the spend
 * has committed — a usage row for a charge that failed is worse than a missing
 * one. `charged` comes straight from `spendStickerUses`, so the CONSUMES map
 * stays the single source of truth for which surfaces record.
 *
 * Fire-and-forget: the authoritative balance is in Postgres, so a failed write
 * here must never fail the user's submission.
 */
export function recordStickerUsage({
  track,
  userId,
  charged,
  entityType,
  entityId,
}: {
  track?: { stickerUsage: (rows: StickerUsageRow[]) => Promise<unknown> };
  userId: number;
  charged: Map<number, number>;
  entityType: string;
  entityId: number;
}) {
  if (!track || !charged.size) return;

  const rows: StickerUsageRow[] = [];
  for (const [cosmeticId, count] of charged)
    for (let i = 0; i < count; i++) rows.push({ userId, cosmeticId, entityType, entityId });

  void track.stickerUsage(rows).catch((error) =>
    logToAxiom(
      {
        type: 'error',
        name: 'sticker-usage-track-failed',
        userId,
        entityType,
        entityId,
        error: error instanceof Error ? error.message : String(error),
      },
      'civitai-prod'
    ).catch(() => undefined)
  );
}

export type StickerUsageRow = {
  userId: number;
  cosmeticId: number;
  entityType: string;
  entityId: number;
};

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
