import { describe, expect, it } from 'vitest';
import {
  ecosystemByKey,
  getEcosystem,
  getGenerationEcosystemsForMediaType,
} from '~/shared/constants/basemodel.constants';
import { isWorkflowAvailable } from '~/shared/generation/config/workflows';
import { probeField, PROBE_CTX } from '../field-probe';
import {
  getFamilySamplers,
  getSamplerCatalog,
  samplerCatalogEcosystems,
  type SamplerChoice,
} from '../sampler-options';

/**
 * The per-family sampler catalog App Blocks reads (`GET /api/v1/blocks/generation-samplers`).
 *
 * The literals below are the CONTRACT, written out by hand from the graph files — never computed
 * from the module under test. They are chosen so each derivation step is visible: SD's list
 * comes from `samplers` in generation.constants, Chroma's and Anima's from their own graph
 * files, the Klein and Z-Image bases from ComfyUI-name lists, HiDream's from one VARIANT of a
 * model-locked ecosystem, and Flux1 from a graph with no sampler field.
 *
 * Anima is the default-value control: its default (`euler_ancestral`) is NOT its first option,
 * so a mutant that reports `options[0]` as the default fails there and nowhere it would not.
 */

const opts = (values: string[]) => values.map((v) => ({ value: v, label: v }));

const SD_SAMPLERS: SamplerChoice = {
  options: opts(['Euler a', 'Euler', 'Heun', 'LMS', 'DDIM', 'DPM++ 2M Karras', 'DPM2', 'DPM2 a']),
  default: 'Euler a',
};
const KLEIN_BASE_SAMPLERS: SamplerChoice = {
  options: opts(['euler', 'heun', 'dpm++2s_a', 'dpm++2m', 'dpm++2mv2', 'ipndm', 'ipndm_v', 'lcm']),
  default: 'euler',
};

describe('getSamplerCatalog — contract', () => {
  const catalog = getSamplerCatalog();

  it.each(['SD1', 'SDXL', 'Pony', 'Illustrious', 'NoobAI'])(
    '%s offers the SD sampler list, default Euler a',
    (eco) => {
      expect(catalog.ecosystems[eco]).toEqual({ sampler: SD_SAMPLERS, byModelVersion: {} });
    }
  );

  it('Chroma offers its own flow-compatible list, default Euler', () => {
    expect(catalog.ecosystems.Chroma).toEqual({
      sampler: {
        options: opts(['Euler', 'Euler a', 'DPM++ SDE', 'DPM++ 2M Karras', 'DPM++ SDE Karras']),
        default: 'Euler',
      },
      byModelVersion: {},
    });
  });

  it('Anima offers ComfyUI names, and its default is not its first option', () => {
    expect(catalog.ecosystems.Anima).toEqual({
      sampler: {
        options: opts(['er_sde', 'euler', 'euler_ancestral', 'heun', 'dpm_2', 'dpmpp_2m']),
        default: 'euler_ancestral',
      },
      byModelVersion: {},
    });
  });

  it.each(['Flux2Klein_9B_base', 'Flux2Klein_4B_base'])('%s offers the Klein list', (eco) => {
    expect(catalog.ecosystems[eco]).toEqual({ sampler: KLEIN_BASE_SAMPLERS, byModelVersion: {} });
  });

  it('ZImageBase offers euler and heun', () => {
    expect(catalog.ecosystems.ZImageBase).toEqual({
      sampler: { options: opts(['euler', 'heun']), default: 'euler' },
      byModelVersion: {},
    });
  });

  it('a family with no sampler field is present and null, not missing', () => {
    expect(catalog.ecosystems.Flux1).toEqual({ sampler: null, byModelVersion: {} });
    expect(catalog.ecosystems.Flux2Klein_9B).toEqual({ sampler: null, byModelVersion: {} });
  });

  it('HiDream: the default (Dev) version has no sampler, the Full version offers UniPC', () => {
    // 1772448 is HiDream FP8 Full, the only variant whose graph declares a sampler field.
    expect(catalog.ecosystems.HiDream).toEqual({
      sampler: null,
      byModelVersion: { '1772448': { options: opts(['UniPC']), default: 'UniPC' } },
    });
  });

  it('every listed default is one of its own options', () => {
    for (const [eco, family] of Object.entries(catalog.ecosystems)) {
      const choices = [family.sampler, ...Object.values(family.byModelVersion)];
      for (const c of choices) {
        if (c) expect(c.options.map((o) => o.value), eco).toContain(c.default);
      }
    }
  });

  it('maps base model names onto the family keys the submit path uses', () => {
    expect(catalog.baseModels['SD 1.5']).toBe('SD1');
    expect(catalog.baseModels['SDXL 1.0']).toBe('SDXL');
    expect(catalog.baseModels['Illustrious']).toBe('Illustrious');
    expect(catalog.baseModels['Flux.1 D']).toBe('Flux1');
    expect(catalog.baseModels['Flux.2 Klein 9B']).toBe('Flux2Klein_9B');
    expect(catalog.baseModels['Flux.2 Klein 9B-base']).toBe('Flux2Klein_9B_base');
    expect(catalog.baseModels['Chroma']).toBe('Chroma');
    expect(catalog.baseModels['Anima']).toBe('Anima');
    // THE SEAM: `buildImageWorkflowInput` keys the graph by `getEcosystem(baseModel).key`, so
    // every entry must agree with it — and must land on a family the catalog describes.
    for (const [name, key] of Object.entries(catalog.baseModels)) {
      expect(getEcosystem(name)?.key, name).toBe(key);
      expect(Object.keys(catalog.ecosystems), name).toContain(key);
    }
  });
});

