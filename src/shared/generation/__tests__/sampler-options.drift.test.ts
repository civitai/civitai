import { describe, expect, it, vi } from 'vitest';

/**
 * DRIFT: the catalog must be DERIVED from the generator's own sampler sources, so changing a
 * source changes the catalog with no edit to `sampler-options.ts`.
 *
 * Two mutations, at two levels:
 *   1. SD's list is the exported `samplers` in generation.constants. It is replaced with a list
 *      containing a name no real graph offers, and SDXL must answer with exactly that list.
 *   2. Every sampler field is built by `selectDef`. It is wrapped to append a marker option to
 *      every select, and EVERY family whose answer is not null must carry the marker. This is
 *      what catches a module that answers one family from the graph and another from a copy.
 *
 * The marker values cannot equal any real sampler name, so a hardcoded list cannot satisfy
 * either assertion.
 */

const MUTANT_SD = ['Drift Sampler A', 'Euler a', 'Drift Sampler B'] as const;
const MARKER = 'zz-drift-marker';

vi.mock('~/shared/constants/generation.constants', async (importOriginal) => {
  const real = await importOriginal<typeof import('~/shared/constants/generation.constants')>();
  return { ...real, samplers: MUTANT_SD };
});

vi.mock('~/shared/form-graph/defs', async (importOriginal) => {
  const real = await importOriginal<typeof import('~/shared/form-graph/defs')>();
  return {
    ...real,
    selectDef: (o: Parameters<typeof real.selectDef>[0]) =>
      real.selectDef({ ...o, options: [...o.options, MARKER] }),
  };
});

describe('the sampler catalog follows its sources', () => {
  it('SD families answer with the mutated `samplers` list (plus the selectDef marker)', async () => {
    const { getSamplerCatalog } = await import('../sampler-options');
    const sdxl = getSamplerCatalog().ecosystems.SDXL?.sampler;
    expect(sdxl?.options.map((o) => o.value)).toEqual([...MUTANT_SD, MARKER]);
  });

  it('every family with a sampler carries the selectDef marker', async () => {
    const { getSamplerCatalog } = await import('../sampler-options');
    const families = Object.entries(getSamplerCatalog().ecosystems);
    const choices = families.flatMap(([eco, f]) =>
      [f.sampler, ...Object.values(f.byModelVersion)]
        .filter((c) => c !== null)
        .map((c) => [eco, c!] as const)
    );
    // Positive control: at least the SD five, Chroma, Anima, the Klein bases and HiDream Full.
    expect(choices.length).toBeGreaterThanOrEqual(10);
    for (const [eco, c] of choices) {
      expect(c.options.map((o) => o.value), eco).toContain(MARKER);
    }
  });
});
