import { describe, expect, it } from 'vitest';
import {
  baseModelById,
  baseModels,
  BM,
  isModelSupported,
} from '@civitai/shared/basemodel.constants';
import { ModelType } from '~/shared/utils/prisma/enums';
import { getFeatureFliptKey, type FeatureFlagKey } from '~/server/services/feature-flags.service';
import {
  audioSampleOverrideSchema,
  trainingDetailsObj,
  yue2SampleOverrideSchema,
} from '~/server/schema/model-version.schema';
import {
  aiToolkitBatchMax,
  aiToolkitStepDefault,
  enabledStudioModelFlags,
  getDefaultEngine,
  isAudioTrainingBaseType,
  studioModelFlagFeatures,
  trainingModelInfo,
} from '~/utils/training';
import {
  hostFlagKeys,
  MODEL_CARDS,
  PARAM_DEFAULTS,
} from '../../../apps/training-studio/src/lib/data/trainingModels';

const models = [
  ['qwen21', BM.Qwen21, 'image'],
  ['ming', BM.Ming, 'image'],
  ['yue2', BM.YuE2, 'audio'],
] as const;

describe.each(models)('%s training identity', (key, id, media) => {
  it('persists the base-model identity used to publish the trained LoRA', () => {
    const info = trainingModelInfo[key];
    expect(info.baseModel).toBe(baseModelById.get(id)?.name);
    expect(isModelSupported(id, 'training', ModelType.LORA)).toBe(true);
    expect(
      trainingDetailsObj.safeParse({
        baseModel: key,
        baseModelType: key,
        type: 'Style',
        mediaType: media,
      }).success
    ).toBe(true);
    expect(getDefaultEngine(key)).toBe('ai-toolkit');
    expect(aiToolkitBatchMax(key)).toBe(1);
    expect(aiToolkitStepDefault(key)).toBe(3000);
    expect(isAudioTrainingBaseType(key)).toBe(media === 'audio');
  });

  it('keeps Studio completion lookup on the same checkpoint and ecosystem', () => {
    const info = trainingModelInfo[key];
    const card = MODEL_CARDS.find((c) => c.type === key)!;
    expect(card.flagKey).toBe(`${key}-training`);
    expect(card.media).toBe(media);
    expect(card.versions[0]).toMatchObject({
      key,
      air: info.air,
      baseModel: info.baseModel,
      ecosystem: info.aiToolkit!.ecosystem,
    });
    expect(PARAM_DEFAULTS[key]).toMatchObject({
      batchSize: 1,
      networkDim: 32,
      networkAlpha: 32,
      textEncoderLr: 0,
      lrScheduler: 'constant',
    });
  });
});

describe('Training Studio embed model gates', () => {
  it('maps every Studio gate to a feature flag the host can evaluate', () => {
    expect(Object.keys(studioModelFlagFeatures).sort()).toEqual(hostFlagKeys().sort());
  });

  it('asks Flipt the same key the standalone Studio asks', () => {
    for (const [flagKey, feature] of Object.entries(studioModelFlagFeatures))
      expect(getFeatureFliptKey(feature)).toBe(flagKey);
  });

  it('hands the element only the gates whose feature is on', () => {
    expect(enabledStudioModelFlags({ audioTraining: true })).toEqual([]);
    expect(enabledStudioModelFlags({ trainingStudioAudioTraining: true })).toEqual([
      'training-studio-audio-training',
    ]);
  });
});

describe('YuE2 sample override validation', () => {
  it('drops stale ACE-Step fields when switching models', () => {
    expect(
      yue2SampleOverrideSchema.parse({ lyrics: 'Sing', duration: 30, steps: 32, bpm: 120, cfg: 7 })
    ).toEqual({ lyrics: 'Sing', duration: 30, steps: 32 });
  });

  it('enforces YuE2 step bounds without restricting ACE-Step', () => {
    expect(yue2SampleOverrideSchema.safeParse({ steps: 101 }).success).toBe(false);
    expect(yue2SampleOverrideSchema.safeParse({ steps: 100 }).success).toBe(true);
    expect(audioSampleOverrideSchema.safeParse({ steps: 101 }).success).toBe(true);
  });
});

