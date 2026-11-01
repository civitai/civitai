import { describe, expect, it } from 'vitest';
import type { FeatureAccess } from '~/server/services/feature-flags.service';
import {
  buildRumExperimentAttributes,
  RUM_EXPERIMENT_ATTR_PREFIX,
  RUM_EXPERIMENT_FLAGS,
} from '~/utils/faro/experimentFlags';

describe('buildRumExperimentAttributes', () => {
  it('emits "true"/"false" cohorts for a curated flag (the off cohort must be queryable too)', () => {
    expect(buildRumExperimentAttributes({ genTabDeferView: true }).exp_gen_tab_defer_view).toBe(
      'true'
    );
    expect(buildRumExperimentAttributes({ genTabDeferView: false }).exp_gen_tab_defer_view).toBe(
      'false'
    );
  });

  it('carries the model-page deferral cohort under its exact Loki field name', () => {
    // A wire string: RUM queries match `session_attr_exp_model_page_defer_below_fold`.
    expect(
      buildRumExperimentAttributes({ modelPageDeferBelowFold: true })
        .exp_model_page_defer_below_fold
    ).toBe('true');
    expect(buildRumExperimentAttributes({}).exp_model_page_defer_below_fold).toBe('false');
  });

  it('treats a missing flag as off ("false"), never undefined/absent', () => {
    const attrs = buildRumExperimentAttributes({});
    expect(attrs.exp_gen_tab_defer_view).toBe('false');
  });

  it('only emits allowlisted flags — never leaks a non-curated flag onto beacons', () => {
    // A truthy flag that is NOT in the curated allowlist must not appear as any attribute.
    const features = {
      genTabDeferView: true,
      // Not in RUM_EXPERIMENT_FLAGS — must be dropped (cardinality/PII/noise guard).
      isModerator: true,
      redBrowsingLevel: true,
    } as unknown as Partial<FeatureAccess>;
    const attrs = buildRumExperimentAttributes(features);

    const emittedKeys = Object.keys(attrs);
    // Exactly the curated set, nothing else.
    expect(emittedKeys.sort()).toEqual(RUM_EXPERIMENT_FLAGS.map((f) => f.attr).sort());
    expect(emittedKeys).not.toContain('isModerator');
    expect(emittedKeys).not.toContain('redBrowsingLevel');
    // No emitted key escapes the exp_ prefix.
    for (const key of emittedKeys) {
      expect(key.startsWith(RUM_EXPERIMENT_ATTR_PREFIX)).toBe(true);
    }
  });
});
