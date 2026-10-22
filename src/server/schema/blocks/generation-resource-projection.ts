/**
 * App Blocks (Phase-2a PR-C) — the SINGLE canonical "safe subset" a picked or
 * rehydrated generation resource is projected to before it crosses the trust
 * boundary into a block iframe. Used by BOTH:
 *   1. PageBlockHost's `RESOURCE_PICKER_RESULT` (the widened OPEN_RESOURCE_PICKER
 *      projection), and
 *   2. `GET /api/v1/blocks/generation-resources` (rehydrate a saved set of
 *      generation resources on load, by version id).
 *
 * Keeping it in ONE place guarantees the picker result and the rehydrate endpoint
 * can NEVER drift on which fields are public — the security-relevant invariant.
 *
 * PUBLIC fields ONLY — the user's own recommended-settings + public trained words,
 * everything a block needs to render a per-resource weight slider (strength +
 * clamp range), show trigger words, and label the resource. NEVER project
 * availability / hasAccess / usageControl / earlyAccess / minor / poi / sfwOnly /
 * cover-image / substitute internals.
 *
 * Pure (no React, no Prisma, no server imports) so it is importable from the client
 * host, the REST endpoint, and the node unit-test env alike.
 */

/** The public projection handed to a block for one generation resource. */
export type SafeGenerationResource = {
  /** GenerationResource.id — the modelVersionId at the wire. */
  versionId: number;
  modelId: number;
  modelName: string;
  versionName: string;
  baseModel: string;
  modelType: string;
  /** Recommended default resource weight (public). */
  strength: number;
  /** Recommended min/max weight clamp (public). */
  minStrength: number;
  maxStrength: number;
  /** Public trigger words. */
  trainedWords: string[];
  /** Public recommended clip-skip; null when the resource has none. */
  clipSkip: number | null;
};

/**
 * The minimal structural shape both sources satisfy: the picker's
 * `GenerationResource` (onSelect) and `getResourceData`'s `GenerationResource &
 * { air }` both expose `id`/`name`/`baseModel`/settings at the top level and
 * `model.{id,name,type}`. Typed structurally (not against the full
 * `GenerationResource`) so this module needs no server-type import.
 */
export type ProjectableGenerationResource = {
  id: number;
  name: string;
  baseModel: string;
  strength?: number | null;
  settings?: {
    strength?: { min: number; max: number; default: number } | null;
    clipSkip?: number | null;
  } | null;
  trainedWords?: string[] | null;
  model: { id: number; name: string; type: string };
};

/**
 * Project a resource to the public {@link SafeGenerationResource} subset. The block keeps
 * the FLAT strength fields (public contract), read off `settings` with the SAME defaults
 * `getResourceData` uses, so a picked and a rehydrated resource look identical.
 * `clipSkip` has no default (a resource legitimately has none) → `null`.
 */
export function projectSafeGenerationResource(
  r: ProjectableGenerationResource
): SafeGenerationResource {
  return {
    versionId: r.id,
    modelId: r.model.id,
    modelName: r.model.name,
    versionName: r.name,
    baseModel: r.baseModel,
    modelType: r.model.type,
    strength: r.strength ?? r.settings?.strength?.default ?? 1,
    minStrength: r.settings?.strength?.min ?? -1,
    maxStrength: r.settings?.strength?.max ?? 2,
    trainedWords: r.trainedWords ?? [],
    clipSkip: r.settings?.clipSkip ?? null,
  };
}
