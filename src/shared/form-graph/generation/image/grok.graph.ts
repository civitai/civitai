import { defineGraph } from 'form-graph';
import { aspectRatioDef, enumDef, imagesDef, workflowScoped } from '../defs';
import { grokHead, grokTextBlock, isGrokV2 } from '../grok-shared';
import { familyScope, modelIdOf, type FamilyExt } from '../shared';

/**
 * Grok's IMAGE arm, ported from `grok-graph.ts`. The video arm is
 * `../video/grok.graph.ts`; the version-locked head and the text block they
 * share live in `../grok-shared.ts`.
 */

// ---- copied from grok-graph.ts, which dies with the data-graph engine -------

const grokImageAspectRatios = [
  { label: '16:9', value: '16:9', width: 1824, height: 1024 },
  { label: '3:2', value: '3:2', width: 1536, height: 1024 },
  { label: '4:3', value: '4:3', width: 1184, height: 888 },
  { label: '1:1', value: '1:1', width: 1024, height: 1024 },
  { label: '3:4', value: '3:4', width: 888, height: 1184 },
  { label: '2:3', value: '2:3', width: 1024, height: 1536 },
  { label: '9:16', value: '9:16', width: 1024, height: 1824 },
];

const grokV2Resolutions = [
  { label: '1K', value: '1k' },
  { label: '2K', value: '2k' },
] as const;

const grokV2Qualities = [
  { label: 'Low', value: 'low' },
  { label: 'Medium', value: 'medium' },
] as const;

// ---- end of grok-graph.ts copies --------------------------------------------

export const grokImage = defineGraph<FamilyExt>({ scope: familyScope })
  .use(grokHead)
  .field(
    'images',
    workflowScoped(({ model, _ext }) =>
      _ext.workflow === 'img2img:edit'
        ? imagesDef({ max: isGrokV2(modelIdOf(model)) ? 3 : 7 })
        : null
    )
  )
  .field('aspectRatio', ({ _ext }) =>
    _ext.workflow !== 'img2img:edit'
      ? aspectRatioDef({ options: grokImageAspectRatios, default: '1:1' })
      : null
  )
  .field('resolution', ({ model }) =>
    isGrokV2(modelIdOf(model)) ? enumDef({ options: grokV2Resolutions, default: '2k' }) : null
  )
  .field('quality', ({ model }) =>
    isGrokV2(modelIdOf(model)) ? enumDef({ options: grokV2Qualities, default: 'medium' }) : null
  )
  .use(grokTextBlock);

export { grokImageAspectRatios, grokV2Resolutions, grokV2Qualities };
