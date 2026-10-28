import { z } from 'zod';
import { branch, defFamily, defineGraph } from 'form-graph';
import {
  getAspectRatioOptions,
  type GenerationAspectRatio,
} from '~/shared/constants/generation.constants';
import { klingVersionIds } from '~/shared/generation/version-ids';
import { checkpointDef } from '../checkpoint';
import {
  optionFallback,
  SEED,
  VIDEO,
  aspectRatioDef,
  boolDef,
  enumDef,
  imagesDef,
  sliderDef,
  workflowScoped,
  refusingRangeDef,
  type ResourceData,
} from '../defs';
import { familyScope, makeTextBlock, modelIdOf, textBlock, type FamilyExt } from '../shared';

/**
 * Kling (V1.6 / V2 / V2.5 Turbo on the legacy engine, V3 on kling-v3, V4 on kling-v4).
 * ref2vid exists only on V3 and V4, and vid2vid:edit only on V4, so those workflows
 * FORCE the model — the workflow wins over the model-driven fallback. V3's
 * `multiShot`/`klingElements` subtree is not built; V4's is. V3 and V4 derive an
 * `operation` from the workflow; legacy carries the negative prompt, V3 and V4 do not.
 */

const klingVersionOptions = [
  { label: 'V1.6', value: klingVersionIds.v1_6 },
  { label: 'V2', value: klingVersionIds.v2 },
  { label: 'V2.5 Turbo', value: klingVersionIds.v2_5_turbo },
  { label: 'V3', value: klingVersionIds.v3 },
  { label: 'V4', value: klingVersionIds.v4 },
];

const klingAspectRatios = [
  { label: '16:9', value: '16:9', width: 1280, height: 720 },
  { label: '1:1', value: '1:1', width: 1024, height: 1024 },
  { label: '9:16', value: '9:16', width: 720, height: 1280 },
];

const klingModes = [
  { label: 'Standard', value: 'standard' },
  { label: 'Professional', value: 'professional' },
] as const;

const klingDurations = [
  { label: '5 seconds', value: '5' },
  { label: '10 seconds', value: '10' },
] as const;

export type KlingVersion = 'legacy' | 'v3' | 'v4';

export type KlingV3Operation = 'text-to-video' | 'image-to-video' | 'reference-to-video';

function getV3Operation(workflow: string): KlingV3Operation {
  if (workflow === 'img2vid:ref2vid') return 'reference-to-video';
  if (workflow.startsWith('img2vid')) return 'image-to-video';
  return 'text-to-video';
}

export { klingVersionIds };

type KlingExt = FamilyExt & { model?: ResourceData };

const legacy = defineGraph<KlingExt>()
  .field(
    'images',
    workflowScoped(({ _ext }) =>
      !_ext.workflow.startsWith('txt') ? imagesDef({ warnOnMissingAiMetadata: true }) : null
    )
  )
  .field('seed', SEED)
  .field('enablePromptEnhancer', boolDef(true))
  .use(textBlock)
  .field('aspectRatio', ({ _ext }) =>
    _ext.workflow !== 'img2vid'
      ? aspectRatioDef({ options: klingAspectRatios, default: '1:1' })
      : null
  )
  .field('mode', ({ _ext }) =>
    modelIdOf(_ext.model) === klingVersionIds.v1_6
      ? {
          input: z.enum(['standard', 'professional']).optional(),
          output: z.enum(['standard', 'professional']),
          default: 'standard' as const,
          correct: optionFallback(['standard', 'professional'] as const, 'standard'),
          meta: { options: klingModes },
        }
      : null
  )
  // scoped per version arm: legacy's STRING enum and v3's number range share
  // this address in one family bucket — either value fails the other's schema
  .field('duration', { ...enumDef({ options: klingDurations, default: '5' }), scope: 'legacy' })
  .field(
    'cfgScale',
    sliderDef({
      min: 0.1,
      max: 1,
      step: 0.1,
      default: 0.5,
      presets: [
        { label: 'Low', value: 0.3 },
        { label: 'Medium', value: 0.5 },
        { label: 'High', value: 0.7 },
      ],
    })
  );

const V3_DURATION = refusingRangeDef({ min: 5, max: 15, default: 5 });

