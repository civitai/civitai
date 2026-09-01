import { z } from 'zod';
import { branch, defFamily, defineGraph, type FieldDef } from 'form-graph';
import { isWorkflowOrVariant } from '~/shared/data-graph/generation/config/workflows';
import { isWorkflowAvailable } from '~/shared/data-graph/generation/config';
import { ecosystemByKey } from '~/shared/constants/basemodel.constants';
import { checkpointDef, ecosystemKeyForBaseModel, type VersionGroup } from '../checkpoint';
import {
  SEED,
  aspectRatioDef,
  boolDef,
  enumDef,
  imagesDef,
  resourcesDef,
  sliderDef,
  VIDEO,
  type AspectRatioOption,
  type ImageEntry,
  type NumberMeta,
} from '../defs';
import { textBlock, type FamilyExt } from '../shared';

/**
 * LTX (LTXV2 + LTXV23 + LTXV25), ported from `ltx-graph.ts`.
 *
 * data-graph shape → form-graph shape:
 * - the parent's shared nodes become a `shared` graph every version mounts;
 * - `.computed('ltxVersion') + .discriminator('ltxVersion', {...})` becomes a
 *   TAGGED branch: the picked member key is stamped into state under
 *   `ltxVersion`, so the state union discriminates exactly as before;
 * - the checkpoint graph's ecosystem-switching effect becomes a rule on the hub.
 */

// ---- copied from ltx-graph.ts / version-ids.ts, which die with the engine ----

const LTXV2_DEV_ID = 2578325;
const LTXV2_DISTILLED_ID = 2600562;
const LTXV23_DEV_ID = 2749908;
const LTXV23_DISTILLED_ID = 2749948;
const LTXV25_DEV_ID = 3220143;
const LTXV25_DISTILLED_ID = 3220250;
/** Sulphur 2 — routes through the LTXV23 ecosystem with a diffusionModel AIR override. */
const SULPHUR2_DEV_ID = 2921800;
const SULPHUR2_DISTILLED_ID = 2923808;

/** Set of all distilled version IDs (across every LTX ecosystem) */
const DISTILLED_IDS = new Set<number>([
  LTXV2_DISTILLED_ID,
  LTXV23_DISTILLED_ID,
  LTXV25_DISTILLED_ID,
  SULPHUR2_DISTILLED_ID,
]);

/**
 * Registered base model names — must match `baseModelRecords` entries; the
 * checkpoint graph resolves an option's ecosystem via `baseModelByName`.
 */
const LTXV2_BASE_MODEL = 'LTXV2';
const LTXV23_BASE_MODEL = 'LTXV 2.3';
const LTXV25_BASE_MODEL = 'LTXV 2.5';

/**
 * Hierarchical version options: top level LTX version (plus the Sulphur 2
 * fine-tune), second level variant (Dev / Distilled).
 */
const ltxVersionOptions: VersionGroup = {
  label: 'Version',
  options: [
    {
      label: '2.0',
      value: LTXV2_DEV_ID,
      baseModel: LTXV2_BASE_MODEL,
      children: {
        label: 'Variant',
        options: [
          { label: '19B Dev', value: LTXV2_DEV_ID, baseModel: LTXV2_BASE_MODEL },
          { label: '19B Distilled', value: LTXV2_DISTILLED_ID, baseModel: LTXV2_BASE_MODEL },
        ],
      },
    },
    {
      label: '2.3',
      value: LTXV23_DEV_ID,
      baseModel: LTXV23_BASE_MODEL,
      children: {
        label: 'Variant',
        options: [
          { label: 'Dev', value: LTXV23_DEV_ID, baseModel: LTXV23_BASE_MODEL },
          { label: 'Distilled', value: LTXV23_DISTILLED_ID, baseModel: LTXV23_BASE_MODEL },
        ],
      },
    },
    {
      label: '2.5',
      value: LTXV25_DEV_ID,
      baseModel: LTXV25_BASE_MODEL,
      children: {
        label: 'Variant',
        options: [
          { label: '22B Dev', value: LTXV25_DEV_ID, baseModel: LTXV25_BASE_MODEL },
          { label: '22B Distilled', value: LTXV25_DISTILLED_ID, baseModel: LTXV25_BASE_MODEL },
        ],
      },
    },
    {
      label: 'Sulphur 2',
      value: SULPHUR2_DEV_ID,
      baseModel: LTXV23_BASE_MODEL,
      children: {
        label: 'Variant',
        options: [
          { label: 'Dev', value: SULPHUR2_DEV_ID, baseModel: LTXV23_BASE_MODEL },
          { label: 'Distilled', value: SULPHUR2_DISTILLED_ID, baseModel: LTXV23_BASE_MODEL },
        ],
      },
    },
  ],
};

const ltxv2AspectRatios: AspectRatioOption[] = [
  { label: '16:9', value: '16:9', width: 848, height: 480 },
  { label: '3:2', value: '3:2', width: 720, height: 480 },
  { label: '1:1', value: '1:1', width: 512, height: 512 },
  { label: '2:3', value: '2:3', width: 480, height: 720 },
  { label: '9:16', value: '9:16', width: 480, height: 848 },
];

