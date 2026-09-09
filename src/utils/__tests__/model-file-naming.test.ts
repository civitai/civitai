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

    it('names a LoRA after its model, whatever the stored file is called', () => {
      // Both of these used to pass straight through: an uploaded name because LoRAs were
      // special-cased to keep it, and a trainer job id because it is stored the same way.
      for (const stored of ['Squirm__Dandys_World.safetensors', jobIdName]) {
        const file = { id: 1, name: stored, type: 'Model' };
        expect(
          resolveModelFileName({ model: lora, modelVersion: version, file, versionFiles: [file] })
        ).toBe('bbBunny_v1.safetensors');
      }
    });

    it('separates two LoRA files on one version', () => {
      const a = { id: 1, name: jobIdName, type: 'Model', metadata: { fp: 'fp16' } };
      const b = {
        id: 2,
        name: '3ZWN9BZEYR9VV60RPTJD4059V0.safetensors',
        type: 'Model',
        metadata: { fp: 'fp8' },
      };
      const versionFiles = [a, b];

      const nameA = resolveModelFileName({
        model: lora,
        modelVersion: version,
        file: a,
        versionFiles,
      });
      const nameB = resolveModelFileName({
        model: lora,
        modelVersion: version,
        file: b,
        versionFiles,
      });

      expect(nameA).not.toBe(nameB);
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
        model: { name: 'キュアスパークル', type: ModelType.LORA },
        modelVersion: { name: 'V1' },
        file,
        versionFiles: [file],
      })
    ).toBe(jobIdName);
  });
});
