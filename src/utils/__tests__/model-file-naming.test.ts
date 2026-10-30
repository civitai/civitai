import { describe, expect, it } from 'vitest';

import { ModelType } from '~/shared/utils/prisma/enums';
import { resolveModelFileName } from '~/utils/model-file-naming';

const jobIdName = 'X40F7C8WA9TN0XW80MTTCT2TT0.safetensors';

const checkpoint = { name: 'Realistic Vision', type: ModelType.Checkpoint };
const lora = { name: 'BB Bunny', type: ModelType.LORA };

describe('resolveModelFileName', () => {
  describe('variants on one version', () => {
    // The two files behind the download picker on Realistic Vision V5.1 Hyper: same type, same fp,
    // distinguished only by metadata.size. Both used to resolve to one name, so downloading both
    // left the user with a single file.
    const version = { name: 'V5.1 Hyper (VAE)' };
    const full = {
      id: 1,
      name: 'Realistic_Vision_V5.1_Hyper.safetensors',
      type: 'Model',
      metadata: { size: 'full', fp: 'fp16' },
    };
    const pruned = {
      id: 2,
      name: 'Realistic_Vision_V5.1_Hyper_pruned.safetensors',
      type: 'Model',
      metadata: { size: 'pruned', fp: 'fp16' },
    };
    const versionFiles = [full, pruned];

    it('gives each variant its own name', () => {
      const fullName = resolveModelFileName({
        model: checkpoint,
        modelVersion: version,
        file: full,
        versionFiles,
      });
      const prunedName = resolveModelFileName({
        model: checkpoint,
        modelVersion: version,
        file: pruned,
        versionFiles,
      });

      expect(fullName).not.toBe(prunedName);
      expect(fullName).toBe('realisticVision_v51HyperVAE_full_fp16.safetensors');
      expect(prunedName).toBe('realisticVision_v51HyperVAE_pruned_fp16.safetensors');
    });

    it('leaves a lone file unsuffixed, so existing downloads keep their name', () => {
      expect(
        resolveModelFileName({
          model: checkpoint,
          modelVersion: version,
          file: full,
          versionFiles: [full],
        })
      ).toBe('realisticVision_v51HyperVAE.safetensors');
    });

    it('falls back to the file id when the metadata cannot tell twins apart', () => {
      const twinA = { id: 7, name: 'a.safetensors', type: 'Model', metadata: { size: 'full' } };
      const twinB = { id: 8, name: 'b.safetensors', type: 'Model', metadata: { size: 'full' } };

      const a = resolveModelFileName({
        model: checkpoint,
        modelVersion: version,
        file: twinA,
        versionFiles: [twinA, twinB],
      });
      const b = resolveModelFileName({
        model: checkpoint,
        modelVersion: version,
        file: twinB,
        versionFiles: [twinA, twinB],
      });

      expect(a).not.toBe(b);
      expect(a).toContain('_7.');
      expect(b).toContain('_8.');
    });

    it('returns the bare name when the caller cannot see the siblings', () => {
      expect(resolveModelFileName({ model: checkpoint, modelVersion: version, file: full })).toBe(
        'realisticVision_v51HyperVAE.safetensors'
      );
    });
  });

  describe('LoRA files', () => {
    const version = { name: 'V1' };

    it('keeps the name its creator uploaded', () => {
      // Creators encode the base model, the variant or the character in that filename, and
      // `<model>_<version>` carries none of it. Measured before this was left alone: computing it
      // instead collapsed three separate models in one series onto a single name.
      const file = { id: 1, name: 'AshleyGraves_Krea2_byKonan.safetensors', type: 'Model' };
      expect(
        resolveModelFileName({ model: lora, modelVersion: version, file, versionFiles: [file] })
      ).toBe('AshleyGraves_Krea2_byKonan.safetensors');
    });

    it('still separates two files on one LoRA version', () => {
      const a = { id: 1, name: 'shared.safetensors', type: 'Model', metadata: { fp: 'fp16' } };
      const b = { id: 2, name: 'shared.safetensors', type: 'Model', metadata: { fp: 'fp8' } };
      const versionFiles = [a, b];

      expect(
        resolveModelFileName({ model: lora, modelVersion: version, file: a, versionFiles })
      ).not.toBe(
        resolveModelFileName({ model: lora, modelVersion: version, file: b, versionFiles })
      );
    });
  });

  describe('a version name that repeats the model name', () => {
    const file = { id: 1, name: 'stored.safetensors', type: 'Model' };
    const nameFor = (modelName: string, versionName: string) =>
      resolveModelFileName({
        model: { name: modelName, type: ModelType.Checkpoint },
        modelVersion: { name: versionName },
        file,
        versionFiles: [file],
      });

    it('does not leave a trailing separator when nothing is left of it', () => {
      expect(nameFor('Grace', 'Grace')).toBe('grace.safetensors');
    });

    it('does not double the segment when the repeat is spelled differently', () => {
      // `filenamize('Beet Cookie')` is `beetCookie`, which does not appear in the raw version name,
      // so stripping only the filenamized spelling left the whole thing behind.
      expect(nameFor('Beet Cookie', 'Beet Cookie')).toBe('beetCookie.safetensors');
      expect(nameFor('BB Bunny', 'BB Bunny')).toBe('bbBunny.safetensors');
    });

    it('keeps the part of the version name that is not the model name', () => {
      expect(nameFor('BB Bunny', 'BB Bunny v2')).toBe('bbBunny_v2.safetensors');
    });

    it('leaves an unrelated version name alone', () => {
      expect(nameFor('Realistic Vision', 'V5.1 Hyper (VAE)')).toBe(
        'realisticVision_v51HyperVAE.safetensors'
      );
    });
  });

  it('honours a name the creator set', () => {
    const file = { id: 1, name: jobIdName, overrideName: 'MyOwnName.safetensors', type: 'Model' };
    expect(
      resolveModelFileName({
        model: lora,
        modelVersion: { name: 'V1' },
        file,
        versionFiles: [file],
      })
    ).toBe('MyOwnName.safetensors');
  });

  it('keeps the stored name when the model name filenamizes to nothing', () => {
    const file = { id: 1, name: jobIdName, type: 'Model' };
    expect(
      resolveModelFileName({
        model: { name: 'キュアスパークル', type: ModelType.Checkpoint },
        modelVersion: { name: 'V1' },
        file,
        versionFiles: [file],
      })
    ).toBe(jobIdName);
  });
});