const ltxv2Durations = [
  { label: '3 seconds', value: 3 },
  { label: '5 seconds', value: 5 },
  { label: '7 seconds', value: 7 },
];

const ltxv23AspectRatiosByResolution: Record<string, AspectRatioOption[]> = {
  '720p': [
    { label: '16:9', value: '16:9', width: 1280, height: 720 },
    { label: '3:2', value: '3:2', width: 1176, height: 784 },
    { label: '1:1', value: '1:1', width: 960, height: 960 },
    { label: '2:3', value: '2:3', width: 784, height: 1176 },
    { label: '9:16', value: '9:16', width: 720, height: 1280 },
  ],
  '1080p': [
    { label: '16:9', value: '16:9', width: 1920, height: 1080 },
    { label: '3:2', value: '3:2', width: 1764, height: 1176 },
    { label: '1:1', value: '1:1', width: 1440, height: 1440 },
    { label: '2:3', value: '2:3', width: 1176, height: 1764 },
    { label: '9:16', value: '9:16', width: 1080, height: 1920 },
  ],
};

const ltxv23Resolutions = [
  { label: '720p', value: '720p' },
  { label: '1080p', value: '1080p' },
];

// same table as v23 in the source (declared separately there too)
const ltxv25AspectRatiosByResolution: Record<string, AspectRatioOption[]> =
  ltxv23AspectRatiosByResolution;

// ---- end of ltx-graph.ts copies ---------------------------------------------

/** Aspect-ratio option sets vary per resolution; memoize per resolution key. */
const AR_V23 = defFamily((resolution: string) =>
  aspectRatioDef({
    options: ltxv23AspectRatiosByResolution[resolution] ?? ltxv23AspectRatiosByResolution['720p']!,
    default: '16:9',
  })
);
const AR_V25 = defFamily((resolution: string) =>
  aspectRatioDef({
    options: ltxv25AspectRatiosByResolution[resolution] ?? ltxv25AspectRatiosByResolution['720p']!,
    default: '16:9',
  })
);
const AR_V2 = aspectRatioDef({ options: ltxv2AspectRatios, default: '16:9' });
const RESOLUTION = enumDef({ options: ltxv23Resolutions, default: '720p' });
const DURATION_V2 = enumDef({ options: ltxv2Durations, default: 5 });

/** ltx-graph.ts: max duration per resolution (same table for v23 and v25). */
const maxDurationByResolution: Record<string, number> = { '720p': 20, '1080p': 15 };
const DURATION = defFamily((resolution: string) =>
  sliderDef({ min: 3, max: maxDurationByResolution[resolution] ?? 20, step: 1, default: 5 })
);

const CANNY_LOW = sliderDef({
  min: 0,
  max: 1,
  step: 0.01,
  default: 0.1,
  presets: [
    { label: 'Low', value: 0.05 },
    { label: 'Medium', value: 0.1 },
    { label: 'High', value: 0.2 },
  ],
});
const CANNY_HIGH = sliderDef({
  min: 0,
  max: 1,
  step: 0.01,
  default: 0.3,
  presets: [
    { label: 'Low', value: 0.15 },
    { label: 'Medium', value: 0.3 },
    { label: 'High', value: 0.5 },
  ],
});
const GUIDE_STRENGTH = sliderDef({
  min: 0,
  max: 1,
  step: 0.05,
  default: 0.7,
  presets: [
    { label: 'Subtle', value: 0.3 },
    { label: 'Moderate', value: 0.7 },
    { label: 'Strong', value: 1 },
  ],
});
// hand-written in ltx-graph.ts: out-of-range REFUSES (falls to default), no snap
const NUM_FRAMES: FieldDef<number, NumberMeta> = {
  input: z.coerce.number().min(1).max(120).optional(),
  output: z.number().min(1).max(120),
  default: 24,
  meta: { min: 1, max: 120, step: 1 },
};
const GENERATE_AUDIO = boolDef(true);
const CFG = sliderDef({
  min: 1,
  max: 10,
  step: 0.5,
  default: 3,
  presets: [
    { label: 'Low', value: 2 },
    { label: 'Balanced', value: 3 },
    { label: 'High', value: 5 },
  ],
});
const STEPS = sliderDef({
  min: 10,
  max: 50,
  default: 30,
  presets: [
    { label: 'Fast', value: 20 },
    { label: 'Balanced', value: 30 },
    { label: 'Quality', value: 50 },
  ],
});
const FRAME_GUIDE = sliderDef({
  min: 0,
  max: 1,
  step: 0.05,
  default: 1,
  presets: [
    { label: 'Subtle', value: 0.3 },
    { label: 'Moderate', value: 0.6 },
    { label: 'Strong', value: 1 },
  ],
});

/** ltx-graph.ts `sharedAspectRatioValues` — upload-time ratio hints. */
const sharedAspectRatioValues = ['16:9', '3:2', '1:1', '2:3', '9:16'];

