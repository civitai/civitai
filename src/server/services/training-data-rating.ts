import { env } from '~/env/server';
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

const HEADER_TIMEOUT_MS = 30_000;
const HEADER_CONCURRENCY = 8;

/** The blob's level as the orchestrator serves it, which waits for the blob's scan verdict. */
async function blobHeaderLevel(air: string | undefined, workflowId: string) {
  const key = air?.split('@').pop();
  if (!key) return null;
  try {
    const response = await fetch(
      `${env.ORCHESTRATOR_ENDPOINT?.replace(/\/$/, '')}/v2/consumer/blobs/${encodeURIComponent(
        key
      )}?workflowId=${encodeURIComponent(workflowId)}`,
      {
        headers: { Authorization: `Bearer ${env.ORCHESTRATOR_ACCESS_TOKEN}` },
        signal: fetchTimeoutSignal(HEADER_TIMEOUT_MS),
      }
    );
    await response.body?.cancel().catch(() => undefined);
    return response.ok ? response.headers.get('x-nsfw-level') : null;
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
  for (let i = 0; i < entries.length; i += HEADER_CONCURRENCY) {
    const batch = entries.slice(i, i + HEADER_CONCURRENCY);
    rated.push(
      ...(await Promise.all(
        batch.map(async (entry) => ({
          mediaType: entry.mediaType,
          nsfwLevel:
            entry.mediaType === 'text'
              ? null
              : entry.blob?.nsfwLevel ?? (await blobHeaderLevel(entry.air, workflowId)),
        }))
      ))
    );
  }
  rated.push(...(output.rejected ?? []).map(() => ({ mediaType: 'image', nsfwLevel: null })));
  return datasetRating(rated);
}
