import { ModelUsageControl } from '~/shared/utils/prisma/enums';

export type GeneratorReadiness = 'loaded' | 'external' | 'cold';

export type VersionReadiness = { generatorLoaded?: boolean | null; usageControl?: string | null };

/**
 * `ModelVersion.generatorLoaded` is false forever for an `ExternalGeneration` version: a third party
 * serves it, so it has no weights to become resident and the sync job never marks it. The
 * orchestrator can't fill the gap — its availability union has no "served elsewhere" state.
 */
export function generatorReadiness(version: VersionReadiness): GeneratorReadiness {
  if (version.usageControl === ModelUsageControl.ExternalGeneration) return 'external';
  return version.generatorLoaded ? 'loaded' : 'cold';
}

export function isGeneratorReady(version: VersionReadiness) {
  return generatorReadiness(version) !== 'cold';
}
