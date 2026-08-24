import { describe, expect, it } from 'vitest';
import {
  trainingEpochModelFileName,
  trainingEpochSampleFileName,
  trainingRunArchiveName,
} from '~/shared/utils/training-file-names';

const MODEL = 'My Cool Model!';

describe('training file names', () => {
  it('includes the architecture so multi-training outputs are self-describing', () => {
    expect(
      trainingEpochModelFileName({
        modelName: MODEL,
        versionId: 401,
        architecture: 'sdxl',
        epochNumber: 6,
      })
    ).toBe('My_Cool_Model__sdxl_401_epoch_6.safetensors');
  });

  it('omits the architecture segment for runs that predate it', () => {
    expect(trainingEpochModelFileName({ modelName: MODEL, versionId: 401, epochNumber: 6 })).toBe(
      'My_Cool_Model__401_epoch_6.safetensors'
    );
  });

  // Cumulative numbering only covers continuations; a fresh retrain restarts at epoch 1.
  it('keeps two runs of one model distinct at the same epoch and architecture', () => {
    const args = { modelName: MODEL, architecture: 'sdxl', epochNumber: 6 };

    expect(trainingEpochModelFileName({ ...args, versionId: 401 })).not.toBe(
      trainingEpochModelFileName({ ...args, versionId: 402 })
    );
  });

  // Model names reach 664 chars in prod; most filesystems reject a component over 255 bytes.
  it('stays within a filesystem-safe length for absurd names, without truncating the id', () => {
    const name = trainingEpochSampleFileName(
      {
        modelName: 'M'.repeat(664),
        versionId: 4029135,
        architecture: 'A'.repeat(64),
        epochNumber: 100,
        sampleNumber: 10,
      },
      '.jpeg'
    );

    expect(name.length).toBeLessThanOrEqual(255);
    expect(name).toContain('_4029135_');
  });

  // These names land in a Content-Disposition header, and `architecture` comes from an unvalidated
  // cast of the trainingDetails JSON.
  it('strips header-breaking characters from every user-controlled part', () => {
    const name = trainingEpochModelFileName({
      modelName: 'evil"\r\nX-Injected: 1',
      versionId: 401,
      architecture: 'sd\r\nxl"',
      epochNumber: 6,
    });

    expect(name).not.toMatch(/[\r\n"]/);
  });

  it('scopes samples and the run archive the same way as epoch models', () => {
    const run = { modelName: MODEL, versionId: 401 };

    expect(trainingEpochModelFileName({ ...run, epochNumber: 6 })).toBe(
      'My_Cool_Model__401_epoch_6.safetensors'
    );
    expect(trainingEpochSampleFileName({ ...run, epochNumber: 6, sampleNumber: 2 }, '.jpeg')).toBe(
      'My_Cool_Model__401_epoch_6_sample_2.jpeg'
    );
    expect(trainingRunArchiveName(run)).toBe('My_Cool_Model__401_training.zip');
  });
});
