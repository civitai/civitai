import { defineGraph } from 'form-graph';
import {
  getAspectRatioOptions,
  type GenerationAspectRatio,
} from '~/shared/constants/generation.constants';
import {
  VIDEO,
  aspectRatioDef,
  enumDef,
  imagesDef,
  workflowScoped,
  refusingRangeDef,
} from '../defs';
import { grokHead, grokTextBlock, isGrokV15 } from '../grok-shared';
import { familyScope, modelIdOf, type FamilyExt } from '../shared';

/**
 * Grok's VIDEO arm, ported from `grok-graph.ts`. The image arm is
 * `../image/grok.graph.ts`; the version-locked head and the text block they
 * share live in `../grok-shared.ts`.
 */

// ---- copied from grok-graph.ts, which dies with the data-graph engine -------

const grokVideoAspectRatioList: GenerationAspectRatio[] = [
  '16:9',
  '3:2',
  '4:3',
  '1:1',
  '3:4',
  '2:3',
  '9:16',
];

const grokResolutions = [
  { label: '480p', value: '480p' },
  { label: '720p', value: '720p' },
] as const;

const grokV15Resolutions = [...grokResolutions, { label: '1080p', value: '1080p' }] as const;

// ---- end of grok-graph.ts copies --------------------------------------------

const DURATION = refusingRangeDef({ min: 6, max: 15, default: 6 });

export const grokVideo = defineGraph<FamilyExt>({ scope: familyScope })
  .use(grokHead)
  .field(
    'video',
    workflowScoped(({ _ext }) => (_ext.workflow === 'vid2vid:edit' ? VIDEO : null))
  )
  .field(
    'images',
    workflowScoped(({ _ext }) => {
      if (_ext.workflow === 'img2vid:ref2vid')
        return imagesDef({ max: 7, warnOnMissingAiMetadata: true });
      return _ext.workflow === 'img2vid'
        ? imagesDef({ max: 1, warnOnMissingAiMetadata: true })
        : null;
    })
  )
  .field('resolution', ({ model, _ext }) => {
    const supports1080p = isGrokV15(modelIdOf(model)) && _ext.workflow !== 'img2vid:ref2vid';
    return enumDef({
      options: supports1080p ? grokV15Resolutions : grokResolutions,
      default: '720p',
    });
  })
  .field('duration', DURATION)
  .field('aspectRatio', ({ resolution, images, video, _ext }) => {
    const options = getAspectRatioOptions(
      (resolution as '480p' | '720p' | '1080p') ?? '720p',
      grokVideoAspectRatioList
    );
    const hasImages = Array.isArray(images) && images.length > 0;
    const hasVideo = !!(video as { url?: string } | undefined)?.url;
    // ref2vid takes an explicit ratio even though it has images; the other
    // image/video-driven workflows derive it from the input instead
    const isRef2Vid = _ext.workflow === 'img2vid:ref2vid';
    return isRef2Vid || (!hasImages && !hasVideo)
      ? aspectRatioDef({ options, default: '16:9' })
      : null;
  })
  .use(grokTextBlock);

export { grokResolutions, grokV15Resolutions };
