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

export async function queueTextScanRescan(entityType: 'Model' | 'Bounty', entityId: number) {
  // Dynamic: a static import puts the orchestrator client into model.service's load graph.
  const { scanEntityInBackground } = await import('~/server/services/text-scan/submit');
  scanEntityInBackground({ entityType, entityId, force: true });
}