const isFirstLast = (workflow: string) =>
  isWorkflowOrVariant(workflow, 'img2vid') && workflow !== 'img2vid:ref2vid';

const versionOf = (ecosystem: string) => {
  switch (ecosystem) {
    case 'LTXV25':
      return 'v25' as const;
    case 'LTXV23':
      return 'v23' as const;
    case 'LTXV2':
    default:
      return 'v2' as const;
  }
};

// ---- the parent's shared nodes, mounted first by every version --------------
const shared = defineGraph<FamilyExt>()
  .field('images', ({ _ext }) => {
    if (isFirstLast(_ext.workflow)) {
      return imagesDef({
        slots: [{ label: 'First Frame', required: true }, { label: 'Last Frame (optional)' }],
        warnOnMissingAiMetadata: true,
        aspectRatios: sharedAspectRatioValues,
      });
    }
    if (_ext.workflow === 'img2vid:ref2vid') {
      return imagesDef({ warnOnMissingAiMetadata: true });
    }
    return null;
  })
  .field('model', ({ _ext }) =>
    checkpointDef({
      ecosystem: _ext.ecosystem,
      workflow: _ext.workflow,
      ext: _ext,
      versions: ltxVersionOptions,
      defaultModelId: LTXV23_DEV_ID,
      modelWins: true,
    })
  )
  // LTX is unlocked and its version options carry baseModel precisely so a
  // model choice drags the ecosystem (v1's checkpoint effect) — same split as
  // image/sd.ts. The version BRANCH still picks on the selection; a
  // cross-version model where the versions' field sets differ is part of the
  // open cross-branch re-pick decision (see the plan doc).
  .computed(
    'effectiveEcosystem',
    ({ model, _ext }) => {
      const modelEco = model?.baseModel ? ecosystemKeyForBaseModel(model.baseModel) : undefined;
      if (!modelEco || modelEco === _ext.ecosystem) return _ext.ecosystem;
      const target = ecosystemByKey.get(modelEco);
      return target && isWorkflowAvailable(_ext.workflow, target.id) ? modelEco : _ext.ecosystem;
    },
    { emit: 'ecosystem' }
  )
  .field('seed', SEED)
  // cfgScale + steps are hidden for distilled checkpoints
  .field('cfgScale', ({ model }) => (DISTILLED_IDS.has(model?.id ?? -1) ? null : CFG))
  .field('steps', ({ model }) => (DISTILLED_IDS.has(model?.id ?? -1) ? null : STEPS))
  .field('frameGuideStrength', ({ images, _ext }) =>
    isFirstLast(_ext.workflow) && (images as ImageEntry[] | undefined)?.length === 2
      ? FRAME_GUIDE
      : null
  )
  .field('resources', ({ effectiveEcosystem, _ext }) =>
    resourcesDef({ ecosystem: effectiveEcosystem, limit: _ext.limits.maxResources })
  );

// ---- one graph per LTX version ---------------------------------------------
const v2 = defineGraph<FamilyExt>()
  .use(shared)
  .field('aspectRatio', ({ _ext }) => (_ext.workflow !== 'img2vid' ? AR_V2 : null))
  .field('duration', DURATION_V2)
  .use(textBlock);

const v23 = defineGraph<FamilyExt>()
  .use(shared)
  .field('video', ({ _ext }) =>
    _ext.workflow === 'vid2vid:edit' || _ext.workflow === 'vid2vid:extend' ? VIDEO : null
  )
  .field('resolution', RESOLUTION)
  .field('aspectRatio', ({ resolution, _ext }) =>
    _ext.workflow === 'txt2vid' || _ext.workflow === 'img2vid:ref2vid' ? AR_V23(resolution) : null
  )
  .field('duration', ({ resolution }) => DURATION(resolution))
  .field('cannyLowThreshold', ({ _ext }) => (_ext.workflow === 'vid2vid:edit' ? CANNY_LOW : null))
  .field('cannyHighThreshold', ({ _ext }) => (_ext.workflow === 'vid2vid:edit' ? CANNY_HIGH : null))
  .field('guideStrength', ({ _ext }) => (_ext.workflow === 'vid2vid:edit' ? GUIDE_STRENGTH : null))
  .field('numFrames', ({ _ext }) => (_ext.workflow === 'vid2vid:extend' ? NUM_FRAMES : null))
  .field('generateAudio', GENERATE_AUDIO)
  .use(textBlock);

const v25 = defineGraph<FamilyExt>()
  .use(shared)
  .field('resolution', RESOLUTION)
  .field('aspectRatio', ({ resolution, _ext }) =>
    _ext.workflow === 'txt2vid' || _ext.workflow === 'img2vid:ref2vid' ? AR_V25(resolution) : null
  )
  .field('duration', ({ resolution }) => DURATION(resolution))
  .field('generateAudio', GENERATE_AUDIO)
  .use(textBlock);

export const ltx = branch('ltxVersion', (ext: FamilyExt) => versionOf(ext.ecosystem), {
  v2,
  v23,
  v25,
});
