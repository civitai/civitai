import { NsfwLevel } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
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
        "lockedProperties" = ARRAY(
          SELECT DISTINCT unnest(COALESCE(b."lockedProperties", ARRAY[]::text[]) || ARRAY['nsfw']::text[])
        ),
        details = (CASE WHEN jsonb_typeof(b.details) = 'object' THEN b.details ELSE '{}'::jsonb END) || jsonb_build_object(
          'textScanNsfw',
          jsonb_build_object('workflowId', ${workflowId}::text, 'level', ${level}::int, 'at', now())
        )
    WHERE b.id = ${entityId}
      AND b.nsfw = FALSE
      AND NOT ('nsfw' = ANY(COALESCE(b."lockedProperties", ARRAY[]::text[])))
      AND b."moderatorNsfwLevel" IS NULL
  `;
}

export async function applyBountyNsfwTextScan(args: ApplyTextScanArgs) {
  const { entityId, workflowId, outcome } = args;
  if (outcome.nsfw && outcome.nsfw.detectedLevel >= NsfwLevel.R)
    await markBountyNsfw({ entityId, workflowId, level: outcome.nsfw.detectedLevel });
  return applyRatingFloor('Bounty', args);
}
