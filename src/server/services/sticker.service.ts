import type { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { isPreview, isProd } from '~/env/other';
import { logToAxiom } from '~/server/logging/client';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import type { StickerSurface } from '~/shared/utils/sticker-token';
import { netNewStickerPlacements, STICKER_SURFACES } from '~/shared/utils/sticker-token';

/**
 * Where a sticker was placed. Required, never inferred: DMs are free and
 * unlimited, so a caller that forgot to say where it was would silently get the
 * free path.
 */
/**
 * Where a sticker was placed. Required, never inferred: DMs are free and
 * unlimited, so a caller that forgot to say where it was would silently get the
 * free path. Per-surface behaviour lives in STICKER_SURFACES.
 */
export type { StickerSurface };

/**
 * Spends one use per placement, all-or-nothing.
 *
 * Holdings are locked `FOR UPDATE` before the balance is read, so two concurrent
 * submissions serialize rather than both passing a check against the same
 * balance. If the total across every holding can't cover the placements, nothing
 * is written.
 *
 * Pass the caller's `tx` whenever the spend accompanies a write. Committing
 * separately would debit uses and then lose the comment to any failure in
 * between; sharing the transaction makes the charge and the content atomic.
 */
export async function spendStickerUses({
  userId,
  surface,
  content,
  previousContent,
  tx,
}: {
  userId: number;
  surface: StickerSurface;
  content: string;
  previousContent?: string;
  tx?: Prisma.TransactionClient;
}) {
  if (!STICKER_SURFACES[surface].consumes) return new Map<number, number>();

  const delta = netNewStickerPlacements(
    content,
    previousContent ?? '',
    STICKER_SURFACES[surface].form
  );
  if (!delta.size) return delta;

  const spend = async (tx: Prisma.TransactionClient) => {
    // Sorted so concurrent submissions lock holdings in the same order. Looping
    // in content order lets two submissions sharing two stickers each take one
    // lock and wait on the other, which Postgres resolves by aborting one.
    for (const [cosmeticId, count] of [...delta].sort((a, b) => a[0] - b[0])) {
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
  };

  if (tx) await spend(tx);
  else await dbWrite.$transaction(spend);

  return delta;
}

/**
 * Append-only usage history. One row per placement, emitted only after the spend
 * has committed — a usage row for a charge that failed is worse than a missing
 * one. `charged` comes straight from `spendStickerUses`, so STICKER_SURFACES
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

  // Preview deploys share CLICKHOUSE_TRACKER_URL with production but run against
  // the DEV database, so their `entityId`s are ids from a different database —
  // they'd land in the prod table pointing at unrelated comments, with no column
  // to tell them apart afterwards. Skipping the emit is deliberate: consumption
  // still happens, so stickers are fully testable in preview; only the history
  // is withheld. `isProd` alone is not enough — a preview IS NODE_ENV=production.
  if (!isProd || isPreview) return;

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
  // SUM, not MAX: spending drains across holdings, so the spendable balance is
  // the total. A NULL holding is unlimited and wins outright — bool_or gives
  // that in the same pass rather than a second query.
  const rows = await dbRead.$queryRaw<
    { cosmeticId: number; remaining: number | null; unlimited: boolean }[]
  >`
    SELECT
      uc."cosmeticId",
      SUM(uc."remaining")::int AS "remaining",
      bool_or(uc."remaining" IS NULL) AS "unlimited"
    FROM "UserCosmetic" uc
    JOIN "Cosmetic" c ON c.id = uc."cosmeticId"
    WHERE uc."userId" = ${userId} AND c.type = 'Sticker'::"CosmeticType"
    GROUP BY uc."cosmeticId"
  `;

  return rows.map(({ cosmeticId, remaining, unlimited }) => ({
    cosmeticId,
    // null = unlimited, which is every non-consumable holding.
    remaining: unlimited ? null : remaining ?? 0,
  }));
}
