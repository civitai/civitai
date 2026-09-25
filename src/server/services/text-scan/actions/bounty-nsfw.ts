import { bountyBuzzType } from '@civitai/shared/rated-entity-sql';
import { NotificationCategory, NsfwLevel } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { voidBountyForNsfw } from '~/server/services/bounty.service';
import { createNotification } from '~/server/services/notification.service';
import type { ApplyTextScanArgs } from '~/server/services/text-scan/actions/types';
import { applyRatingFloor } from '~/server/services/text-scan/rated-entities';

async function markBountyNsfw({
  entityId,
  workflowId,
  level,
}: {
  entityId: number;
  workflowId: string;
  level: number;
}) {
  // `details.textScanNsfw` is how a rollback finds the rows this flipped. details can hold
  // JSON null, and `null || object` is null.
  await dbWrite.$executeRaw`
    UPDATE "Bounty" b
    SET nsfw = TRUE,
        details = (CASE WHEN jsonb_typeof(b.details) = 'object' THEN b.details ELSE '{}'::jsonb END) || jsonb_build_object(
          'textScanNsfw',
          jsonb_build_object('workflowId', ${workflowId}::text, 'level', ${level}::int, 'at', now())
        )
    WHERE b.id = ${entityId}
      AND b.nsfw = FALSE
      AND NOT ('nsfw' = ANY(b."lockedProperties"))
      AND b."moderatorNsfwLevel" IS NULL
  `;
}

async function notifyBountyNsfwCancelled(bountyId: number, ownerId: number | null, userIds: number[]) {
  await Promise.all(
    userIds.map((userId) =>
      createNotification({
        userId,
        category: NotificationCategory.System,
        type: 'system-message',
        key:
          userId === ownerId
            ? `bounty-nsfw-cancelled-${bountyId}`
            : `bounty-nsfw-cancelled-${bountyId}-${userId}`,
        details: {
          message:
            userId === ownerId
              ? 'Your bounty was cancelled because its text was flagged as adult content — bounties paid with green Buzz must be safe-for-work. The Buzz has been refunded; you can recreate it on civitai.red.'
              : 'A bounty you funded was cancelled because its text was flagged as adult content. Your Buzz has been refunded.',
          url: `/bounties/${bountyId}`,
        },
      }).catch(() => null)
    )
  );
}

// Green Buzz can never fund NSFW: a green bounty the scan rates R or above is cancelled and
// refunded rather than rated up and left live, as a green Challenge is.
export async function applyBountyNsfwTextScan(args: ApplyTextScanArgs) {
  const { entityId, workflowId, outcome } = args;
  if (!outcome.nsfw?.raised || outcome.nsfw.detectedLevel < NsfwLevel.R)
    return applyRatingFloor('Bounty', args);

  const bounty = await dbWrite.bounty.findUnique({
    where: { id: entityId },
    select: {
      userId: true,
      nsfw: true,
      lockedProperties: true,
      buzzType: true,
      moderatorNsfwLevel: true,
    },
  });
  if (!bounty || bounty.moderatorNsfwLevel != null) return applyRatingFloor('Bounty', args);

  const kind = bountyBuzzType(bounty);
  if (kind === 'green') {
    const result = await voidBountyForNsfw(entityId);
    if (result.voided)
      await notifyBountyNsfwCancelled(entityId, bounty.userId, result.refundedUserIds);
    else if (result.reason === 'in-payout' || result.reason === 'no-currency')
      logToAxiom({
        type: 'error',
        name: 'bounty-nsfw-escalation-held',
        message: `Green bounty ${entityId} scanned NSFW (${result.reason}); rating raised, not refunded.`,
        bountyId: entityId,
        reason: result.reason,
      }).catch(() => null);
    return applyRatingFloor('Bounty', args, { notify: false });
  }

  if (kind === 'unknown')
    logToAxiom({
      type: 'warning',
      name: 'bounty-nsfw-green-unknown',
      message: `Bounty ${entityId} scanned NSFW; paid-in Buzz type unknown, not voided.`,
      bountyId: entityId,
    }).catch(() => null);
  else await markBountyNsfw({ entityId, workflowId, level: outcome.nsfw.detectedLevel });

  return applyRatingFloor('Bounty', args);
}
