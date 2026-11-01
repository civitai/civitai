import { useQuery } from '@tanstack/react-query';
import { useMemo, useSyncExternalStore } from 'react';
import type { GenerationStore } from '~/components/form-graph/generation/store';
import type { BlobRating } from '~/server/services/orchestrator/blobRatings';
import { MATURE_SOURCE_ALTERNATIVE } from '~/shared/constants/mature-source.constants';
import { maxNsfwLevel } from '~/shared/constants/orchestrator.constants';
import {
  flux3SourceImageUrls,
  galleryRatingToSourceRating,
  hasMatureSource,
} from '~/shared/form-graph/generation/video/flux3-mature-source';
import { FLUX3_KEYFRAMES_WORKFLOW } from '~/shared/form-graph/generation/video/flux3-video.graph';
import { getConsumerBlobId } from '~/shared/orchestrator/blob-url';
import { useSourceMetadataStore } from '~/store/source-metadata.store';
import type { ResourceData } from '~/shared/form-graph/generation/defs';
import { NsfwLevel } from '@civitai/orchestration-client';
import { sourceMetadataStore } from '~/store/source-metadata.store';

const POLL_MS = 3_000;
// `NA` means both "still scanning" and "no level", so polling has to give up on its own.
const MAX_POLLS = 20;

// Never throws: a failed fetch must count toward MAX_POLLS like an unrated answer, or polling never ends.
async function fetchBlobRatings(blobIds: string[]): Promise<BlobRating[]> {
  try {
    const response = await fetch('/api/orchestrator/blobRatings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blobIds }),
    });
    if (!response.ok) return [];
    return ((await response.json()) as { ratings: BlobRating[] }).ratings;
  } catch {
    return [];
  }
}

/**
 * Whether a Flux 3 Video source image is rated above PG-13, which its provider rejects, and
 * whether the form can switch to the alternative without losing work (H3 has no keyframes).
 */
export function useFlux3MatureSource(store: GenerationStore): {
  blocked: boolean;
  canSwitch: boolean;
} {
  const workflow = useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => (store.getSnapshot().state as { workflow?: string }).workflow,
    () => undefined
  );
  // Joined so the snapshot is a primitive: an array would be a new reference on every read.
  const urlsKey = useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => flux3SourceImageUrls(store.getSnapshot().state).join('\n'),
    () => ''
  );
  const urls = useMemo(() => (urlsKey ? urlsKey.split('\n') : []), [urlsKey]);

  const metadataByUrl = useSourceMetadataStore((s) => s.metadataByUrl);
  const seeded = (url: string) => {
    const level = metadataByUrl[url]?.nsfwLevel as NsfwLevel | undefined;
    return level && level !== NsfwLevel.NA ? level : undefined;
  };

  const blobIdByUrl = new Map<string, string>();
  for (const url of urls) {
    const blobId = getConsumerBlobId(url);
    if (blobId) blobIdByUrl.set(url, blobId);
  }
  const blobIds = [...new Set(blobIdByUrl.values())].sort();

  const { data } = useQuery({
    queryKey: ['blobRatings', blobIds],
    queryFn: () => fetchBlobRatings(blobIds),
    enabled: blobIds.length > 0,
    refetchInterval: (query) => {
      const ratings = query.state.data;
      const allRated = !!ratings?.length && ratings.every((r) => r.nsfwLevel);
      return allRated || query.state.dataUpdateCount >= MAX_POLLS ? false : POLL_MS;
    },
  });

  const fetched = new Map(data?.map((r) => [r.blobId, r.nsfwLevel]));
  // The more severe of the two, so neither a low seed nor a low scan can hide the other.
  const blocked = hasMatureSource(urls, (url) => {
    const blobId = blobIdByUrl.get(url);
    return maxNsfwLevel([seeded(url), blobId ? fetched.get(blobId) : undefined]);
  });
  return { blocked, canSwitch: workflow !== FLUX3_KEYFRAMES_WORKFLOW };
}

/** Keeps the source images: H3 takes the same first and last frame slots. */
export function switchToMatureSourceAlternative(store: GenerationStore) {
  store.set({
    ecosystem: MATURE_SOURCE_ALTERNATIVE.ecosystem,
    model: { id: MATURE_SOURCE_ALTERNATIVE.modelId, model: { type: 'Checkpoint' } } as ResourceData,
  });
}

/** A rating the caller already holds (a generated output's), so the check needs no lookup. */
export function recordSourceRating(url: string, nsfwLevel: NsfwLevel | undefined) {
  if (nsfwLevel && nsfwLevel !== NsfwLevel.NA) sourceMetadataStore.setMetadata(url, { nsfwLevel });
}

/** A gallery image's rating, as loaded with that image's record. */
export function recordGallerySourceRating(url: string, nsfwLevel: number) {
  recordSourceRating(url, galleryRatingToSourceRating(nsfwLevel));
}

/** The form re-uploads a source under a new url, and the rating has to follow it. */
export function transferSourceRating(fromUrl: string, toUrl: string) {
  const nsfwLevel = sourceMetadataStore.getMetadata(fromUrl)?.nsfwLevel as NsfwLevel | undefined;
  recordSourceRating(toUrl, nsfwLevel);
}
