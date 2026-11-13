/**
 * The sampler choices the on-site generator offers, per model family, read from the REAL
 * generation graph — for App Blocks (`GET /api/v1/blocks/generation-samplers`).
 *
 * WHY THIS EXISTS
 * ---------------
 * A block's `textToImage` body takes `params.sampler` as a free string, and which names are
 * valid depends on the family: SD-family graphs take `samplers` from generation.constants
 * ('Euler a', 'DPM++ 2M Karras', …), Chroma has its own five, Anima and the Klein/Z-Image
 * bases take ComfyUI names ('euler_ancestral', 'dpm++2m', …), and most families have no
 * sampler control at all. A name the family does not offer is not refused: `selectDef`'s input
 * transform replaces it with the family default, so a block that guesses gets a different
 * sampler with no error. An app that copied a list would drift the first time a graph changed.
 *
 * So this INSTANTIATES the generation hub per family — the same probe `images-limit.ts` uses —
 * and reads the `sampler` field the form renders from. `ImageGenerationForm` passes that
 * field's `meta.options` straight to its select, so `options` here is the drop-down the
 * generator shows, in its order, with its labels. `default` is the field's resolved value on a
 * fresh store, i.e. what the generator preselects.
 *
 * KEYING. The block submit path derives the graph's `ecosystem` from the checkpoint's base
 * model (`getEcosystem(checkpointBaseModel).key` in `buildImageWorkflowInput`), so families are
 * keyed by that ecosystem key, and `baseModels` maps every base model name onto it through the
 * same `getEcosystem` — an app holding a checkpoint's `baseModel` (every picker result carries
 * it) looks up `ecosystems[baseModels[baseModel]]`.
 *
 * VERSION-DEPENDENT FAMILIES. In a model-locked ecosystem the version picks a graph variant,
 * and the variant can change the sampler field (measured: HiDream's Full variant offers
 * `UniPC`; its Fast and Dev variants have no sampler control). `sampler` describes the family's
 * default version; every listed version whose answer differs is in `byModelVersion`, keyed by
 * version id. Both are derived from the hub's own version list, nothing is named here.
 *
 * NEUTRAL CONTEXT: probed under `PROBE_CTX` (free tier, no flags, no gate rules), so nothing
 * per-user can reach the answer. It is static per process and memoized.
 */

import { getAllVersionIds, type VersionGroup } from '~/shared/form-graph/generation/checkpoint';
import {
  baseModelRecords,
  ecosystemByKey,
  getEcosystem,
  getGenerationEcosystemsForMediaType,
} from '~/shared/constants/basemodel.constants';
import { isWorkflowAvailable } from '~/shared/generation/config/workflows';
import { probeField, PROBE_CTX, type FieldProbe } from './field-probe';

/** The workflow probed. A `textToImage` body with no source image routes here. */
export const SAMPLER_PROBE_WORKFLOW = 'txt2img';

export type SamplerOption = { value: string; label: string };

/** One sampler control: the options in the generator's order, and the preselected value. */
export type SamplerChoice = { options: SamplerOption[]; default: string };

export type FamilySamplers = {
  /** The family's default version. `null`: the generator shows no sampler control. */
  sampler: SamplerChoice | null;
  /** Versions whose answer differs from `sampler`, by version id. Usually empty. */
  byModelVersion: Record<string, SamplerChoice | null>;
};

export type SamplerCatalog = {
  /** Ecosystem key → that family's sampler control, in the generator's ecosystem order. */
  ecosystems: Record<string, FamilySamplers>;
  /** Base model name → ecosystem key, for every base model whose family is in `ecosystems`. */
  baseModels: Record<string, string>;
};

type ChoiceProbe = { kind: 'determined'; choice: SamplerChoice | null } | { kind: 'undetermined' };

/**
 * A probe result as a sampler choice. Anything that does not read as a select whose value is
 * one of its options is UNDETERMINED, never "no sampler": reporting a family as having no
 * control because its meta changed shape would tell an app to hide a control the generator
 * still shows.
 */
