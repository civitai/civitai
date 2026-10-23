import type { ModelVersionPricingSignal } from '@civitai/buzz';
import type {
  ResourceFilter,
  SelectableVersion,
} from '~/components/ImageGeneration/GenerationForm/resource-select.types';
import { selectableVersions } from '~/components/ImageGeneration/GenerationForm/resource-select.types';
import { versionGeneratableFor } from '~/shared/generation/coverage-fields';
import { versionSatisfiesPricingFilter } from '~/shared/search/model-pricing-filter';
import { parseCivitaiUrlSafe } from '~/utils/civitai-url';
import { getDisplayName } from '~/utils/string-helpers';

export type ResourceLookup = { modelId?: number; modelVersionId?: number };

export const LOOKUP_NOT_FOUND =
  'No model found for that link. It may be unpublished, private, or not available here.';

/** A pasted model / model-version link, or a bare number read as a model id. */
export function parseResourceLookup(
  text: string
): { lookup: ResourceLookup; isLink: boolean } | null {
  const trimmed = text.trim();
  if (/^\d+$/.test(trimmed)) {
    const modelId = Number(trimmed);
    return Number.isSafeInteger(modelId) && modelId > 0
      ? { lookup: { modelId }, isLink: false }
      : null;
  }
  const ref = parseCivitaiUrlSafe(trimmed);
  if (ref?.type === 'model')
    return {
      lookup: { modelId: ref.modelId, modelVersionId: ref.modelVersionId },
      isLink: true,
    };
  if (ref?.type === 'modelVersion')
    return { lookup: { modelVersionId: ref.modelVersionId }, isLink: true };
  return null;
}

type LookupVersion = SelectableVersion & {
  name: string;
  pricing?: ModelVersionPricingSignal[];
};

type HiddenReason = 'added' | 'baseModel' | 'generate' | 'loaded' | 'turbo' | 'excludeTurbo';

export type LookupContext = {
  modelVersionId?: number;
  resources: { type: string; baseModels: string[] }[];
  filters: ResourceFilter;
  excludedIds: number[];
  canGenerate?: boolean;
  coverageNext?: boolean;
  member?: boolean;
  excludeTurbo?: boolean;
};

function listOf(items: string[], max = 3) {
  const unique = [...new Set(items)];
  if (unique.length <= max) return unique.join(', ');
  return `${unique.slice(0, max).join(', ')} and ${unique.length - max} more`;
}

/**
 * The versions of a looked-up model this picker would show, and — when the picker's scope or the
 * viewer's filters hide what was pasted — one sentence saying which.
 */
export function resolveLookupHit<V extends LookupVersion>(
  model: { name: string; type: string; versions: V[] },
  ctx: LookupContext
): { versions: V[]; note: string | null } {
  const { resources, filters } = ctx;
  if (!model.versions.length) return { versions: [], note: LOOKUP_NOT_FOUND };
  const isCheckpoint = model.type === 'Checkpoint';
  const typeName = getDisplayName(model.type);

  if (resources.length > 0 && !resources.some((r) => r.type === model.type))
    return {
      versions: [],
      note: `“${
        model.name
      }” is a ${typeName}, which can't be added here. This picker takes: ${listOf(
        resources.map((r) => getDisplayName(r.type)),
        6
      )}.`,
    };
  if (filters.types.length > 0 && !filters.types.includes(model.type as never))
    return { versions: [], note: `“${model.name}” is hidden by your type filter.` };

  // The viewer's own base-model and pricing filters work per MODEL in the grid (a Meilisearch
  // match on any version), so they are checked the same way here.
  if (
    filters.baseModels.length > 0 &&
    !model.versions.some((v) => filters.baseModels.includes(v.baseModel as never))
  )
    return { versions: [], note: `“${model.name}” is hidden by your base model filter.` };
  if (!model.versions.some((v) => versionSatisfiesPricingFilter(v.pricing, filters)))
    return { versions: [], note: `“${model.name}” is hidden by your “Hide paid” filter.` };

  // Never relaxed for the own/official tabs: a lookup is not scoped to the viewer's models.
  const allowedBaseModels = resources
    .filter((r) => r.type === model.type)
    .flatMap((r) => r.baseModels);

  const visible = selectableVersions(model.versions, {
    canGenerate: ctx.canGenerate,
    coverageNext: ctx.coverageNext,
    member: ctx.member,
    isCheckpoint,
    loadedOnly: filters.loadedOnly,
    turboOnly: filters.turboOnly,
    excludeTurbo: ctx.excludeTurbo,
    skipBaseModel: false,
    modelBaseModels: allowedBaseModels,
    excludedIds: ctx.excludedIds,
  });

  const reasonFor = (v: V): HiddenReason | null => {
    if (ctx.excludedIds.includes(v.id)) return 'added';
    if (allowedBaseModels.length > 0 && !allowedBaseModels.includes(v.baseModel))
      return 'baseModel';
    if (
      ctx.canGenerate &&
      !versionGeneratableFor(v, {
        coverageNext: ctx.coverageNext,
        member: !!ctx.member,
        isCheckpoint,
      })
    )
      return 'generate';
    if (filters.loadedOnly && !v.generatorLoaded) return 'loaded';
    if (filters.turboOnly && !v.turbo) return 'turbo';
    if (ctx.excludeTurbo && v.turbo) return 'excludeTurbo';
    return null;
  };

  const noteFor = (reason: HiddenReason | null, subject: string, baseModels: string[]) => {
    switch (reason) {
      case 'added':
        return `${subject} is already added.`;
      case 'baseModel':
        return `${subject} is for ${listOf(
          baseModels
        )}, which isn't compatible with your selected resources (${listOf(allowedBaseModels)}).`;
      case 'generate':
        return `${subject} isn't available for generation.`;
      case 'loaded':
        return `${subject} is hidden by your “Loaded only” filter.`;
      case 'turbo':
        return `${subject} is hidden by your “Turbo only” filter.`;
      case 'excludeTurbo':
        return `${subject} is a turbo version, which can't be added here.`;
      default:
        return `${subject} can't be added here.`;
    }
  };

  const requested = ctx.modelVersionId
    ? model.versions.find((v) => v.id === ctx.modelVersionId)
    : undefined;

  if (requested) {
    if (visible.includes(requested)) return { versions: [requested], note: null };
    const note = noteFor(reasonFor(requested), `${requested.name} of “${model.name}”`, [
      requested.baseModel,
    ]);
    return {
      versions: visible,
      note: visible.length ? `${note} Versions you can add are shown below.` : note,
    };
  }

  if (visible.length) return { versions: visible, note: null };

  const reasons = model.versions.map(reasonFor);
  const reason = reasons.every((r) => r === 'baseModel') ? 'baseModel' : reasons[0];
  return {
    versions: [],
    note: noteFor(
      reason,
      `“${model.name}”`,
      model.versions.map((v) => v.baseModel)
    ),
  };
}
