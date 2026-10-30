/**
 * The indexed half of the coverage switch. `GenerationCoverage`'s two columns are indexed as two
 * fields, and the Flipt flag decides which one is live — the server filters the search by it and the
 * client re-checks the same field on the hits it gets back. Both sides read it from here so they
 * cannot end up gating on different rules; `no-divergent-coverage-read` keeps the choice here.
 *
 * Client-safe on purpose: the server resolves the flag, and passes the answer down as a boolean.
 */

import { isGenerationEligible } from '@civitai/shared/generation-eligibility';
import { and, eq, ne, or } from '~/shared/utils/meili-filter';

export type CoverageIndexField = 'canGenerate' | 'canGenerateNext';

export function coverageIndexField(coverageNext?: boolean): CoverageIndexField {
  return coverageNext ? 'canGenerateNext' : 'canGenerate';
}

/**
 * The indexed half of `coveredForUser`: whether THIS user may generate with one version.
 *
 * A non-member reads the live field, plus an expansion CHECKPOINT that is already resident — the
 * indexed `generatorLoaded` is `isGeneratorReady`, so it already answers "ready", not "resident".
 * The non-checkpoint half of the expansion is file-format support, so it is not gated.
 */
export function versionGeneratableFor(
  version: { canGenerate?: boolean; canGenerateNext?: boolean; generatorLoaded?: boolean },
  audience: { coverageNext?: boolean; member: boolean; isCheckpoint: boolean }
) {
  const { coverageNext, member, isCheckpoint } = audience;
  if (!coverageNext || member || !isCheckpoint) return versionCanGenerate(version, coverageNext);
  return (
    versionCanGenerate(version, false) || (!!version.canGenerateNext && !!version.generatorLoaded)
  );
}

/** The per-version eligibility both models-index writers store, read back by `versionGeneratableFor`. */
export function indexedVersionEligibility(
  version: {
    generationCoverage?: { covered?: boolean | null; coveredNext?: boolean | null } | null;
    baseModel: string;
    flags: number;
  },
  modelType: Parameters<typeof isGenerationEligible>[0]['modelType']
) {
  const { generationCoverage: coverage, baseModel, flags } = version;
  const eligible = (covered: boolean | null | undefined) =>
    isGenerationEligible({ covered, coveredLive: coverage?.covered, baseModel, modelType, flags });
  return {
    canGenerate: eligible(coverage?.covered),
    canGenerateNext: eligible(coverage?.coveredNext),
  };
}

/**
 * A search hit's Create, judged on `hit.version` because that is the version the card's button
 * opens. The model-level `canGenerate` is any version, on the live rule only.
 */
export function searchHitCanGenerate(
  hit: {
    type: string;
    version: { id: number };
    versions?: {
      id: number;
      canGenerate?: boolean;
      canGenerateNext?: boolean;
      generatorLoaded?: boolean;
    }[];
  },
  audience: { coverageNext?: boolean; member: boolean }
) {
  const version = hit.versions?.find((v) => v.id === hit.version.id);
  if (!version) return false;
  return versionGeneratableFor(version, { ...audience, isCheckpoint: hit.type === 'Checkpoint' });
}

/**
 * The Meili-filter form of `versionGeneratableFor`, for the MODEL-level page filter.
 *
 * Coarse on purpose: Meili matching a nested array only proves SOME version qualified, so this is a
 * superset of the true per-version answer and `selectableVersions` narrows it. Only the `true`
 * case takes the audience — the client treats `canGenerate: false` as no filter at all, so
 * widening that one would filter server-side against nothing on the client.
 */
export function coverageFilter({
  canGenerate,
  coverageNext,
  member,
}: {
  canGenerate?: boolean;
  coverageNext: boolean;
  member: boolean;
}) {
  if (canGenerate === undefined) return null;
  if (!coverageNext || member || !canGenerate)
    return eq(coverageIndexField(coverageNext), canGenerate);
  return or(
    eq('canGenerate', true),
    and(
      eq('canGenerateNext', true),
      // Per ROW, like `coveredForUserSql` — a page can mix types, so a single isCheckpoint
      // argument would gate the non-checkpoint half this rule exempts.
      or(ne('type', 'Checkpoint'), eq('versions.generatorLoaded', true))
    )
  );
}

export function versionCanGenerate(
  version: { canGenerate?: boolean; canGenerateNext?: boolean },
  coverageNext?: boolean
) {
  return version[coverageIndexField(coverageNext)];
}
