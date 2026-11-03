import { textScanResultTextHash } from '@civitai/shared/rating-review';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { carriedRulings, flagEntryPath, labelLiteral } from '~/server/services/text-scan/flag-sql';
import { textScanTextHash } from '~/server/services/text-scan/prompt';
import {
  loadTextScanSubject,
  writeTextScanRuling,
} from '~/server/services/text-scan/label-capture';
import {
  TEXT_SCAN_FLAGS_KEY,
  type TextScanFlagLabel,
} from '~/server/services/text-scan/flag-snapshot';
import {
  getTextScanWebSearchMode,
  TEXT_SCAN_WEB_SEARCH_LABELS,
  textScanEmEntityType,
} from '~/server/services/text-scan/mode';
import { AppealStatus, EntityType } from '~/shared/utils/prisma/enums';
import { asJsonbObjectSql } from '~/server/utils/jsonb-object';

export async function loadTextScanTextHash(entityType: 'Model' | 'Bounty', entityId: number) {
  const subject = await loadTextScanSubject(entityType, entityId);
  return subject ? textScanTextHash(subject) : null;
}

// The hash an overturn grants against, as rating disputes stamp `resolvedTextHash`: the text the
// latest completed scan read, so a verdict landing for that scan is covered while a later owner edit
// gets its own scan and hash. The scan is the one that owns the label: with the web-search pass
// active it judges poi and minor on a row of its own, which can lag or lead the main row after an
// edit. Null when the text cannot be read, whatever the scan row holds.
export async function loadGrantTextHash(
  entityType: 'Model' | 'Bounty',
  entityId: number,
  label: TextScanFlagLabel
) {
  const current = await loadTextScanTextHash(entityType, entityId);
  if (!current) return null;
  const owner =
    (TEXT_SCAN_WEB_SEARCH_LABELS as readonly string[]).includes(label) &&
    (await getTextScanWebSearchMode(entityType, entityId)) === 'active'
      ? textScanEmEntityType(entityType, 'active', 'web-search')
      : entityType;
  const scan = await dbWrite.entityModeration.findUnique({
    where: { entityType_entityId: { entityType: owner, entityId } },
    select: { result: true },
  });
  return textScanResultTextHash(scan?.result) ?? current;
}

export async function stampModeratorTextScanRuling({
  modelId,
  userId,
  label,
  reason,
  note,
  textHash: ruledHash,
}: {
  modelId: number;
  userId: number;
  label: TextScanFlagLabel;
  reason?: string;
  note?: string;
  /** The flagged text the moderator ruled on; skips reading the current text, which may have been edited since. */
  textHash?: string;
}) {
  const textHash = ruledHash ?? (await loadGrantTextHash('Model', modelId, label));
  if (!textHash) return false;
  // The moderator just ruled on the current state, so a pending re-detection is moot.
  await writeTextScanRuling(
    {
      modelId,
      labels: [label],
      decision: 'appealGranted',
      via: 'moderator',
      moderatorId: userId,
      reason,
      note,
    },
    (tx) => tx.$executeRaw`
    UPDATE "Model" m
    SET meta = ${asJsonbObjectSql('m.meta')} || jsonb_build_object(
      ${TEXT_SCAN_FLAGS_KEY}::text, COALESCE(m.meta->${TEXT_SCAN_FLAGS_KEY}, '{}'::jsonb) || jsonb_build_object(
        ${labelLiteral(label)}, (COALESCE(${flagEntryPath(label)}, '{}'::jsonb) - 'redetected')
          || ${carriedRulings(label, ['appealGranted'])}
          || jsonb_build_object(
            'appealGranted', jsonb_build_object(
              'at', now(), 'by', ${userId}::int, 'textHash', ${textHash}::text, 'via', 'moderator'
            ) || jsonb_strip_nulls(jsonb_build_object(
              'reason', ${reason ?? null}::text, 'note', ${note ?? null}::text
            ))
          )
      )
    )
    WHERE m.id = ${modelId}
  `,
    (changed) => changed > 0
  );
  return true;
}

// A moderator lifting a flag outside the appeals page leaves nothing for the owner's appeal to
// decide, so it closes the way an overturn would. The flags are read back rather than trusted from
// the caller: a lift that failed, or a second flag still in force, keeps the appeal open. Never
// throws, since the moderator's own edit has already been made.
export async function settleFlagAppealsAfterModeratorLift({
  modelId,
  userId,
  liftedLabels,
  recordRulings = true,
}: {
  modelId: number;
  userId: number;
  liftedLabels: TextScanFlagLabel[];
  /** False when the caller stamped the rulings ahead of its lift, as a rescan landing mid-lift must see them. */
  recordRulings?: boolean;
}) {
  try {
    if (recordRulings)
      for (const label of liftedLabels) {
        const stamped = await stampModeratorTextScanRuling({ modelId, userId, label }).catch(
          () => false
        );
        if (!stamped)
          logToAxiom({
            type: 'error',
            name: 'text-scan',
            message: `moderator ${label} ruling not recorded: model text unreadable`,
            modelId,
          }).catch(() => null);
      }

    const model = await dbWrite.model.findUnique({
      where: { id: modelId },
      select: { minor: true, poi: true },
    });
    if (!model || model.minor || model.poi) return;

    // Dynamic: report.service pulls the buzz and notification graph that the profile loaders avoid.
    const { resolveEntityAppeal } = await import('~/server/services/report.service');
    await resolveEntityAppeal({
      ids: [modelId],
      entityType: EntityType.Model,
      status: AppealStatus.Approved,
      userId,
      modelAppealKind: 'flag',
    });
  } catch (error) {
    logToAxiom({
      type: 'error',
      name: 'text-scan',
      message: 'flag appeal not settled after moderator lift',
      modelId,
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => null);
  }
}