describe('getSamplerCatalog — coverage', () => {
  it('covers every family in its population, none left undetermined', () => {
    const population = samplerCatalogEcosystems();
    // Non-vacuous: the image ecosystem list is large, and SD, Chroma and Flux are all in it.
    expect(population.length).toBeGreaterThan(20);
    expect(population).toEqual(expect.arrayContaining(['SDXL', 'Chroma', 'Flux1', 'HiDream']));
    expect(Object.keys(getSamplerCatalog().ecosystems)).toEqual(population);
  });

  it('every image ecosystem outside the population has no route a textToImage body reaches', () => {
    // The population is "has txt2img". A block's textToImage body also routes to img2img and
    // img2img:edit when it carries a source image, so an ecosystem with only those would need a
    // sampler answer too. Pinned: none exists today.
    const inPopulation = new Set(samplerCatalogEcosystems());
    const outside = getGenerationEcosystemsForMediaType('image').filter(
      (k) => !inPopulation.has(k)
    );
    // Positive control: the 3D and upscaler ecosystems are image-typed and have no such route.
    expect(outside).toEqual(expect.arrayContaining(['Upscaler']));
    for (const key of outside) {
      const id = ecosystemByKey.get(key)!.id;
      for (const workflow of ['txt2img', 'img2img', 'img2img:edit']) {
        expect(isWorkflowAvailable(workflow, id), `${key} ${workflow}`).toBe(false);
      }
    }
  });

  it('INVARIANT: the image routes a textToImage body can take answer the same as txt2img', () => {
    // The catalog probes txt2img only. A block body with a source image goes to img2img (SD
    // family) or img2img:edit (edit-capable families); if either ever offered a DIFFERENT list
    // the single per-family answer would be wrong for those bodies. Invariant guard: it holds
    // today and pins that it keeps holding.
    let compared = 0;
    for (const eco of samplerCatalogEcosystems()) {
      const id = ecosystemByKey.get(eco)!.id;
      const family = getSamplerCatalog().ecosystems[eco];
      for (const workflow of ['img2img', 'img2img:edit']) {
        if (!isWorkflowAvailable(workflow, id)) continue;
        const probe = probeField('sampler', { workflow, ecosystem: eco }, PROBE_CTX);
        expect(probe.kind, `${eco} ${workflow}`).not.toBe('undetermined');
        const choice =
          probe.kind === 'present'
            ? {
                options: (probe.meta as { options: SamplerChoice['options'] }).options,
                default: probe.value,
              }
            : null;
        expect(choice, `${eco} ${workflow}`).toEqual(family.sampler);
        compared++;
      }
    }
    // Positive control: SD-family img2img and the edit-capable families were really compared.
    expect(compared).toBeGreaterThan(10);
  });
});

describe('getFamilySamplers — unknown is not "no sampler"', () => {
  it('returns undefined for an ecosystem the hub re-routes, rather than null', () => {
    // `NotAnEcosystem` resolves to a different family; reporting that family's answer, or
    // "no sampler", would both be wrong.
    expect(getFamilySamplers('NotAnEcosystem')).toBeUndefined();
  });
});
