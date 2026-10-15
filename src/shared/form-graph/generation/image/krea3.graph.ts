import { z } from 'zod';
import { defineGraph } from 'form-graph';
import { checkpointDef } from '../checkpoint';
import { optionFallback, aspectRatioDef, enumDef, img2imgImages } from '../defs';
import { familyScope, promptOnlyTextBlock, type FamilyExt } from '../shared';

export const krea3VersionId = 3405360;

export const KREA3_IMAGES_LIMIT = 6;

// Dims are the 1K sizes.
const krea3AspectRatios = [
  { label: '21:9', value: '21:9', width: 1568, height: 672 },
  { label: '16:9', value: '16:9', width: 1360, height: 768 },
  { label: '3:2', value: '3:2', width: 1248, height: 832 },
  { label: '4:3', value: '4:3', width: 1184, height: 880 },
  { label: '5:4', value: '5:4', width: 1120, height: 896 },
  { label: '1:1', value: '1:1', width: 1024, height: 1024 },
  { label: '4:5', value: '4:5', width: 896, height: 1120 },
  { label: '3:4', value: '3:4', width: 888, height: 1184 },
  { label: '2:3', value: '2:3', width: 832, height: 1248 },
  { label: '9:16', value: '9:16', width: 768, height: 1360 },
];

const krea3PriorityRatios = ['16:9', '4:3', '1:1', '3:4', '9:16'];

const krea3ResolutionOptions = ['1k', '2k'] as const;
type Krea3Resolution = (typeof krea3ResolutionOptions)[number];

const krea3ThinkingModeOptions = [
  { label: 'Instant', value: 'instant' },
  { label: 'Medium', value: 'medium' },
] as const;

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
  .field('aspectRatio', ({ _ext }) =>
    _ext.workflow.startsWith('txt')
      ? aspectRatioDef({
          options: krea3AspectRatios,
          default: '1:1',
          priorityOptions: krea3PriorityRatios,
        })
      : null
  )
  .field('images', img2imgImages({ min: 1, max: KREA3_IMAGES_LIMIT }))
  .field('thinkingMode', enumDef({ options: krea3ThinkingModeOptions, default: 'instant' }));
