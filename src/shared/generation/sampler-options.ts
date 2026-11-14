/**
 * The generator's sampler options per model family, read from the REAL generation graph by
 * probing the hub per family (as `images-limit.ts` does), for App Blocks.
 *
 * Why not a copied list: `selectDef` silently replaces an unknown sampler with the family
 * default, so a stale copy fails with no error.
 *
 * An UNDETERMINED probe must never be reported as "no sampler" (`null`) — that would tell an app
 * to hide a control the generator shows; such a family is left out instead.
 *
 * Families are keyed by the ecosystem key the block submit path uses
 * (`getEcosystem(checkpointBaseModel).key`); `baseModels` maps base model names onto it. In a
 * model-locked ecosystem a version can select a graph variant with a different sampler field;
 * those versions are in `byModelVersion`.
 *
 * Probed under `PROBE_CTX` (free tier, no flags, no gate rules), so nothing per-user reaches the
 * memoized answer.
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

/**
 * One sampler control: the options in the generator's order, and the value the generator
 * preselects. It is also what a block gets by omitting `params.sampler`
 * (`resolveDefaultSampler`).
 */
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

/** The version ids the generator's model picker lists for `ecosystem` on `workflow`, or none. */
export function listedVersionIds(
  ecosystem: string,
  workflow: string = SAMPLER_PROBE_WORKFLOW
): number[] {
  const probe = probeField('model', { workflow, ecosystem }, PROBE_CTX);
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

/**
 * The sampler the generator preselects for `ecosystem`, as the catalog reports it: the
 * version's own answer when `modelVersionId` is one of the family's `byModelVersion` overrides
 * (HiDream Full), the family's otherwise.
 *
 * - a string: that default.
 * - `null`: the family (or version) has no sampler control, so no sampler should be sent.
 * - `undefined`: the catalog does not describe this family. The caller must not guess; leaving
 *   the field out lets the graph apply the same default this would have reported.
 */
export function resolveDefaultSampler(
  ecosystem: string,
  modelVersionId?: number
): string | null | undefined {
  const family = getSamplerCatalog().ecosystems[ecosystem];
  if (!family) return undefined;
  const key = modelVersionId != null ? String(modelVersionId) : undefined;
  const choice =
    key !== undefined && Object.prototype.hasOwnProperty.call(family.byModelVersion, key)
      ? family.byModelVersion[key]
      : family.sampler;
  return choice ? choice.default : null;
}
