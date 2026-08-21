import { describe, expect, it } from 'vitest';
import {
  trainingEpochModelFileName,
  trainingEpochSampleFileName,
  trainingRunArchiveName,
} from '~/shared/utils/training-file-names';

const MODEL = 'My Cool Model!';

describe('training file names', () => {
  it('distinguishes the same epoch number across two runs of one model', () => {
    const first = trainingEpochModelFileName({
      modelName: MODEL,
      versionName: 'V1',
      versionId: 401,
      epochNumber: 6,
    });
    const second = trainingEpochModelFileName({
      modelName: MODEL,
      versionName: 'V2 (from epoch 5)',
      versionId: 402,
      epochNumber: 6,
    });

    expect(first).not.toBe(second);
  });

  it('distinguishes two versions that share a name', () => {
    const args = { modelName: MODEL, versionName: 'V1', epochNumber: 6 };

    expect(trainingEpochModelFileName({ ...args, versionId: 401 })).not.toBe(
      trainingEpochModelFileName({ ...args, versionId: 402 })
    );
  });

  // Model names reach 664 chars in prod; most filesystems reject a component over 255 bytes.
  it('stays within a filesystem-safe length for absurd names, without truncating the id', () => {
    const name = trainingEpochSampleFileName(
      {
        modelName: 'M'.repeat(664),
        versionName: 'V'.repeat(296),
        versionId: 4029135,
        epochNumber: 100,
        sampleNumber: 10,
      },
      '.jpeg'
    );

    expect(name.length).toBeLessThanOrEqual(255);
    expect(name).toContain('-4029135_');
  });

  it('keeps long-named versions of the same model distinct', () => {
    const args = {
      modelName: 'M'.repeat(664),
      versionName: 'V'.repeat(296),
      epochNumber: 6,
    };

    expect(trainingEpochModelFileName({ ...args, versionId: 401 })).not.toBe(
      trainingEpochModelFileName({ ...args, versionId: 402 })
    );
  });

  it('still produces a usable name when the version name sanitizes away', () => {
    expect(
      trainingEpochModelFileName({
        modelName: MODEL,
        versionName: '!!!',
        versionId: 402,
        epochNumber: 6,
      })
    ).toBe('My_Cool_Model__402_epoch_6.safetensors');
  });

  it('scopes samples and the run archive the same way as epoch models', () => {
    const run = { modelName: MODEL, versionName: 'V1', versionId: 401 };

    expect(trainingEpochModelFileName({ ...run, epochNumber: 6 })).toBe(
      'My_Cool_Model__V1-401_epoch_6.safetensors'
    );
    expect(trainingEpochSampleFileName({ ...run, epochNumber: 6, sampleNumber: 2 }, '.jpeg')).toBe(
      'My_Cool_Model__V1-401_epoch_6_sample_2.jpeg'
    );
    expect(trainingRunArchiveName(run)).toBe('My_Cool_Model__V1-401_training.zip');
  });
});
