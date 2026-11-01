import { ecosystemById } from '~/shared/constants/basemodel.constants';
import {
  HOSTED_MODEL_CATALOG,
  hostedModelUrl,
  type HostedModelCapability,
  type HostedModelCatalogEntry,
} from '~/shared/constants/hosted-model-catalog.constants';

export const HOSTED_MODELS_MAX = 3;

export type HostedModelSuggestion = {
  key: string;
  name: string;
  maker: string;
  modelId: number;
  url: string;
  goodAt: string;
  capabilities: HostedModelCapability[];
};

/**
 * Catalog entries ranked by how many distinct `needs` they cover, catalog order breaking ties,
 * capped at `HOSTED_MODELS_MAX`. An entry covering none is never returned. Deliberately blind to the
 * viewer's browsing level: every hosted model is listed in every mode.
 */
export function matchHostedModels(
  needs: readonly HostedModelCapability[],
  catalog: readonly HostedModelCatalogEntry[] = HOSTED_MODEL_CATALOG
): HostedModelSuggestion[] {
  const wanted = new Set(needs);
  return catalog
    .map((entry, order) => ({
      entry,
      order,
      matched: entry.capabilities.filter((c) => wanted.has(c)).length,
    }))
    .filter(({ matched }) => matched > 0)
    .sort((a, b) => b.matched - a.matched || a.order - b.order)
    .slice(0, HOSTED_MODELS_MAX)
    .map(({ entry }) => {
      const ecosystem = ecosystemById.get(entry.ecosystemId);
      if (!ecosystem) throw new Error(`hosted model ${entry.modelId}: unknown ecosystem`);
      return {
        key: ecosystem.key,
        name: entry.name,
        maker: entry.maker,
        modelId: entry.modelId,
        url: hostedModelUrl(entry.modelId),
        goodAt: entry.goodAt,
        capabilities: [...entry.capabilities],
      };
    });
}
