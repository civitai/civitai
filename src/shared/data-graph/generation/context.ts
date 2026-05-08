import type { FeatureAccess } from '~/server/services/feature-flags.service';

export type GenerationCtx = {
  /** User's generation limits based on their tier */
  limits: {
    maxQuantity: number;
    maxResources: number;
  };
  /** User information */
  user: {
    isMember: boolean;
    tier: 'free' | 'founder' | 'bronze' | 'silver' | 'gold';
  };
  /** Feature flags from FeatureFlagsProvider (client) / getFeatureFlags (server) */
  flags?: Partial<FeatureAccess>;
  /**
   * Ecosystem keys gated for the current user (operator-controlled
   * `disabledEcosystems`/`modOnlyEcosystems`/`testingEcosystems` filtered
   * down to what should be hidden for this user). Server-resolved so the
   * Flipt evaluation never leaves the server.
   */
  gatedEcosystems?: string[];
  /**
   * Model version IDs gated for the current user (operator-controlled
   * `disabledIds`/`modOnlyIds`/`testingIds` filtered down to what should be
   * hidden for this user). Model nodes drop these from their `versions`
   * meta so disabled/restricted versions never appear in graph-driven
   * version selectors.
   */
  gatedVersionIds?: number[];
};
