import { describe, expect, it } from 'vitest';
import { blockTrainingBodySchema } from '~/server/schema/blocks/workflow.schema';
import { trainingBaseModelTypesImage, trainingModelInfo } from '~/utils/training';
import { resolveBlockTrainingRun } from '../block-training-quote.service';

/** An app's training submit is held to the same rollout flags as the training form: with a
 *  model's flag off, a non-moderator's run is refused. */

// The image entries the training form hides behind a rollout flag (TrainingSubmitModelSelect).
// HiDream O1 is not here: the app body's params schema has no hidream-o1 ecosystem, so its run
// never reaches resolution.
const ROLLOUT_FLAG_BY_MODEL: Record<string, string> = {
  qwen_image: 'qwenTraining',
  zimageturbo: 'zimageturboTraining',
  zimagebase: 'zimagebaseTraining',
  ernie: 'ernieTraining',
  anima: 'animaTraining',
  boogu: 'booguTraining',
  krea2: 'krea2Training',
  mageflow: 'mageflowTraining',
  flux2klein_4b: 'fluxTwoKleinTraining',
  flux2klein_9b: 'fluxTwoKleinTraining',
  ming: 'mingTraining',
  qwen21: 'qwen21Training',
};
const ALL_ON = Object.fromEntries(Object.values(ROLLOUT_FLAG_BY_MODEL).map((flag) => [flag, true]));

const resolve = (model: string, features: Record<string, boolean>) => {
  const { aiToolkit } = trainingModelInfo[model as keyof typeof trainingModelInfo];
  return () =>
    resolveBlockTrainingRun({
      body: blockTrainingBodySchema.parse({
        kind: 'training',
        items: [{ air: 'K1.jpeg', caption: 'a' }],
        engine: 'ai-toolkit',
        model,
        params: {
          engine: 'ai-toolkit',
          ecosystem: aiToolkit!.ecosystem,
          modelVariant: aiToolkit!.modelVariant,
          epochs: 5,
          steps: 1500,
          batchSize: 1,
          resolution: 1024,
          lr: 0.0001,
          textEncoderLr: null,
          trainTextEncoder: false,
          lrScheduler: 'cosine',
          optimizerType: 'adamw8bit',
          networkDim: 32,
          networkAlpha: 16,
          noiseOffset: null,
          minSnrGamma: 5,
          flipAugmentation: false,
          shuffleTokens: false,
          keepTokens: 0,
        },
        triggerWord: 'mychar',
        samplePrompts: ['mychar at the beach'],
      }),
      status: { available: true },
      features: { ...ALL_ON, ...features },
      isModerator: false,
    });
};

describe('resolveBlockTrainingRun rollout flags', () => {
  it('names a flag for every AI Toolkit-only image catalog entry', () => {
    const gated = Object.entries(trainingModelInfo)
      .filter(
        ([, info]) =>
          !info.disabled &&
          info.aiToolkit &&
          (trainingBaseModelTypesImage as readonly string[]).includes(info.type) &&
          !['sd15', 'sdxl', 'flux', 'sd35', 'chroma', 'flux2', 'hidream-o1'].includes(info.type)
      )
      .map(([key]) => key);
    expect(gated.sort()).toEqual(Object.keys(ROLLOUT_FLAG_BY_MODEL).sort());
  });

  it.each(Object.entries(ROLLOUT_FLAG_BY_MODEL))('refuses %s with %s off', (model, flag) => {
    expect(resolve(model, { [flag]: false })).toThrow(
      /^(?!AI Toolkit).* training is not currently enabled\.$/
    );
    // Control: the same run resolves with the flag on.
    expect(resolve(model, {})).not.toThrow();
  });
});
