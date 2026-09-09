import { describe, expect, it } from 'vitest';

import { getTrainedFileDefaultName, resolveTrainedFileName } from '~/utils/file-display-helpers';

const jobIdFile = 'X40F7C8WA9TN0XW80MTTCT2TT0.safetensors';

describe('getTrainedFileDefaultName', () => {
  it('names the file after the model, not the version', () => {
    expect(
      getTrainedFileDefaultName({
        modelName: 'BB Bunny',
        versionName: 'V1',
        fileName: jobIdFile,
      })
    ).toBe('bbBunny_v1.safetensors');
  });

  it('keeps the version detail that distinguishes two downloads of one model', () => {
    expect(
      getTrainedFileDefaultName({
        modelName: 'ginger anima photoreal male',
        versionName: 'V1 (from epoch 10)',
        fileName: jobIdFile,
      })
    ).toBe('gingerAnimaPhotoreal_v1FromEpoch10.safetensors');
  });

  it('drops the version segment when it only repeats the model name', () => {
    expect(
      getTrainedFileDefaultName({ modelName: 'Grace', versionName: 'Grace', fileName: jobIdFile })
    ).toBe('grace.safetensors');
    expect(
      getTrainedFileDefaultName({
        modelName: 'Beet Cookie',
        versionName: 'Beet Cookie',
        fileName: jobIdFile,
      })
    ).toBe('beetCookie.safetensors');
  });

  it('strips characters filenamize cannot represent', () => {
    expect(
      getTrainedFileDefaultName({
        modelName: 'Cure Sparkle/キュアスパークル(プリキュア)',
        versionName: 'V1',
        fileName: jobIdFile,
      })
    ).toBe('cureSparkle_v1.safetensors');
  });

  it('falls back to the stored name when the model name leaves nothing behind', () => {
    expect(
      getTrainedFileDefaultName({
        modelName: 'キュアスパークル',
        versionName: 'V1',
        fileName: jobIdFile,
      })
    ).toBe(jobIdFile);
  });

  it('preserves the stored extension', () => {
    expect(
      getTrainedFileDefaultName({
        modelName: 'BB Bunny',
        versionName: 'V1',
        fileName: 'X40F7C8WA9TN0XW80MTTCT2TT0.ckpt',
      })
    ).toBe('bbBunny_v1.ckpt');
  });

  it('defaults the extension when the stored name has none', () => {
    expect(
      getTrainedFileDefaultName({
        modelName: 'BB Bunny',
        versionName: 'V1',
        fileName: 'X40F7C8WA9TN0XW80MTTCT2TT0',
      })
    ).toBe('bbBunny_v1.safetensors');
  });
});

describe('resolveTrainedFileName', () => {
  const trained = {
    modelName: 'BB Bunny',
    versionName: 'V1',
    fileName: jobIdFile,
  };

  it('shows the computed default on a fresh trainer import', () => {
    expect(resolveTrainedFileName({ ...trained, editedName: null, overrideName: null })).toBe(
      'bbBunny_v1.safetensors'
    );
  });

  it('leaves a name the creator saved earlier alone', () => {
    expect(
      resolveTrainedFileName({
        ...trained,
        editedName: null,
        overrideName: 'MyOwnName.safetensors',
      })
    ).toBe('MyOwnName.safetensors');
  });

  it('lets the current edit win over both', () => {
    expect(
      resolveTrainedFileName({
        ...trained,
        editedName: 'typing.safetensors',
        overrideName: 'MyOwnName.safetensors',
      })
    ).toBe('typing.safetensors');
  });

  it('treats a cleared field as an edit rather than falling back', () => {
    expect(
      resolveTrainedFileName({ ...trained, editedName: '', overrideName: 'MyOwnName.safetensors' })
    ).toBe('');
  });
});