// A trained version is written with this base model; a name outside the published list leaves the
// publish form's base-model select blank.
describe('trainer base models', () => {
  it.each(Object.entries(trainingModelInfo))('%s writes a published base model', (_, info) => {
    expect(baseModels).toContain(info.baseModel);
  });

  it.each(MODEL_CARDS.flatMap((card) => card.versions.map((version) => [version.key, version])))(
    'studio %s mirrors a published base model',
    (_, version) => {
      expect(baseModels).toContain(version.baseModel);
    }
  );
});

describe('Training Studio follows the classic trainer model flags', () => {
  // The main-app trainer's `features.<x>Training` tile/version gates (TrainingSubmitModelSelect)
  // that ask Flipt, by `trainingModelInfo` key. Studio must gate the same model with the same key.
  const CLASSIC_GATES: Record<string, FeatureFlagKey> = {
    krea2: 'krea2Training',
    boogu: 'booguTraining',
    mageflow: 'mageflowTraining',
    flux2klein_9b: 'fluxTwoKleinTraining',
    flux2klein_4b: 'fluxTwoKleinTraining',
    ernie: 'ernieTraining',
    hidream_o1: 'hidreamO1Training',
    anima: 'animaTraining',
    minimaxh3: 'minimaxh3Training',
    zimageturbo: 'zimageturboTraining',
    ltx25: 'ltx25Training',
    ltx23: 'ltx23Training',
    ming: 'mingTraining',
    qwen21: 'qwen21Training',
    yue2: 'yue2Training',
  };

  it.each(Object.entries(CLASSIC_GATES))('%s is gated in Studio by %s', (key, feature) => {
    const card = MODEL_CARDS.find((c) => c.versions.some((v) => v.key === key));
    const version = card?.versions.find((v) => v.key === key);
    const gates = [card?.flagKey, version?.flagKey].filter(Boolean);
    expect(gates).toContain(getFeatureFliptKey(feature));
  });

  // Open to everyone in Studio by product decision, though the classic trainer still gates them.
  it.each(['flux2_dev', 'zimagebase', 'ltx2'])('%s is open to everyone in Studio', (key) => {
    const card = MODEL_CARDS.find((c) => c.versions.some((v) => v.key === key))!;
    expect([card.flagKey, card.versions.find((v) => v.key === key)!.flagKey]).toEqual([
      undefined,
      undefined,
    ]);
  });
});

// `training:status.blockedModels` holds the classic trainer's `trainingDetails.baseModel` keys, and
// Training Studio matches them against its catalog's version keys. A Studio key that drifts from the
// classic key for the same checkpoint would make a block a silent no-op in Studio.
describe('blocked-model keys are shared by both trainers', () => {
  const classicByAir = new Map(
    Object.entries(trainingModelInfo).map(([key, info]) => [info.air, key] as const)
  );
  // Edit (pair) cards reuse a base's checkpoint under their own key; a submit resolves them by AIR.
  const shared = MODEL_CARDS.filter((c) => !c.retired && !c.pairs).flatMap((c) =>
    c.versions.filter((v) => classicByAir.has(v.air))
  );

  it('pins Krea 2 to the same key in both catalogs', () => {
    const studio = MODEL_CARDS.find((c) => c.type === 'krea2')!.versions[0]!;
    expect(classicByAir.get(studio.air)).toBe(studio.key);
  });

  it.each(shared.map((v) => [v.key, v.air] as const))(
    'Studio version %s uses the classic key for its checkpoint',
    (key, air) => {
      expect(classicByAir.get(air)).toBe(key);
    }
  );
});
