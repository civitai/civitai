import { z } from 'zod';
import { defFamily, defineGraph } from 'form-graph';
import type { FeatureAccess } from '~/server/services/feature-flags.service';
import { checkpointDef } from '../checkpoint';
import { optionFallback, aspectRatioDef, enumDef, img2imgImages } from '../defs';
import { familyScope, promptOnlyTextBlock, type FamilyExt } from '../shared';

export const krea3VersionId = 3405360;

export const KREA3_IMAGES_LIMIT = 6;

const krea3ResolutionOptions = ['1k', '2k'] as const;
type Krea3Resolution = (typeof krea3ResolutionOptions)[number];

// Each side of a 1 MP / 4 MP frame rounded to 16, so 2K is not an exact double of 1K.
const krea3AspectRatiosByResolution: Record<
  Krea3Resolution,
  { label: string; value: string; width: number; height: number }[]
> = {
  '1k': [
    { label: '21:9', value: '21:9', width: 1568, height: 672 },
    { label: '16:9', value: '16:9', width: 1360, height: 768 },
    { label: '3:2', value: '3:2', width: 1248, height: 832 },
    { label: '4:3', value: '4:3', width: 1184, height: 880 },
    { label: '5:4', value: '5:4', width: 1120, height: 896 },
    { label: '1:1', value: '1:1', width: 1024, height: 1024 },
    { label: '4:5', value: '4:5', width: 896, height: 1120 },
    { label: '3:4', value: '3:4', width: 880, height: 1184 },
    { label: '2:3', value: '2:3', width: 832, height: 1248 },
    { label: '9:16', value: '9:16', width: 768, height: 1360 },
  ],
  '2k': [
    { label: '21:9', value: '21:9', width: 3136, height: 1344 },
    { label: '16:9', value: '16:9', width: 2736, height: 1536 },
    { label: '3:2', value: '3:2', width: 2512, height: 1680 },
    { label: '4:3', value: '4:3', width: 2368, height: 1776 },
    { label: '5:4', value: '5:4', width: 2288, height: 1824 },
    { label: '1:1', value: '1:1', width: 2048, height: 2048 },
    { label: '4:5', value: '4:5', width: 1824, height: 2288 },
    { label: '3:4', value: '3:4', width: 1776, height: 2368 },
    { label: '2:3', value: '2:3', width: 1680, height: 2512 },
    { label: '9:16', value: '9:16', width: 1536, height: 2736 },
  ],
};

const krea3PriorityRatios = ['16:9', '4:3', '1:1', '3:4', '9:16'];

const AR = defFamily((resolution: Krea3Resolution) =>
  aspectRatioDef({
    options: krea3AspectRatiosByResolution[resolution] ?? krea3AspectRatiosByResolution['1k'],
    default: '1:1',
    priorityOptions: krea3PriorityRatios,
  })
);

const krea3ThinkingModeOptions = [
  { label: 'Instant', value: 'instant' },
  { label: 'Medium', value: 'medium' },
  { label: 'Ultra', value: 'ultra' },
] as const;

/**
 * Ultra is gated by `krea3Ultra` (Krea's capacity-limited top mode, opened at launch) and is
 * 2K only: the orchestrator refuses it at 1K.
 */
export function getKrea3ThinkingModeOptions(
  flags?: Partial<FeatureAccess>,
  resolution: Krea3Resolution = '1k'
) {
  return flags?.krea3Ultra === true && resolution === '2k'
    ? krea3ThinkingModeOptions
    : krea3ThinkingModeOptions.filter((o) => o.value !== 'ultra');
}

export const krea3 = defineGraph<FamilyExt>({ scope: familyScope })
  .field('model', ({ _ext }) =>
    checkpointDef({
      ecosystem: _ext.ecosystem,
      workflow: _ext.workflow,
      ext: _ext,
      modelLocked: true,
      defaultModelId: krea3VersionId,
    })
  )
  .use(promptOnlyTextBlock)
  .field('resolution', {
    input: z.enum(krea3ResolutionOptions).optional(),
    output: z.enum(krea3ResolutionOptions),
    default: '1k' as Krea3Resolution,
    correct: optionFallback(krea3ResolutionOptions, '1k' as Krea3Resolution),
    meta: {
      options: krea3ResolutionOptions.map((value) => ({ label: value.toUpperCase(), value })),
    },
  })
  // No ratio for edit: Krea follows the references.
  .field('aspectRatio', ({ resolution, _ext }) =>
    _ext.workflow.startsWith('txt') ? AR(resolution ?? '1k') : null
  )
  .field('images', img2imgImages({ min: 1, max: KREA3_IMAGES_LIMIT }))
  .field('thinkingMode', ({ resolution, _ext }) =>
    enumDef({
      options: getKrea3ThinkingModeOptions(_ext.flags, resolution ?? '1k'),
      default: 'instant',
    })
  );
