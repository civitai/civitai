import { describe, expect, it } from 'vitest';
import { trainingServiceStatusSchema } from '~/server/schema/training.schema';
import { trainingModelInfo } from '~/utils/training';
import { mergeBlockedModels, modelUnavailability } from '~/utils/training-blocked-models';

const isBaseModelKey = (key: string) => Object.hasOwn(trainingModelInfo, key);
const customAir = 'urn:air:sd1:checkpoint:civitai:53761@285757';

describe('mergeBlockedModels', () => {
  it('replaces the blocked base models and keeps blocked custom-model AIRs', () => {
    expect(
      mergeBlockedModels(
        [customAir, 'sdxl'],
        { blockedModels: ['krea2'], blockedModelReasons: { krea2: ' Outage. ', sdxl: 'stale' } },
        isBaseModelKey
      )
    ).toEqual({ blockedModels: [customAir, 'krea2'], blockedModelReasons: { krea2: 'Outage.' } });
  });

  it('unblocks every base model when the list is empty', () => {
    expect(mergeBlockedModels([customAir, 'krea2'], { blockedModels: [] }, isBaseModelKey)).toEqual(
      { blockedModels: [customAir], blockedModelReasons: {} }
    );
  });
});

describe('training status with blocked models', () => {
  it('keeps the blocks when the notes are malformed, and shows no note', () => {
    const status = trainingServiceStatusSchema.parse({
      blockedModels: ['krea2'],
      blockedModelReasons: 'not an object',
    });
    expect(status.blockedModels).toEqual(['krea2']);
    expect(modelUnavailability(status, 'krea2')).toEqual({ reason: null });
    expect(modelUnavailability(status, 'sdxl')).toBeNull();
  });

  it('carries a note for its model only', () => {
    const status = trainingServiceStatusSchema.parse({
      blockedModels: ['krea2'],
      blockedModelReasons: { krea2: 'Provider outage.', sdxl: 'ignored' },
    });
    expect(modelUnavailability(status, 'krea2')).toEqual({ reason: 'Provider outage.' });
    expect(modelUnavailability(status, 'sdxl')).toBeNull();
  });
});
