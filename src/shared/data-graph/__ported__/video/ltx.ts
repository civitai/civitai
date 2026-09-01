import { branch, defFamily, defineGraph } from 'form-graph';
import { isWorkflowOrVariant } from '~/shared/data-graph/generation/config/workflows';
import {
  DISTILLED_IDS,
  ltxVersionOptions,
  ltxv2AspectRatios,
  ltxv2Durations,
  ltxv23AspectRatiosByResolution,
  ltxv23Resolutions,
  ltxv25AspectRatiosByResolution,
} from '~/shared/data-graph/generation/ltx-graph';
import { ltxVersionIds } from '~/shared/data-graph/generation/version-ids';
import { checkpointDef } from './checkpoint';
import {
  SEED,
  aspectRatioDef,
  boolDef,
  enumDef,
  imagesDef,
  resourcesDef,
  sliderDef,
  VIDEO,
  type ImageEntry,
} from './defs';
import { textBlock, type VideoExt } from './shared';

/**
 * LTX (LTXV2 + LTXV23 + LTXV25), ported from `ltx-graph.ts`.
 *
 * data-graph shape → form-graph shape:
 * - the parent's shared nodes become a `shared` graph every version mounts;
 * - `.computed('ltxVersion') + .discriminator('ltxVersion', {...})` becomes a
 *   TAGGED branch: the picked member key is stamped into state under
 *   `ltxVersion`, so the state union discriminates exactly as before;
 * - the checkpoint graph's ecosystem-switching effect becomes a rule on the hub.
 *
 * Tables and version ids are imported from the live graph — never copied — so
 * there is one source of truth while both systems coexist.
 */

const LTXV23_DEV_ID = ltxVersionIds.v23Dev;

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
const RESOURCES = defFamily((limit: number) => resourcesDef(limit));
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
const NUM_FRAMES = sliderDef({ min: 1, max: 120, step: 1, default: 24 });
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

const versionOf = (ecosystem: string) =>
  ecosystem === 'LTXV25' ? 'v25' : ecosystem === 'LTXV23' ? 'v23' : 'v2';

// ---- the parent's shared nodes, mounted first by every version --------------
const shared = defineGraph<VideoExt>()
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
    })
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
  .field('resources', ({ _ext }) => RESOURCES(_ext.limits.maxResources));

// ---- one graph per LTX version ---------------------------------------------
const v2 = defineGraph<VideoExt>()
  .use(shared)
  .field('aspectRatio', ({ _ext }) => (_ext.workflow !== 'img2vid' ? AR_V2 : null))
  .field('duration', DURATION_V2)
  .use(textBlock);

const v23 = defineGraph<VideoExt>()
  .use(shared)
  .field('video', ({ _ext }) =>
    _ext.workflow === 'vid2vid:edit' || _ext.workflow === 'vid2vid:extend' ? VIDEO : null
  )
  .field('resolution', RESOLUTION)
  .field('aspectRatio', ({ resolution, _ext }) =>
    _ext.workflow === 'txt2vid' || _ext.workflow === 'img2vid:ref2vid'
      ? AR_V23(resolution)
      : null
  )
  .field('duration', ({ resolution }) => DURATION(resolution))
  .field('cannyLowThreshold', ({ _ext }) => (_ext.workflow === 'vid2vid:edit' ? CANNY_LOW : null))
  .field('cannyHighThreshold', ({ _ext }) => (_ext.workflow === 'vid2vid:edit' ? CANNY_HIGH : null))
  .field('guideStrength', ({ _ext }) =>
    _ext.workflow === 'vid2vid:edit' ? GUIDE_STRENGTH : null
  )
  .field('numFrames', ({ _ext }) => (_ext.workflow === 'vid2vid:extend' ? NUM_FRAMES : null))
  .field('generateAudio', GENERATE_AUDIO)
  .use(textBlock);

const v25 = defineGraph<VideoExt>()
  .use(shared)
  .field('resolution', RESOLUTION)
  .field('aspectRatio', ({ resolution, _ext }) =>
    _ext.workflow === 'txt2vid' || _ext.workflow === 'img2vid:ref2vid'
      ? AR_V25(resolution)
      : null
  )
  .field('duration', ({ resolution }) => DURATION(resolution))
  .field('generateAudio', GENERATE_AUDIO)
  .use(textBlock);

export const ltx = branch('ltxVersion', (ext: VideoExt) => versionOf(ext.ecosystem), {
  v2,
  v23,
  v25,
});
