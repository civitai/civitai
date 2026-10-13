import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { logToAxiom } from '~/server/logging/client';

export type ScanLabelSource = 'orchestrator-scan' | 'xguard-prompt';

/** Bumped by hand when the flagger behind a source changes; the source reports no version itself. */
export const SCAN_LABEL_FLAGGER_VERSIONS: Record<ScanLabelSource, string> = {
  'orchestrator-scan': 'orchestrator@2026-10-12',
  'xguard-prompt': 'xguard-prompt@2026-10-13',
};

/**
 * Records a flagger hit on an image for moderators to label. A label only: nothing here reads or
 * writes the image's visibility. Never throws, so a failure cannot fail the ingestion it rides on.
 */
export async function recordScanLabelFlag({
  imageId,
  source,
  reason,
  workflowId,
  flaggedAt,
  snapshot,
  oncePerImage = false,
}: {
  imageId: number;
  source: ScanLabelSource;
  reason: string | null;
  workflowId: string;
  flaggedAt: Date;
  snapshot: Record<string, unknown>;
  /** Skip the flag when the image already has one from this source, whatever its workflow. */
  oncePerImage?: boolean;
}) {
  try {
    if (!(await isFlipt(FLIPT_FEATURE_FLAGS.SCAN_LABEL_QUEUE_WRITER, String(imageId)))) return;

    // One statement, so a flag never lands without its item. A redelivered webhook is a no-op.
    await dbWrite.$executeRaw`
      WITH item AS (
        INSERT INTO "ScanLabelItem" ("imageId", lane, "firstFlaggedAt", status)
        VALUES (${imageId}, 'flagged', ${flaggedAt}, 'open')
        ON CONFLICT ("imageId") DO UPDATE
          SET "firstFlaggedAt" = LEAST("ScanLabelItem"."firstFlaggedAt", EXCLUDED."firstFlaggedAt")
        RETURNING id
      )
      INSERT INTO "ScanLabelFlag" ("itemId", source, "flaggerVersion", reason, "workflowId", "flaggedAt", snapshot)
      SELECT id, ${source}, ${SCAN_LABEL_FLAGGER_VERSIONS[source]}, ${reason}, ${workflowId},
        ${flaggedAt}, ${JSON.stringify(snapshot)}::jsonb
      FROM item
      ${
        oncePerImage
          ? Prisma.sql`WHERE NOT EXISTS (
              SELECT 1 FROM "ScanLabelFlag" f WHERE f."itemId" = item.id AND f.source = ${source}
            )`
          : Prisma.empty
      }
      ON CONFLICT ("workflowId") DO NOTHING
    `;
  } catch (error) {
    logToAxiom({
      name: 'scan-label-flag',
      type: 'error',
      message: error instanceof Error ? error.message : 'Unknown error',
      imageId,
      source,
      workflowId,
    }).catch(() => null);
  }
}

/** Whether the image already carries a flag from this source. */
export async function hasScanLabelFlag(imageId: number, source: ScanLabelSource) {
  const rows = await dbWrite.$queryRaw<{ found: number }[]>`
    SELECT 1 AS found
    FROM "ScanLabelFlag" f
    JOIN "ScanLabelItem" i ON i.id = f."itemId"
    WHERE i."imageId" = ${imageId} AND f.source = ${source}
    LIMIT 1
  `;
  return rows.length > 0;
}
