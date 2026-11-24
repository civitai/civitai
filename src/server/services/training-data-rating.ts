import { headBlob } from '@civitai/orchestration-client';
import { internalOrchestratorClient } from '~/server/services/orchestrator/client';
import { fetchTimeoutSignal } from '~/server/utils/fetch-timeout';
import { orchestratorNsfwLevelMap } from '~/shared/constants/browsingLevel.constants';

export type RatedEntry = { mediaType?: string | null; nsfwLevel?: string | null };

/**
 * A Training Data zip's rating from its entries: the OR of each media entry's level, and
 * `fullyRated` only when there is media and every media entry has a level
 * (trainingDataServableOnHost reads both). Caption entries carry no level and are not counted.
 */
export function datasetRating(entries: RatedEntry[]): {
  nsfwLevel: number | undefined;
  fullyRated: boolean;
} {
  let nsfwLevel = 0;
  let media = 0;
  let unrated = 0;
  for (const entry of entries) {
    if (entry.mediaType === 'text') continue;
    media += 1;
    const level = entry.nsfwLevel ? orchestratorNsfwLevelMap[entry.nsfwLevel.toLowerCase()] : 0;
    if (level) nsfwLevel |= level;
    else unrated += 1;
  }
  return { nsfwLevel: nsfwLevel || undefined, fullyRated: media > 0 && unrated === 0 };
}

type ExtractionOutput = {
  entries?: { air?: string; mediaType?: string; blob?: { nsfwLevel?: string | null } | null }[];
  rejected?: unknown[];
};

/**
 * Skips Studio dataset rows (the archive rates them) and a zip swapped in meanwhile (url check). A
 * pre-stamp zip, which has no fullyRated, is only ever moved to fully rated, never newly hidden.
 */
export async function writeTrainingDataRating(
  db: { $executeRaw: (query: TemplateStringsArray, ...values: unknown[]) => Promise<number> },
  { fileId, url, rating }: { fileId: number; url: string; rating: ReturnType<typeof datasetRating> }
) {
  return db.$executeRaw`
    UPDATE "ModelFile"
    SET metadata = (COALESCE(metadata, '{}'::jsonb) - 'nsfwLevel') || ${JSON.stringify(
      rating
    )}::jsonb
    WHERE id = ${fileId} AND url = ${url} AND type = 'Training Data'
      AND NOT (COALESCE(metadata, '{}'::jsonb) ? 'datasetArchive')
      AND (${rating.fullyRated} OR COALESCE(metadata, '{}'::jsonb) ? 'fullyRated')`;
}

const HEADER_TIMEOUT_MS = 5_000;
const HEADER_CONCURRENCY = 8;
/**
 * The whole header pass, which runs inside the scan webhook, so it stays short: past it, the rest
 * count as unrated and the zip stays not fully rated.
 */
export const HEADER_PASS_DEADLINE_MS = 15_000;
/** Entries the extraction step extracts; the rest come back rejected, so the zip is not fully rated. */
export const TRAINING_DATA_MAX_RATED_ENTRIES = 2_000;

/** The blob's level as the orchestrator serves it, which waits for the blob's scan verdict. */
async function blobHeaderLevel(air: string | undefined, workflowId: string, deadline: number) {
  const blobId = air?.split('@').pop();
  const timeout = Math.min(HEADER_TIMEOUT_MS, deadline - Date.now());
  if (!blobId || timeout <= 0) return null;
  try {
    const { response } = await headBlob({
      client: internalOrchestratorClient,
      path: { blobId },
      query: { workflowId },
      signal: fetchTimeoutSignal(timeout),
    });
    return response?.ok ? response.headers.get('x-nsfw-level') : null;
  } catch {
    return null;
  }
}

/**
 * An uploaded zip's rating from its `archiveExtraction` step: each entry's own level, else the
 * blob's `x-nsfw-level`; a rejected entry, or one with no level either way, leaves the zip not
 * fully rated.
 */
export async function extractionRating(output: ExtractionOutput, workflowId: string) {
  const entries = output.entries ?? [];
  const rated: RatedEntry[] = [];
  const deadline = Date.now() + HEADER_PASS_DEADLINE_MS;
  for (let i = 0; i < entries.length; i += HEADER_CONCURRENCY) {
    if (Date.now() > deadline) {
      rated.push(
        ...entries.slice(i).map((entry) => ({ mediaType: entry.mediaType, nsfwLevel: null }))
      );
      break;
    }
    const batch = entries.slice(i, i + HEADER_CONCURRENCY);
    rated.push(
      ...(await Promise.all(
        batch.map(async (entry) => ({
          mediaType: entry.mediaType,
          nsfwLevel:
            entry.mediaType === 'text'
              ? null
              : entry.blob?.nsfwLevel ?? (await blobHeaderLevel(entry.air, workflowId, deadline)),
        }))
      ))
    );
  }
  rated.push(...(output.rejected ?? []).map(() => ({ mediaType: 'image', nsfwLevel: null })));
  return datasetRating(rated);
}
