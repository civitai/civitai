import { describe, expect, it } from 'vitest';

import { ModelType } from '~/shared/utils/prisma/enums';
import {
  GENERIC_FILE_BASENAMES,
  isGenericFileName,
  resolveModelFileName,
} from '~/utils/model-file-naming';

const jobIdName = 'X40F7C8WA9TN0XW80MTTCT2TT0.safetensors';

const checkpoint = { name: 'Realistic Vision', type: ModelType.Checkpoint };
const lora = { name: 'BB Bunny', type: ModelType.LORA };

describe('resolveModelFileName', () => {
  describe('a non-LoRA file with a name of its own', () => {
    // A multi-component checkpoint: the page lists the uploaded names, and workflow tools such as
    // ComfyUI look files up by those names. Renaming them on download broke those workflows.
    const model = { name: 'MOSS Image', type: ModelType.Checkpoint };
    const version = { name: 'SFT' };
    const textEncoder = {
      id: 11,
      name: 'qwen3.5_9b_w4a8_gptq.safetensors',
      type: 'Text Encoder',
      metadata: { fp: 'fp16', quantType: 'int4' },
    };
    const textEncoderBf16 = {
      id: 12,
      name: 'qwen3.5_9b_bf16.safetensors',
      type: 'Text Encoder',
      metadata: { fp: 'bf16' },
    };
    const transformer = {
      id: 13,
      name: 'moss_image_sft_bf16.safetensors',
      type: 'Model',
      metadata: { fp: 'bf16' },
    };
    const versionFiles = [textEncoder, textEncoderBf16, transformer];
    const nameOf = (file: (typeof versionFiles)[number]) =>
      resolveModelFileName({ model, modelVersion: version, file, versionFiles });

    it('keeps the uploaded name of a Text Encoder file', () => {
      expect(nameOf(textEncoder)).toBe('qwen3.5_9b_w4a8_gptq.safetensors');
      expect(nameOf(textEncoderBf16)).toBe('qwen3.5_9b_bf16.safetensors');
    });

    it('keeps the uploaded name of the checkpoint file itself', () => {
      expect(nameOf(transformer)).toBe('moss_image_sft_bf16.safetensors');
    });
  });

  describe('variants on one version', () => {
    // Two download-picker variants uploaded under one generic name: same type, same fp,
    // distinguished only by metadata.size. Both used to resolve to one name, so downloading both
    // left the user with a single file.
    const version = { name: 'V5.1 Hyper (VAE)' };
    const full = {
      id: 1,
      name: 'model.safetensors',
      type: 'Model',
      metadata: { size: 'full', fp: 'fp16' },
    };
    const pruned = {
      id: 2,
      name: 'model.safetensors',
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

    it('leaves a lone generic file unsuffixed', () => {
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
      const twinB = { id: 8, name: 'a.safetensors', type: 'Model', metadata: { size: 'full' } };

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

    it('keeps a distinctive uploaded name when the caller cannot see the siblings', () => {
      const file = { id: 3, name: 'my_checkpoint_v2.safetensors', type: 'Model' };
      expect(resolveModelFileName({ model: checkpoint, modelVersion: version, file })).toBe(
        'my_checkpoint_v2.safetensors'
      );
    });

    it('returns the bare name when the caller cannot see the siblings', () => {
      expect(resolveModelFileName({ model: checkpoint, modelVersion: version, file: full })).toBe(
        'realisticVision_v51HyperVAE.safetensors'
      );
    });
  });

  describe('two files uploaded under one name', () => {
    const version = { name: 'V1' };
    const a = { id: 1, name: 'shared.safetensors', type: 'Model', metadata: { fp: 'fp16' } };
    const b = { id: 2, name: 'Shared.safetensors', type: 'Model', metadata: { fp: 'fp8' } };
    const other = { id: 3, name: 'distinct_name.safetensors', type: 'Model', metadata: {} };
    const versionFiles = [a, b, other];
    const nameOf = (file: (typeof versionFiles)[number]) =>
      resolveModelFileName({ model: checkpoint, modelVersion: version, file, versionFiles });

    it('gives the colliding files distinct scheme names, ignoring case', () => {
      // Case-insensitive because Windows and macOS file systems are: `Shared` overwrites `shared`.
      expect(nameOf(a)).toBe('realisticVision_v1_fp16.safetensors');
      expect(nameOf(b)).toBe('realisticVision_v1_fp8.safetensors');
    });

    it('leaves the sibling that does not collide alone', () => {
      expect(nameOf(other)).toBe('distinct_name.safetensors');
    });

    it('does not hand a colliding file a name a sibling holds in another case', () => {
      // The sibling keeps its upload; its own scheme name would be `_txt`, so only its kept name
      // can collide with the Model twin's scheme name.
      const sibling = { id: 4, name: 'RealisticVision_V1.safetensors', type: 'Text Encoder' };
      const twinA = { id: 5, name: 'shared.safetensors', type: 'Model', metadata: {} };
      const twinB = { id: 6, name: 'shared.safetensors', type: 'VAE', metadata: {} };
      const files = [sibling, twinA, twinB];
      const names = files.map((file) =>
        resolveModelFileName({
          model: checkpoint,
          modelVersion: version,
          file,
          versionFiles: files,
        })
      );

      expect(names).toEqual([
        'RealisticVision_V1.safetensors',
        'realisticVision_v1_5.safetensors',
        'shared.safetensors',
      ]);
    });

    it('separates a file from a sibling whose creator-set name equals its upload', () => {
      const uploaded = { id: 4, name: 'custom.safetensors', type: 'Model', metadata: {} };
      const renamed = {
        id: 5,
        name: 'other.safetensors',
        overrideName: 'custom.safetensors',
        type: 'Model',
        metadata: {},
      };
      const files = [uploaded, renamed];
      const names = files.map((file) =>
        resolveModelFileName({
          model: checkpoint,
          modelVersion: version,
          file,
          versionFiles: files,
        })
      );

      expect(names).toEqual(['realisticVision_v1.safetensors', 'custom.safetensors']);
    });

    it('keeps two collision groups apart when both fall back to the scheme', () => {
      const files = [
        { id: 1, name: 'a.safetensors', type: 'Model', metadata: {} },
        { id: 2, name: 'a.safetensors', type: 'VAE', metadata: {} },
        { id: 3, name: 'b.safetensors', type: 'Model', metadata: {} },
        { id: 4, name: 'b.safetensors', type: 'VAE', metadata: {} },
      ];
      const names = files.map((file) =>
        resolveModelFileName({
          model: checkpoint,
          modelVersion: version,
          file,
          versionFiles: files,
        })
      );

      expect(names).toEqual([
        'realisticVision_v1_1.safetensors',
        'a.safetensors',
        'realisticVision_v1_3.safetensors',
        'b.safetensors',
      ]);
    });

    it('does not hand out an id-suffixed name another file was uploaded under', () => {
      const files = [
        { id: 1, name: 'cool.safetensors', type: 'Model', metadata: {} },
        { id: 2, name: 'cool.safetensors', type: 'Model', metadata: {} },
        { id: 3, name: 'realisticVision_v1_1.safetensors', type: 'Model', metadata: {} },
      ];
      const names = files.map((file) =>
        resolveModelFileName({
          model: checkpoint,
          modelVersion: version,
          file,
          versionFiles: files,
        })
      );

      expect(new Set(names.map((name) => name.toLowerCase())).size).toBe(3);
      expect(names[2]).toBe('realisticVision_v1_1.safetensors');
    });

    it('recognises a copy of a file that has no id yet', () => {
      const fp16 = { name: 'model.safetensors', type: 'Model', metadata: { fp: 'fp16' } };
      const fp32 = { name: 'model.safetensors', type: 'Model', metadata: { fp: 'fp32' } };
      const versionFiles = [fp16, fp32];

      expect(
        resolveModelFileName({
          model: checkpoint,
          modelVersion: version,
          file: { ...fp16 },
          versionFiles,
        })
      ).toBe('realisticVision_v1_fp16.safetensors');
    });

    it('separates variants that have no id yet', () => {
      const fp16 = { name: 'model.safetensors', type: 'Model', metadata: { fp: 'fp16' } };
      const fp8 = { name: 'model.safetensors', type: 'Model', metadata: { fp: 'fp8' } };
      const files = [fp16, fp8];
      const names = files.map((file) =>
        resolveModelFileName({
          model: checkpoint,
          modelVersion: version,
          file,
          versionFiles: files,
        })
      );

      expect(names).toEqual([
        'realisticVision_v1_fp16.safetensors',
        'realisticVision_v1_fp8.safetensors',
      ]);
    });

    it('recognises the file when the caller passes a copy of its sibling entry', () => {
      // The API handlers destructure each file before naming it, so `file` is never the same object
      // as its entry in `versionFiles`.
      expect(nameOf({ ...a })).toBe('realisticVision_v1_fp16.safetensors');
    });

    it('does not hand a colliding file the scheme name a generic sibling already has', () => {
      const generic = { id: 4, name: 'model.safetensors', type: 'Model', metadata: {} };
      const twinA = { id: 5, name: 'shared.safetensors', type: 'Model', metadata: {} };
      const twinB = { id: 6, name: 'shared.safetensors', type: 'VAE', metadata: {} };
      const files = [generic, twinA, twinB];
      const names = files.map((file) =>
        resolveModelFileName({
          model: checkpoint,
          modelVersion: version,
          file,
          versionFiles: files,
        })
      );

      expect(names).toEqual([
        'realisticVision_v1.safetensors',
        'realisticVision_v1_5.safetensors',
        'shared.safetensors',
      ]);
    });
  });

  describe('a generic uploaded name', () => {
    const model = { name: 'MOSS Image', type: ModelType.Checkpoint };
    const version = { name: 'SFT' };
    const nameFor = (name: string, type = 'Model') => {
      const file = { id: 1, name, type };
      return resolveModelFileName({ model, modelVersion: version, file, versionFiles: [file] });
    };

    // One case per pattern family. A name in any of them says nothing about the model, so the file
    // is named after the model instead.
    it.each([
      ['word', 'diffusion_pytorch_model.safetensors'],
      ['word with an fp16 tag', 'diffusion_pytorch_model.fp16.safetensors'],
      ['word with an fp32 tag', 'model.fp32.safetensors'],
      ['word with a bf16 tag', 'transformer.bf16.safetensors'],
      ['word with an fp8 tag', 'unet.fp8.safetensors'],
      ['shard', 'model-00001-of-00003.safetensors'],
      ['ULID (training job id)', jobIdName],
      ['UUID', '3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b.safetensors'],
      ['hex hash', 'a1b2c3d4e5f60718293a4b5c.safetensors'],
      ['digits', '123456.safetensors'],
    ])('uses the scheme for a %s', (_family, name) => {
      expect(nameFor(name)).toBe('mossImage_sft.safetensors');
    });

    it('treats every listed basename as generic, in any case and with any extension', () => {
      for (const basename of GENERIC_FILE_BASENAMES) {
        expect(isGenericFileName(`${basename}.safetensors`), basename).toBe(true);
        expect(isGenericFileName(`${basename.toUpperCase()}.ckpt`), basename).toBe(true);
      }
    });

    it('does not treat a name that merely contains a generic word as generic', () => {
      expect(isGenericFileName('my_model.safetensors')).toBe(false);
      expect(isGenericFileName('vae_ft_mse.safetensors')).toBe(false);
      expect(isGenericFileName('qwen3.5_9b_w4a8_gptq.safetensors')).toBe(false);
    });

    it('keeps the _txt suffix for a generic Text Encoder', () => {
      expect(nameFor('model.safetensors', 'Text Encoder')).toBe('mossImage_sft_txt.safetensors');
    });
  });

  describe('deliberate exceptions to keeping the uploaded name', () => {
    // If you are about to fold these into the general rule: each was a decision, not an oversight.
    it('names a Textual Inversion after its trained word, which A1111 uses as the prompt token', () => {
      const file = { id: 1, name: 'my_embedding_v3.pt', type: 'Model' };
      expect(
        resolveModelFileName({
          model: { name: 'Sad Clown', type: ModelType.TextualInversion },
          modelVersion: { name: 'V1', trainedWords: ['sadclown'] },
          file,
          versionFiles: [file],
        })
      ).toBe('sadclown.pt');
    });

    it('keeps the scheme for training data, which no workflow tool loads by name', () => {
      const file = { id: 1, name: 'my_dataset_final.zip', type: 'Training Data' };
      expect(
        resolveModelFileName({
          model: checkpoint,
          modelVersion: { name: 'V1' },
          file,
          versionFiles: [file],
        })
      ).toBe('realisticVision_v1_trainingData.zip');
    });
  });

  describe('known limit: a collision across file types', () => {
    // The API lists every file on the version, so it sees a Model and a VAE uploaded under the same
    // name and separates them. The download route's type path (`?type=Model`) reads only files of
    // that type as siblings, sees no collision, and serves the uploaded name. For that file the
    // name in the API and the name the download saves under differ. Fixing it means reading every
    // sibling in getDownloadFile; this test pins the current behaviour so the gap is visible.
    const version = { name: 'V1' };
    const modelFile = { id: 1, name: 'shared.safetensors', type: 'Model', metadata: {} };
    const vaeFile = { id: 2, name: 'shared.safetensors', type: 'VAE', metadata: {} };
    const allFiles = [modelFile, vaeFile];

    it('separates them when every sibling is visible (the API)', () => {
      const modelName = resolveModelFileName({
        model: checkpoint,
        modelVersion: version,
        file: modelFile,
        versionFiles: allFiles,
      });
      const vaeName = resolveModelFileName({
        model: checkpoint,
        modelVersion: version,
        file: vaeFile,
        versionFiles: allFiles,
      });
      expect(modelName).toBe('realisticVision_v1.safetensors');
      expect(vaeName).toBe('shared.safetensors');
    });

    it('keeps the uploaded name when only same-type siblings are visible (the download route)', () => {
      expect(
        resolveModelFileName({
          model: checkpoint,
          modelVersion: version,
          file: modelFile,
          versionFiles: [modelFile],
        })
      ).toBe('shared.safetensors');
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

    it('keeps even a generic uploaded name, as before', () => {
      const file = { id: 1, name: 'pytorch_lora_weights.safetensors', type: 'Model' };
      expect(
        resolveModelFileName({ model: lora, modelVersion: version, file, versionFiles: [file] })
      ).toBe('pytorch_lora_weights.safetensors');
    });

    it('separates LoRA files whose names differ only in case', () => {
      // A deliberate change from before: these overwrite each other on Windows and macOS.
      const upper = { id: 1, name: 'B.safetensors', type: 'Model', metadata: {} };
      const lower = { id: 2, name: 'b.safetensors', type: 'Model', metadata: {} };
      const versionFiles = [upper, lower];

      expect(
        resolveModelFileName({ model: lora, modelVersion: version, file: upper, versionFiles })
      ).toBe('B_1.safetensors');
      expect(
        resolveModelFileName({ model: lora, modelVersion: version, file: lower, versionFiles })
      ).toBe('b_2.safetensors');
    });

    it('still separates two files on one LoRA version', () => {
      const a = { id: 1, name: 'shared.safetensors', type: 'Model', metadata: { fp: 'fp16' } };
      const b = { id: 2, name: 'shared.safetensors', type: 'Model', metadata: { fp: 'fp8' } };
      const versionFiles = [a, b];

      expect(
        resolveModelFileName({ model: lora, modelVersion: version, file: a, versionFiles })
      ).toBe('shared_fp16.safetensors');
      expect(
        resolveModelFileName({ model: lora, modelVersion: version, file: b, versionFiles })
      ).toBe('shared_fp8.safetensors');
    });
  });

  describe('a version name that repeats the model name', () => {
    const file = { id: 1, name: 'model.safetensors', type: 'Model' };
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
