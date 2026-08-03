import type { FeatureAccess } from '~/server/services/feature-flags.service';
import type { GateRule } from './gates';
import type { ModelSubstitutionCollector } from './model-substitution';

export type GenerationCtx = {
  /** User's generation limits based on their tier */
  limits: {
    maxQuantity: number;
    maxResources: number;
    /**
     * Tier-based per-request video quantity for ecosystems that batch multiple
     * outputs in a single job (currently LTXV23). free=1, bronze=2, silver=3,
     * founder/gold=4. See VID_QUANTITY_BY_TIER.
     */
    vidQuantity: number;
  };
  /** User information */
  user: {
    isMember: boolean;
    tier: 'free' | 'founder' | 'bronze' | 'silver' | 'gold';
  };
  /** Feature flags from FeatureFlagsProvider (client) / getFeatureFlags (server) */
  flags?: Partial<FeatureAccess>;
  /**
   * Self-hosted ecosystem keys disabled for the current user (resolved from
   * the `selfHostedMode` toggle + membership). The ecosystem node keeps these
   * in `compatibleEcosystems` (shown-but-disabled) and rejects them on submit —
   * so the same gate is enforced server-side via `buildGenerationContext` and
   * surfaced as disabled options client-side.
   */
  selfHostedDisabledEcosystems?: string[];
  /**
   * Self-hosted toggle state for THIS user's request. Lets the ecosystem node
   * resolve `selfHostedDisabledEcosystems` to the right state (`memberOnly` →
   * upsell, otherwise `disabled`) within the unified gate-state map.
   */
  selfHostedMode?: 'enabled' | 'disabled' | 'memberOnly';
  /**
   * Gate rules that apply to this user (already audience-filtered server side —
   * see `applicableRulesFor`). The ecosystem / workflow / model nodes fold these
   * into their per-item gate-state map via `rulesToStates`, so a single
   * resolver drives hide/disable/upsell on both client and server.
   */
  gateRules?: GateRule[];
  /**
   * Per-REQUEST side channel recording silent checkpoint substitutions the
   * `modelLocked` clamp performs (issue #3520). Purely observational — see
   * `model-substitution.ts` for why the record cannot ride on the parsed value
   * (the model node's output schema strips unknown keys) and why the collector
   * must be attached to a freshly-built context object.
   *
   * ABSENT on the client: only the server's `buildGenerationContext` attaches
   * one, so an in-form parse in the browser records nothing and pays nothing.
   */
  modelSubstitutions?: ModelSubstitutionCollector;
};
