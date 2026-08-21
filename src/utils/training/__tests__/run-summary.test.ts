import { describe, expect, it } from 'vitest';
import type { TrainingDetailsObj } from '~/server/schema/model-version.schema';
import { summarizeTrainingRun, trainingArchitectureKey } from '~/utils/training/run-summary';
import { trainingModelInfo } from '~/utils/training';

const details = (over: Record<string, unknown>) => over as unknown as TrainingDetailsObj;

const labels = (d: Parameters<typeof summarizeTrainingRun>[0]) =>
  summarizeTrainingRun(d).rows.map((r) => r.label);
const valueOf = (d: Parameters<typeof summarizeTrainingRun>[0], label: string) =>
  summarizeTrainingRun(d).rows.find((r) => r.label === label)?.value;

describe('trainingArchitectureKey', () => {
  it('distinguishes base models that share a family', () => {
    const keyFor = (baseModel: string) =>
      trainingArchitectureKey(details({ baseModel, baseModelType: 'sdxl' }));

    expect(keyFor('pony')).toBe('pony');
    expect(keyFor('illustrious')).toBe('illustrious');
    expect(new Set(['pony', 'illustrious', 'sdxl'].map(keyFor)).size).toBe(3);
  });

  it('falls back to the family for a custom-AIR base with no short name', () => {
    expect(
      trainingArchitectureKey(details({ baseModel: 'civitai:1@2', baseModelType: 'flux' }))
    ).toBe('flux');
  });

  it('is null when the run records neither', () => {
    expect(trainingArchitectureKey(details({}))).toBeNull();
    expect(trainingArchitectureKey(undefined)).toBeNull();
  });
});

describe('summarizeTrainingRun', () => {
  it('prefers epochs over maxTrainEpochs when a run carries both', () => {
    const d = details({ params: { engine: 'ai-toolkit', epochs: 10, maxTrainEpochs: 99 } });
    expect(valueOf(d, 'Epochs')).toBe('10');
  });

  it('reads the AI Toolkit parameter names', () => {
    const d = details({
      baseModel: 'krea2',
      baseModelType: 'krea2',
      params: { engine: 'ai-toolkit', steps: 2000, epochs: 10, batchSize: 1, lr: 0.0001 },
    });

    expect(valueOf(d, 'Steps')).toBe('2000');
    expect(valueOf(d, 'Epochs')).toBe('10');
    expect(valueOf(d, 'Batch size')).toBe('1');
    expect(valueOf(d, 'Learning rate')).toBe('0.0001');
  });

  it('reads the Kohya parameter names for the same rows', () => {
    const d = details({
      baseModel: 'sdxl',
      baseModelType: 'sdxl',
      params: {
        engine: 'kohya',
        targetSteps: 1500,
        maxTrainEpochs: 20,
        trainBatchSize: 4,
        unetLR: 0.0005,
      },
    });

    expect(valueOf(d, 'Steps')).toBe('1500');
    expect(valueOf(d, 'Epochs')).toBe('20');
    expect(valueOf(d, 'Batch size')).toBe('4');
    expect(valueOf(d, 'Learning rate')).toBe('0.0005');
  });

  it('prefers the human-readable base model name over the key', () => {
    const { architecture } = summarizeTrainingRun(
      details({ baseModel: 'sdxl', baseModelType: 'sdxl' })
    );

    expect(architecture).toBe(trainingModelInfo.sdxl.pretty);
    expect(architecture).not.toBe('sdxl');
  });

  it('falls back to the type key when the base model is a custom AIR', () => {
    const d = details({ baseModel: 'civitai:123@456', baseModelType: 'flux' });
    expect(summarizeTrainingRun(d).architecture).toBe('flux');
  });

  it('omits rows the run has no value for', () => {
    const d = details({ baseModelType: 'sdxl', params: { engine: 'kohya' } });

    expect(labels(d)).toEqual(['Engine']);
  });

  it('survives a run with no params or details at all', () => {
    expect(summarizeTrainingRun(undefined).rows).toEqual([]);
    expect(summarizeTrainingRun(undefined).architecture).toBeNull();
    expect(summarizeTrainingRun(details({})).rows).toEqual([]);
  });

  it('surfaces the source epoch for a continuation', () => {
    const d = details({
      baseModelType: 'sdxl',
      continueFromEpoch: {
        air: 'urn:air:sdxl:lora:civitai:1@2',
        epochNumber: 10,
        sourceModelVersionId: 9,
      },
    });

    expect(summarizeTrainingRun(d).continuedFromEpoch).toBe(10);
  });
});
