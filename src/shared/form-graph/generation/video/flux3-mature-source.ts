import type { NsfwLevel } from '@civitai/orchestration-client';
import { isMature } from '~/shared/constants/orchestrator.constants';
import { isWorkflowOrVariant } from '~/shared/generation/config/workflows';
import { FLUX3_KEYFRAMES_WORKFLOW } from './flux3-video.graph';

type Flux3SourceState = {
  ecosystem?: string;
  workflow?: string;
  images?: { url: string }[];
  keyframes?: { image?: { url: string } }[];
};

/** The source image urls Flux 3 Video's provider checks, or none outside its image workflows. */
export function flux3SourceImageUrls(state: Flux3SourceState): string[] {
  if (state.ecosystem !== 'Flux3Video' || !state.workflow) return [];
  if (state.workflow === FLUX3_KEYFRAMES_WORKFLOW)
    return (state.keyframes ?? []).flatMap((k) => (k.image?.url ? [k.image.url] : []));
  if (isWorkflowOrVariant(state.workflow, 'img2vid')) return (state.images ?? []).map((i) => i.url);
  return [];
}

/** Unrated (unknown, still scanning, or `na`) never blocks. */
export function hasMatureSource(
  urls: string[],
  ratingOf: (url: string) => NsfwLevel | null | undefined
): boolean {
  return urls.some((url) => !!isMature(ratingOf(url) ?? undefined));
}
