import { textScanResultTextHash } from '@civitai/shared/rating-review';
import { dbWrite } from '~/server/db/client';
import {
  TEXT_SCAN_FLAGS_KEY,
  type TextScanFlagLabel,
} from '~/server/services/text-scan/flag-snapshot';
import { getTextScanProfile } from '~/server/services/text-scan/profiles';
// `text-scan/profiles` resolves to the registry file; only the barrel registers the profiles.
import '~/server/services/text-scan/profiles/index';
import { textScanTextHash } from '~/server/services/text-scan/prompt';

export async function loadTextScanTextHash(entityType: 'Model' | 'Bounty', entityId: number) {
  const subject = (await getTextScanProfile(entityType)?.load([entityId]))?.get(entityId);
  return subject ? textScanTextHash(subject) : null;
}

// The hash an overturn grants against, as rating disputes stamp `resolvedTextHash`: the text the
// latest completed scan read, so a verdict landing for that scan is covered while a later owner edit
// gets its own scan and hash. Null when the text cannot be read, whatever the scan row holds.
export async function loadGrantTextHash(entityType: 'Model' | 'Bounty', entityId: number) {
  const current = await loadTextScanTextHash(entityType, entityId);
  if (!current) return null;
  const scan = await dbWrite.entityModeration.findUnique({
    where: { entityType_entityId: { entityType, entityId } },
    select: { result: true },
  });
  return textScanResultTextHash(scan?.result) ?? current;
}

export async function stampModeratorTextScanRuling({
  modelId,
  userId,
  label,
}: {
  modelId: number;
  userId: number;
  label: TextScanFlagLabel;
}) {
  const textHash = await loadTextScanTextHash('Model', modelId);
  if (!textHash) return false;
  await dbWrite.$executeRaw`
    UPDATE "Model" m
    SET meta = COALESCE(m.meta, '{}'::jsonb) || jsonb_build_object(
      ${TEXT_SCAN_FLAGS_KEY}::text, COALESCE(m.meta->${TEXT_SCAN_FLAGS_KEY}, '{}'::jsonb) || jsonb_build_object(
        ${label}::text, COALESCE(m.meta->${TEXT_SCAN_FLAGS_KEY}->${label}, '{}'::jsonb) || jsonb_build_object(
          'appealGranted', jsonb_build_object(
            'at', now(), 'by', ${userId}::int, 'textHash', ${textHash}::text, 'via', 'moderator'
          )
        )
      )
    )
    WHERE m.id = ${modelId}
  `;
  return true;
}
