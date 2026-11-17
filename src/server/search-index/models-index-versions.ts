import type { Prisma } from '@prisma/client';
import { modelVersionPricingSignals } from '@civitai/buzz';
import type { RecommendedSettingsSchema } from '~/server/schema/model-version.schema';
import type { modelSearchIndexSelect } from '~/server/selectors/model.selector';
import { getVersionAccelerator } from '~/server/search-index/version-accelerator';
import type { HiddenModelMetrics } from '~/server/utils/model-metric-privacy';
import type { getModelVersionPaidAccessTerms } from '~/server/services/paid-access.service';
import type { BaseModel } from '~/shared/constants/basemodel.constants';
import { getPartnerDisclosure } from '~/shared/constants/model-version-flags.constants';
import { indexedVersionEligibility } from '~/shared/generation/coverage-fields';
import type { ModelType } from '~/shared/utils/prisma/enums';
import { isGeneratorReady } from '~/shared/generation/generator-readiness';

type IndexedModelVersion = Prisma.ModelGetPayload<{
  select: typeof modelSearchIndexSelect;
}>['modelVersions'][number];

type VersionMetricRow = {
  generationCount: number;
  downloadCount: number;
  thumbsUpCount: number;
  thumbsDownCount: number;
};

// Nested per-version metrics ship in `displayedAttributes`, so they must obey the
// same model-level hide flags as the card — otherwise the raw hidden number leaks.
// The search-index version selector carries no earned/tipped (buzz) field, so only
// downloads + generations are maskable here.
function maskHiddenVersionMetrics<T extends VersionMetricRow | undefined>(
  metrics: T,
  hidden: HiddenModelMetrics
) {
  if (!metrics) return metrics;
  return {
    ...metrics,
    downloadCount: hidden.downloads ? null : metrics.downloadCount,
    generationCount: hidden.generations ? null : metrics.generationCount,
  };
}

// `flags` never enters a document: `version` and `versions` are displayed attributes, and the
// raw number carries moderator bits. Only the partner disclosure booleans go in.

/** The model's lead version, as the document's top-level `version`. */
export function toIndexedVersion(version: IndexedModelVersion, hidden: HiddenModelMetrics) {
  const { files: _files, flags, ...rest } = version;
  return {
    ...rest,
    ...getPartnerDisclosure(flags),
    metrics: maskHiddenVersionMetrics(rest.metrics[0], hidden),
    hashes: rest.hashes.map((hash) => hash.hash),
    hashData: rest.hashes.map((hash) => ({ hash: hash.hash, type: hash.hashType })),
    settings: rest.settings as RecommendedSettingsSchema,
    baseModel: rest.baseModel as BaseModel,
  };
}

/** Every version, as the document's `versions[]`. */
export function toIndexedVersions(
  versions: IndexedModelVersion[],
  {
    hidden,
    paidAccessTerms,
    eligibility,
  }: {
    hidden: HiddenModelMetrics;
    paidAccessTerms: Awaited<ReturnType<typeof getModelVersionPaidAccessTerms>>;
    eligibility: ReturnType<typeof indexedVersionEligibility>[];
  }
) {
  return versions.map(
    (
      {
        generationCoverage: _coverage,
        files: _files,
        hashes,
        settings,
        metrics: vMetrics,
        usageControl,
        flags,
        ...x
      },
      i
    ) => ({
      ...x,
      ...getPartnerDisclosure(flags),
      // Keeps the column's name but holds readiness — the loaded-only filter reads this.
      generatorLoaded: isGeneratorReady({ generatorLoaded: x.generatorLoaded, usageControl }),
      // A turbo block on the version is what makes it a turbo variant; the picker filters on this.
      turbo: !!(settings as RecommendedSettingsSchema | null)?.turbo,
      accelerator: getVersionAccelerator(settings),
      pricing: modelVersionPricingSignals({ paidAccess: paidAccessTerms.get(x.id) ?? null }),
      metrics: maskHiddenVersionMetrics(vMetrics[0], hidden),
      hashes: hashes.map((hash) => hash.hash),
      hashData: hashes.map((hash) => ({ hash: hash.hash, type: hash.hashType })),
      ...eligibility[i],
      settings: settings as RecommendedSettingsSchema,
      baseModel: x.baseModel as BaseModel,
    })
  );
}

/**
 * The partial document the moderator coverage reindex (`/api/mod/search/models-update`) writes:
 * `version` and `versions` replace the stored ones whole, so they follow the same flags rule.
 */
export function toCoverageUpdateDocument({
  id,
  type,
  modelVersions,
}: {
  id: number;
  type: ModelType;
  modelVersions: IndexedModelVersion[];
}) {
  const [lead] = modelVersions;
  if (!lead) return null;
  const { files: _files, generationCoverage: _gc, flags: leadFlags, ...version } = lead;
  const eligibility = modelVersions.map((x) => indexedVersionEligibility(x, type));

  return {
    id,
    version: {
      ...version,
      ...getPartnerDisclosure(leadFlags),
      hashes: version.hashes.map((hash) => hash.hash),
    },
    versions: modelVersions.map(
      ({ generationCoverage: _coverage, files: _f, hashes, usageControl, flags, ...x }, i) => ({
        ...x,
        ...getPartnerDisclosure(flags),
        // Keeps the column's name but holds readiness — see toIndexedVersions.
        generatorLoaded: isGeneratorReady({ generatorLoaded: x.generatorLoaded, usageControl }),
        hashes: hashes.map((hash) => hash.hash),
        ...eligibility[i],
      })
    ),
    canGenerate: eligibility.some((x) => x.canGenerate),
    canGenerateNext: eligibility.some((x) => x.canGenerateNext),
  };
}