function toChoice(probe: FieldProbe): ChoiceProbe {
  if (probe.kind === 'undetermined') return { kind: 'undetermined' };
  if (probe.kind === 'absent') return { kind: 'determined', choice: null };
  const rawOptions: unknown = (probe.meta as { options?: unknown } | undefined)?.options;
  if (!Array.isArray(rawOptions) || rawOptions.length === 0) return { kind: 'undetermined' };
  const options: SamplerOption[] = [];
  for (const o of rawOptions as unknown[]) {
    const { value, label } = (o ?? {}) as { value?: unknown; label?: unknown };
    if (typeof value !== 'string' || typeof label !== 'string') return { kind: 'undetermined' };
    options.push({ value, label });
  }
  const value = probe.value;
  if (typeof value !== 'string' || !options.some((o) => o.value === value)) {
    return { kind: 'undetermined' };
  }
  return { kind: 'determined', choice: { options, default: value } };
}

function sameChoice(a: SamplerChoice | null, b: SamplerChoice | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The families the catalog covers: every image ecosystem the generator supports whose
 * `txt2img` route exists. An image ecosystem outside this set has no route a `textToImage`
 * body can reach (see the test that pins it), so there is no sampler to describe.
 */
export function samplerCatalogEcosystems(): string[] {
  return getGenerationEcosystemsForMediaType('image').filter((key) => {
    const id = ecosystemByKey.get(key)?.id;
    return id != null && isWorkflowAvailable(SAMPLER_PROBE_WORKFLOW, id);
  });
}

/** The version ids the generator's model picker lists for `ecosystem`, or none. */
function listedVersionIds(ecosystem: string): number[] {
  const probe = probeField('model', { workflow: SAMPLER_PROBE_WORKFLOW, ecosystem }, PROBE_CTX);
  if (probe.kind !== 'present') return [];
  const versions = (probe.meta as { versions?: VersionGroup } | undefined)?.versions;
  if (!versions || !Array.isArray(versions.options)) return [];
  return [...getAllVersionIds(versions)].sort((a, b) => a - b);
}

/**
 * One family's sampler control, or `undefined` when the probe could not determine it. The
 * caller must treat `undefined` as unknown and leave the family out, never as "no sampler".
 */
export function getFamilySamplers(ecosystem: string): FamilySamplers | undefined {
  const base = toChoice(
    probeField('sampler', { workflow: SAMPLER_PROBE_WORKFLOW, ecosystem }, PROBE_CTX)
  );
  if (base.kind === 'undetermined') return undefined;

  const byModelVersion: Record<string, SamplerChoice | null> = {};
  for (const id of listedVersionIds(ecosystem)) {
    const version = toChoice(
      probeField(
        'sampler',
        { workflow: SAMPLER_PROBE_WORKFLOW, ecosystem, model: { id } },
        PROBE_CTX
      )
    );
    // An undetermined version is left out: the family answer is then the best available, and
    // it is never replaced by a guess.
    if (version.kind === 'undetermined') continue;
    if (!sameChoice(version.choice, base.choice)) byModelVersion[String(id)] = version.choice;
  }
  return { sampler: base.choice, byModelVersion };
}

let catalog: SamplerCatalog | undefined;

/** The whole catalog, built once per process (the graph config is static). */
export function getSamplerCatalog(): SamplerCatalog {
  if (catalog) return catalog;
  const ecosystems: Record<string, FamilySamplers> = {};
  for (const key of samplerCatalogEcosystems()) {
    const family = getFamilySamplers(key);
    if (family) ecosystems[key] = family;
  }
  const baseModels: Record<string, string> = {};
  for (const record of baseModelRecords) {
    const key = getEcosystem(record.name)?.key;
    if (key && key in ecosystems) baseModels[record.name] = key;
  }
  catalog = { ecosystems, baseModels };
  return catalog;
}