const v3 = defineGraph<KlingExt>()
  .computed('operation', ({ _ext }) => getV3Operation(_ext.workflow))
  .field(
    'images',
    workflowScoped(({ _ext }) => {
      if (_ext.workflow.startsWith('img2vid') && _ext.workflow !== 'img2vid:ref2vid') {
        return imagesDef({
          slots: [{ label: 'Start Image', required: true }, { label: 'End Image' }],
          warnOnMissingAiMetadata: true,
        });
      }
      if (_ext.workflow === 'img2vid:ref2vid')
        return imagesDef({ max: 7, warnOnMissingAiMetadata: true });
      return null;
    })
  )
  .field('seed', SEED)
  .field('mode', enumDef({ options: klingModes, default: 'standard' }))
  .field('duration', { ...V3_DURATION, scope: 'v3' })
  .field('aspectRatio', ({ _ext }) =>
    _ext.workflow === 'txt2vid' || _ext.workflow === 'img2vid:ref2vid'
      ? aspectRatioDef({ options: klingAspectRatios, default: '1:1' })
      : null
  )
  .field('generateAudio', boolDef(false))
  .use(makeTextBlock({ negativePrompt: false, promptAlwaysRequired: true }));

export type KlingV4Operation =
  | 'textToVideo'
  | 'imageToVideo'
  | 'referenceToVideo'
  | 'videoToVideoEdit';

export const KLING_V4_EDIT_WORKFLOW = 'vid2vid:edit';
export const KLING_V4_MAX_VIDEO_ELEMENTS = 3;
export const KLING_V4_MAX_VOICES = 3;
export const KLING_V4_MAX_REFERENCES = 15;

function getV4Operation(workflow: string): KlingV4Operation {
  if (workflow === KLING_V4_EDIT_WORKFLOW) return 'videoToVideoEdit';
  if (workflow === 'img2vid:ref2vid') return 'referenceToVideo';
  if (workflow.startsWith('img2vid')) return 'imageToVideo';
  return 'textToVideo';
}

const klingV4AspectRatioList: GenerationAspectRatio[] = ['21:9', '16:9', '1:1', '9:16'];

const klingV4Resolutions = [
  { label: '720p', value: '720p' },
  { label: '1080p', value: '1080p' },
] as const;

const V4_AR = defFamily((resolution: string) =>
  aspectRatioDef({
    options: getAspectRatioOptions(resolution as '720p' | '1080p', klingV4AspectRatioList),
    default: '16:9',
  })
);

const V4_DURATION = refusingRangeDef({ min: 3, max: 30, default: 5 });

const videoSchema = z.object({
  url: z.string(),
  metadata: z
    .object({ fps: z.number(), width: z.number(), height: z.number(), duration: z.number() })
    .optional(),
});
const elementImageSchema = z.object({ url: z.string(), width: z.number(), height: z.number() });

const referenceVideosDef = defFamily((limit: number) => ({
  input: videoSchema
    .array()
    .max(limit)
    .optional()
    .transform((v) => v ?? []),
  output: videoSchema.array().max(limit, `Maximum ${limit} reference videos allowed`),
  default: [] as z.infer<typeof videoSchema>[],
  correct: (value: z.infer<typeof videoSchema>[] | undefined) =>
    (value?.length ?? 0) > limit
      ? { value: value!.slice(0, limit), reason: 'over_cap' }
      : undefined,
  meta: { limit },
}));

export type KlingV4Element = {
  /** The frontal image first, then one to three reference views. */
  images: z.infer<typeof elementImageSchema>[];
  video?: z.infer<typeof videoSchema>;
  voiceId?: string;
};

const elementSchema = z.object({
  images: elementImageSchema.array().max(4).default([]),
  video: videoSchema.optional(),
  voiceId: z.string().trim().min(1).optional().catch(undefined),
});

const isCompleteElement = (e: KlingV4Element) =>
  e.video ? e.images.length === 0 : e.images.length >= 2 && e.images.length <= 4;

export const KLING_V4_ELEMENTS_LIMIT = 7;

