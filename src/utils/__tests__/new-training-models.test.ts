import { describe, expect, it } from 'vitest';
import { baseModelById, BM, isModelSupported } from '@civitai/shared/basemodel.constants';
import { ModelType } from '~/shared/utils/prisma/enums';
import {
  audioSampleOverrideSchema,
  trainingDetailsObj,
  yue2SampleOverrideSchema,
} from '~/server/schema/model-version.schema';
import {
  aiToolkitBatchMax,
  aiToolkitStepDefault,
  getDefaultEngine,
  isAudioTrainingBaseType,
  trainingModelInfo,
} from '~/utils/training';
import {
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
