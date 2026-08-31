import { dbRead } from '~/server/db/client';
import { tosReacceptanceOffer } from '~/server/common/tos-reacceptance';

/**
 * Does this muted account get offered the Terms instead of a bare refusal?
 *
 * Its own module rather than a function on `strike.service`: the tRPC mute guard is the caller, and
 * `trpc.ts` is imported by every router — pulling the strike service in would drag its email templates,
 * notification service and static-content reader into the root of the API graph.
 *
 * One query, on a request that is already being refused. The session carries `muted` and `mutedAt` but
 * neither the mute's reason nor the point total, and both are needed: the reason keeps the offer off
 * the scam auto-mute, and the total keeps it off the review tier.
 */
export async function shouldOfferTosReacceptance(userId: number): Promise<boolean> {
  const [row] = await dbRead.$queryRaw<
    [{ muted: boolean; mutedAt: Date | null; muteReason: string | null; points: number }]
  >`
    SELECT
      u."muted",
      u."mutedAt",
      u."meta"->>'muteReason' AS "muteReason",
      COALESCE((
        SELECT SUM(s."points")
        FROM "UserStrike" s
        WHERE s."userId" = u."id"
          AND s."status" = 'Active'
          AND s."expiresAt" > NOW()
      ), 0)::int AS points
    FROM "User" u
    WHERE u."id" = ${userId}
  `;
  if (!row) return false;

  return tosReacceptanceOffer({
    muted: row.muted,
    mutedAt: row.mutedAt,
    muteReason: row.muteReason,
    activePoints: Number(row.points),
  });
}