/** Rows that have neither images nor a video are dropped, so an empty row never blocks submit. */
const klingElementsDef = {
  input: elementSchema
    .array()
    .max(KLING_V4_ELEMENTS_LIMIT)
    .optional()
    .transform((v) => v ?? []),
  output: z.preprocess(
    (arr) =>
      Array.isArray(arr)
        ? (arr as KlingV4Element[]).filter((e) => e.video || e.images?.length)
        : arr,
    (elementSchema as unknown as z.ZodType<KlingV4Element>)
      .array()
      .max(KLING_V4_ELEMENTS_LIMIT, `Maximum ${KLING_V4_ELEMENTS_LIMIT} elements allowed`)
      .refine(
        (entries) => entries.every(isCompleteElement),
        'Each element needs a frontal image with 1-3 reference images, or a video'
      )
      .refine(
        (entries) => entries.filter((e) => e.video).length <= KLING_V4_MAX_VIDEO_ELEMENTS,
        `At most ${KLING_V4_MAX_VIDEO_ELEMENTS} elements can use a video`
      )
  ),
  default: [] as KlingV4Element[],
  correct: (value: KlingV4Element[] | undefined) =>
    (value?.length ?? 0) > KLING_V4_ELEMENTS_LIMIT
      ? { value: value!.slice(0, KLING_V4_ELEMENTS_LIMIT), reason: 'over_cap' }
      : undefined,
  meta: { limit: KLING_V4_ELEMENTS_LIMIT },
};

const voiceIdsBase = {
  input: z
    .string()
    .trim()
    .array()
    .optional()
    .transform((v) => (v ?? []).filter(Boolean)),
  output: z.string().min(1).array().max(KLING_V4_MAX_VOICES),
  default: [] as string[],
  correct: (value: string[] | undefined) =>
    (value?.length ?? 0) > KLING_V4_MAX_VOICES
      ? { value: value!.slice(0, KLING_V4_MAX_VOICES), reason: 'over_cap' }
      : undefined,
  meta: { limit: KLING_V4_MAX_VOICES },
};

export type KlingV4Shot = { prompt: string; duration: number };

const shotSchema = z.object({
  prompt: z.string().max(512),
  duration: z.coerce.number().int().min(1).max(30),
});

/** Generation-only multi-shot prompts; their durations replace the duration slider. */
const multiShotDef = {
  input: shotSchema
    .array()
    .optional()
    .transform((v) => v ?? []),
  output: shotSchema
    .array()
    .refine((shots) => shots.every((s) => s.prompt.trim().length > 0), 'Every shot needs a prompt')
    .refine((shots) => {
      if (!shots.length) return true;
      const total = shots.reduce((sum, s) => sum + s.duration, 0);
      return total >= 3 && total <= 30;
    }, 'Shot durations must add up to 3-30 seconds'),
  default: [] as KlingV4Shot[],
  correct: (value: KlingV4Shot[] | undefined) => {
    if (!value?.some((s) => s.duration < 1 || s.duration > 30 || !Number.isInteger(s.duration)))
      return undefined;
    return {
      value: value.map((s) => ({
        ...s,
        duration: Math.min(30, Math.max(1, Math.round(s.duration))),
      })),
      reason: 'out_of_range',
    };
  },
};

const isEdit = (workflow: string) => workflow === KLING_V4_EDIT_WORKFLOW;
const takesReferences = (workflow: string) => workflow === 'img2vid:ref2vid' || isEdit(workflow);

/** Everything the backend counts toward its 15-reference cap. */
export function countKlingV4References(data: {
  workflow: string;
  images?: unknown[];
  middleImages?: unknown[];
  referenceVideos?: unknown[];
  klingElements?: unknown[];
  voiceIds?: unknown[];
}) {
  return (
    (data.images?.length ?? 0) +
    (data.middleImages?.length ?? 0) +
    (data.referenceVideos?.length ?? 0) +
    (isEdit(data.workflow) ? 1 : 0) +
    (data.klingElements?.length ?? 0) +
    (data.voiceIds?.length ?? 0)
  );
}

