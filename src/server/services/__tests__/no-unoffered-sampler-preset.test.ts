import { describe, expect, it } from 'vitest';
import { ecosystems } from '~/shared/constants/basemodel.constants';
import { isWorkflowAvailable, workflowConfigs } from '~/shared/generation/config/workflows';
import { probeField, PROBE_CTX } from '~/shared/generation/field-probe';
import { listedVersionIds } from '~/shared/generation/sampler-options';

/**
 * Every sampler PRESET the generator shows (the Fast / Popular / Quality buttons beside the
 * sampler select) must name a sampler in that same control's option list.
 *
 * Why it matters: the button writes the preset's value into the form, and `selectDef` silently
 * corrects an out-of-set value to the family default. A preset naming a sampler the family does
 * not offer therefore never selects anything: it lands on the default, and the button never
 * shows as active. No error says so anywhere. ZImage shipped exactly that, with the SD presets
 * ('Euler a' / 'DPM++ 2M Karras') on a control offering only 'euler' and 'heun'.
 *
 * Both sides are read from the REAL graph, from one probe: every ecosystem, every workflow key
 * `isWorkflowAvailable` allows for it (hidden ones and the hires-fix / face-fix routes
 * included), and every checkpoint version the model picker lists on that route. No option list is
 * copied here, so a bad preset added later fails the first test without editing this file.
 *
 * A probe the hub re-routes is UNDETERMINED and is skipped: it describes no control.
 */

type SamplerMeta = {
  options?: { value: string }[];
  presets?: { label: string; value: string }[];
};

type Control = { where: string; ecosystem: string; workflow: string; meta: SamplerMeta };

/** Every sampler control the generator can show, with where it was read. */
function samplerControls(): Control[] {
  const controls: Control[] = [];
  for (const { key: ecosystem, id } of ecosystems) {
    for (const workflow of Object.keys(workflowConfigs)) {
      if (!isWorkflowAvailable(workflow, id)) continue;
      const pins: { where: string; model?: { id: number } }[] = [
        { where: `${ecosystem} ${workflow}` },
        ...listedVersionIds(ecosystem, workflow).map((v) => ({
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

describe('no-unoffered-sampler-preset', () => {
  const controls = samplerControls();
  const withPresets = controls.filter((c) => (c.meta.presets ?? []).length > 0);

  it('every sampler preset is one of its own control’s options', () => {
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
    // Hand-written from the graph files. If the probe stopped returning presets, or stopped
    // reaching these families, the check above would pass over nothing. A family that gains or
    // loses presets has to be added here on purpose.
    expect([...new Set(withPresets.map((c) => c.ecosystem))].sort()).toEqual(
      ['Anima', 'Chroma', 'Illustrious', 'NoobAI', 'Pony', 'SD1', 'SDXL', 'ZImageBase'].sort()
    );
  });

  it('positive control: the sweep reaches routes beyond the plain txt2img/img2img pair', () => {
    // SD's hires-fix and face-fix routes carry the same sampler control. A sweep narrowed back to
    // a fixed workflow list would stop seeing them.
    const sdxlRoutes = new Set(
      withPresets.filter((c) => c.ecosystem === 'SDXL').map((c) => c.workflow)
    );
    expect(sdxlRoutes).toContain('txt2img:hires-fix');
    expect(sdxlRoutes).toContain('img2img:face-fix');
  });
});
