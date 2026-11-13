import { describe, expect, it } from 'vitest';
import { ecosystemByKey } from '~/shared/constants/basemodel.constants';
import { getAllVersionIds, type VersionGroup } from '~/shared/form-graph/generation/checkpoint';
import { isWorkflowAvailable } from '~/shared/generation/config/workflows';
import { probeField, PROBE_CTX } from '../field-probe';
import { samplerCatalogEcosystems } from '../sampler-options';

/**
 * Every sampler PRESET the generator shows (the Fast / Popular / Quality buttons beside the
 * sampler select) must name a sampler in that same control's option list.
 *
 * Why it matters: the button writes the preset's value into the form, and `selectDef` silently
 * corrects an out-of-set value to the family default. A preset naming a sampler the family does
 * not offer therefore never selects anything — it lands on the default, and the button never
 * shows as active. No error says so anywhere.
 *
 * Both sides are read from the REAL graph, per route: the families from the sampler catalog's
 * population, each listed checkpoint version, and every image route a body can take (the
 * options and the presets of one probe). No option list is copied here, so a bad preset added
 * later fails the first test without editing this file. The positive control names the families
 * that show presets today, so a family that gains or loses presets has to be added to it on purpose.
 */

const WORKFLOWS = ['txt2img', 'img2img', 'img2img:edit'] as const;

type SamplerMeta = {
  options?: { value: string }[];
  presets?: { label: string; value: string }[];
};

function listedVersionIds(workflow: string, ecosystem: string): number[] {
  const probe = probeField('model', { workflow, ecosystem }, PROBE_CTX);
  if (probe.kind !== 'present') return [];
  const versions = (probe.meta as { versions?: VersionGroup } | undefined)?.versions;
  if (!versions || !Array.isArray(versions.options)) return [];
  return [...getAllVersionIds(versions)].sort((a, b) => a - b);
}

/** Every sampler control the generator can show, with where it was read. */
function samplerControls() {
  const controls: { where: string; ecosystem: string; workflow: string; meta: SamplerMeta }[] = [];
  for (const ecosystem of samplerCatalogEcosystems()) {
    const id = ecosystemByKey.get(ecosystem)!.id;
    for (const workflow of WORKFLOWS) {
      if (!isWorkflowAvailable(workflow, id)) continue;
      const pins: { where: string; model?: { id: number } }[] = [
        { where: `${ecosystem} ${workflow}` },
        ...listedVersionIds(workflow, ecosystem).map((v) => ({
          where: `${ecosystem} ${workflow} version ${v}`,
          model: { id: v },
        })),
      ];
      for (const pin of pins) {
        const probe = probeField(
          'sampler',
          { workflow, ecosystem, ...(pin.model ? { model: pin.model } : {}) },
          PROBE_CTX
        );
        if (probe.kind === 'present') {
          controls.push({
            where: pin.where,
            ecosystem,
            workflow,
            meta: (probe.meta ?? {}) as SamplerMeta,
          });
        }
      }
    }
  }
  return controls;
}

describe('sampler presets name samplers their family offers', () => {
  const controls = samplerControls();

  it('every preset value is one of its own control’s options', () => {
    // Keyed by family, route and preset, first pin wins: the family pin comes before its
    // versions, so a bad preset is reported once, under the version only when it is that
    // version's own.
    const bad = new Map<string, string>();
    for (const { where, ecosystem, workflow, meta } of controls) {
      const options = (meta.options ?? []).map((o) => o.value);
      for (const preset of meta.presets ?? []) {
        const key = `${ecosystem} ${workflow} ${preset.label}=${preset.value}`;
        if (options.includes(preset.value) || bad.has(key)) continue;
        bad.set(
          key,
          `${where}: preset "${preset.label}" names "${preset.value}", not in [${options.join(
            ', '
          )}]`
        );
      }
    }
    expect([...bad.values()]).toEqual([]);
  });

  it('positive control: the sweep reaches every family that shows presets', () => {
    // Hand-written from the graph files. If the probe stopped returning presets (or stopped
    // reaching these families), the check above would pass over nothing.
    const withPresets = new Set(
      controls.filter((c) => (c.meta.presets ?? []).length > 0).map((c) => c.ecosystem)
    );
    expect([...withPresets].sort()).toEqual(
      ['Anima', 'Chroma', 'Illustrious', 'NoobAI', 'Pony', 'SD1', 'SDXL', 'ZImageBase'].sort()
    );
  });
});