const v4 = defineGraph<KlingExt>()
  .computed('operation', ({ _ext }) => getV4Operation(_ext.workflow))
  .field(
    'images',
    workflowScoped(({ _ext }) => {
      if (takesReferences(_ext.workflow))
        return imagesDef({ min: 0, max: 10, warnOnMissingAiMetadata: !isEdit(_ext.workflow) });
      if (_ext.workflow.startsWith('img2vid'))
        return imagesDef({
          slots: [{ label: 'Start Image', required: true }, { label: 'End Image' }],
          warnOnMissingAiMetadata: true,
        });
      return null;
    })
  )
  .field(
    'middleImages',
    workflowScoped(({ _ext }) =>
      _ext.workflow.startsWith('img2vid') && !takesReferences(_ext.workflow)
        ? imagesDef({ min: 0, max: 8 })
        : null
    )
  )
  .field(
    'video',
    workflowScoped(({ _ext }) => (isEdit(_ext.workflow) ? VIDEO : null))
  )
  .field(
    'referenceVideos',
    workflowScoped(({ _ext }) =>
      takesReferences(_ext.workflow) ? referenceVideosDef(isEdit(_ext.workflow) ? 4 : 5) : null
    )
  )
  .field(
    'klingElements',
    workflowScoped(({ _ext }) => (takesReferences(_ext.workflow) ? klingElementsDef : null))
  )
  .field(
    'voiceIds',
    workflowScoped(({ images, referenceVideos, klingElements, _ext }) => {
      if (!takesReferences(_ext.workflow)) return null;
      const elementVoices = (klingElements ?? []).filter((e) => e.voiceId).length;
      const others = countKlingV4References({
        workflow: _ext.workflow,
        images,
        referenceVideos,
        klingElements,
      });
      return {
        ...voiceIdsBase,
        refine: (output: typeof voiceIdsBase.output) =>
          output
            .refine(
              (ids) => ids.length + elementVoices <= KLING_V4_MAX_VOICES,
              `At most ${KLING_V4_MAX_VOICES} voices, including those on elements`
            )
            .refine(
              (ids) => ids.length + others <= KLING_V4_MAX_REFERENCES,
              `At most ${KLING_V4_MAX_REFERENCES} references in total, counting images, videos, elements and voices`
            ),
      };
    })
  )
  .field('multiShot', ({ _ext }) =>
    isEdit(_ext.workflow) ? null : { ...multiShotDef, scope: 'v4' }
  )
  .field('resolution', enumDef({ options: klingV4Resolutions, default: '720p' }))
  .field('aspectRatio', ({ resolution, _ext }) =>
    _ext.workflow === 'txt2vid' || _ext.workflow === 'img2vid:ref2vid'
      ? V4_AR(resolution ?? '720p')
      : null
  )
  .field('duration', ({ multiShot, _ext }) =>
    isEdit(_ext.workflow) || multiShot?.length ? null : { ...V4_DURATION, scope: 'v4' }
  )
  .use(
    makeTextBlock({
      negativePrompt: false,
      promptAlwaysRequired: true,
      promptOptional: (ext) => !!(ext as { multiShot?: unknown[] }).multiShot?.length,
    })
  );

/** Tagged: the picked key is stamped into state as `klingVersion`. */
const versions = branch(
  'klingVersion',
  (ext: KlingExt): KlingVersion => {
    const id = modelIdOf(ext.model);
    if (id === klingVersionIds.v4) return 'v4';
    return id === klingVersionIds.v3 ? 'v3' : 'legacy';
  },
  { legacy, v3, v4 }
);

export const kling = defineGraph<FamilyExt>({ scope: familyScope })
  .field('model', ({ _ext }) => {
    const base = checkpointDef({
      ecosystem: _ext.ecosystem,
      workflow: _ext.workflow,
      ext: _ext,
      versions: { options: klingVersionOptions },
      defaultModelId: klingVersionIds.v2_5_turbo,
    });
    return {
      ...base,
      correct: (value: ResourceData | undefined) => {
        // ref2vid exists only on V3 and V4, edits only on V4 — the workflow wins
        if (_ext.workflow === KLING_V4_EDIT_WORKFLOW && value?.id !== klingVersionIds.v4) {
          return {
            value: { id: klingVersionIds.v4, model: { type: 'Checkpoint' } } as ResourceData,
            reason: 'edit_requires_v4',
          };
        }
        if (
          _ext.workflow === 'img2vid:ref2vid' &&
          value?.id !== klingVersionIds.v3 &&
          value?.id !== klingVersionIds.v4
        ) {
          return {
            value: { id: klingVersionIds.v3, model: { type: 'Checkpoint' } } as ResourceData,
            reason: 'ref2vid_requires_v3',
          };
        }
        return base.correct?.(value);
      },
    };
  })
  .use(versions);

export {
  klingVersionOptions,
  klingAspectRatios,
  klingModes,
  klingDurations,
  klingV4AspectRatioList,
  klingV4Resolutions,
};
