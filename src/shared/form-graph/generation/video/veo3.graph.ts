import { z } from 'zod';
import { defineGraph } from 'form-graph';
import { checkpointDef } from '../checkpoint';
import { SEED, aspectRatioDef, boolDef, imagesDef, workflowScoped } from '../defs';
import { familyScope, textBlock, type FamilyExt } from '../shared';

/**
 * Veo 3, ported from `veo3-graph.ts`. Fast/Standard version pick (same list
 * on both workflows); ref2vid pins duration to 8s and takes up to 3
 * references; img2vid derives its ratio from the source. Negative prompt
 * registers at top level.
 */

// ---- copied from veo3-graph.ts, which dies with the data-graph engine -------

const veo3BaseModel = 'Veo 3';

export const veo3VersionIds = {
  fast: 2827948,
  standard: 2827945,
} as const;

const veo3VersionOptions = [
  { label: 'Fast Mode', value: veo3VersionIds.fast, baseModel: veo3BaseModel },
  { label: 'Standard', value: veo3VersionIds.standard, baseModel: veo3BaseModel },
];

const veo3AspectRatios = [
  { label: '16:9', value: '16:9', width: 1920, height: 1080 },
  { label: '1:1', value: '1:1', width: 1080, height: 1080 },
  { label: '9:16', value: '9:16', width: 1080, height: 1920 },
];

const veo3Durations = [
  { label: '4 seconds', value: 4 },
  { label: '6 seconds', value: 6 },
  { label: '8 seconds', value: 8 },
];

const veo3ApiVersions = ['3.1'] as const;
type Veo3ApiVersion = (typeof veo3ApiVersions)[number];

const veo3ApiVersionOptions = [{ label: 'Veo 3.1', value: '3.1' as Veo3ApiVersion }];

// ---- end of veo3-graph.ts copies --------------------------------------------

export const veo3 = defineGraph<FamilyExt>({ scope: familyScope })
  .field(
    'images',
    workflowScoped(({ _ext }) => {
      if (_ext.workflow === 'img2vid:ref2vid')
        return imagesDef({ max: 3, warnOnMissingAiMetadata: true, aspectRatios: ['16:9', '9:16'] });
      if (_ext.workflow === 'img2vid')
        return imagesDef({ warnOnMissingAiMetadata: true, aspectRatios: ['16:9', '9:16'] });
      return null;
    })
  )
  .field('model', ({ _ext }) =>
    // v1 configures workflowVersions, but both workflows share ONE option
    // list, so the cross-workflow machinery is inert
    checkpointDef({
      ecosystem: _ext.ecosystem,
      workflow: _ext.workflow,
      ext: _ext,
      versions: { options: veo3VersionOptions },
      defaultModelId: veo3VersionIds.fast,
    })
  )
  .field('seed', SEED)
  .use(textBlock)
  .field('aspectRatio', ({ _ext }) =>
    _ext.workflow === 'txt2vid'
      ? aspectRatioDef({ options: veo3AspectRatios, default: '16:9' })
      : null
  )
  .field('duration', ({ _ext }) => {
    const isRef2Vid = _ext.workflow === 'img2vid:ref2vid';
    return {
      // ref2vid pins duration to 8s at the boundary, as v1's transform does
      input: z.coerce
        .number()
        .optional()
        .transform((v) => (isRef2Vid ? 8 : v)),
      output: z.number(),
      default: 8,
      meta: {
        options: isRef2Vid ? [{ label: '8 seconds', value: 8 }] : veo3Durations,
        disabled: isRef2Vid,
      },
    };
  })
  .field('generateAudio', boolDef(false))
  .field('version', {
    input: z.enum(veo3ApiVersions).optional(),
    output: z.enum(veo3ApiVersions),
    default: '3.1' as Veo3ApiVersion,
    meta: { options: veo3ApiVersionOptions },
  });

export {
  veo3AspectRatios,
  veo3Durations,
  veo3VersionOptions,
  veo3ApiVersions,
  veo3ApiVersionOptions,
};
