/**
 * Handler for `vid2vid:preprocess` — the standalone control-preprocessor
 * workflow for video.
 *
 * Its image counterpart is inline in `orchestration-new.service.ts`; this one
 * sits with the other handlers in `ecosystems/`.
 *
 * The graph stores kind-specific params as a free-form `kindParams` record
 * (specs in `videoPreprocessKindParamSpecs`); this merges the kind discriminator
 * and that record into a `PreprocessVideoInput`, which the orchestrator then
 * validates against its typed union.
 *
 * The control map is the deliverable here, so — unlike the preprocess step
 * folded into an H3 ControlNet generation by `control-video.helper.ts` — the
 * output is deliberately NOT suppressed.
 */

import type {
  PreprocessVideoInput,
  PreprocessVideoStepTemplate,
} from '@civitai/orchestration-client';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { removeEmpty } from '~/utils/object-helpers';

export type VideoPreprocessData = {
  video?: { url?: string | null } | null;
  preprocessKind: string;
  preprocessResolution?: number;
  kindParams?: Record<string, unknown>;
};

export function createVideoPreprocessStep(data: VideoPreprocessData): PreprocessVideoStepTemplate {
  const url = data.video?.url;
  if (!url) throw throwBadRequestError('Video URL is required for preprocess');

  return {
    $type: 'preprocessVideo',
    // kindParams is a free-form record, so it spreads FIRST — last-wins would
    // let a caller override the validated kind and the clamped resolution.
    input: removeEmpty({
      ...(data.kindParams ?? {}),
      kind: data.preprocessKind,
      video: url,
      resolution: data.preprocessResolution,
    }) as unknown as PreprocessVideoInput,
  } as PreprocessVideoStepTemplate;
}
