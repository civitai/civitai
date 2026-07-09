import { describe, expect, it } from 'vitest';
import type { FeatureAccess } from '~/server/services/feature-flags.service';
import {
  buildRumExperimentAttributes,
  RUM_EXPERIMENT_ATTR_PREFIX,
  RUM_EXPERIMENT_FLAGS,
} from '~/utils/faro/experimentFlags';

/**
 * Tests the RUM experiment-segmentation mechanism. `buildRumExperimentAttributes` is the
 * load-bearing pure function: FaroProvider calls it with the resolved feature flags and spreads
 * its output VERBATIM into `initializeFaro`'s `sessionTracking.session.attributes` — so testing
 * this output IS testing the attributes that get set on the session at init (which then ride on
 * `meta.session.attributes` → Loki `session_attr_exp_*` of every beacon).
 */

describe('RUM_EXPERIMENT_FLAGS (curated allowlist)', () => {
  it('includes the feedReserveCls experiment with its explicit exp_ attribute name', () => {
    const entry = RUM_EXPERIMENT_FLAGS.find((f) => f.flag === 'feedReserveCls');
    expect(entry).toBeDefined();
    expect(entry?.attr).toBe('exp_feed_reserve_cls');
  });

  it('includes the genTabDeferView experiment with its explicit exp_ attribute name', () => {
    const entry = RUM_EXPERIMENT_FLAGS.find((f) => f.flag === 'genTabDeferView');
    expect(entry).toBeDefined();
    expect(entry?.attr).toBe('exp_gen_tab_defer_view');
  });

  it('every curated attribute uses the exp_ prefix (greppable Loki field contract)', () => {
    for (const { attr } of RUM_EXPERIMENT_FLAGS) {
      expect(attr.startsWith(RUM_EXPERIMENT_ATTR_PREFIX)).toBe(true);
    }
  });

  it('has no duplicate attribute names (each maps to a distinct Loki field)', () => {
    const attrs = RUM_EXPERIMENT_FLAGS.map((f) => f.attr);
    expect(new Set(attrs).size).toBe(attrs.length);
  });
});

describe('buildRumExperimentAttributes', () => {
  it('emits "true" for an enabled curated flag', () => {
    const attrs = buildRumExperimentAttributes({ feedReserveCls: true });
    expect(attrs.exp_feed_reserve_cls).toBe('true');
  });

  it('emits "false" for a disabled curated flag (the off cohort must be queryable too)', () => {
    const attrs = buildRumExperimentAttributes({ feedReserveCls: false });
    expect(attrs.exp_feed_reserve_cls).toBe('false');
  });

  it('emits "true"/"false" cohorts for the genTabDeferView experiment', () => {
    expect(buildRumExperimentAttributes({ genTabDeferView: true }).exp_gen_tab_defer_view).toBe(
      'true'
    );
    expect(buildRumExperimentAttributes({ genTabDeferView: false }).exp_gen_tab_defer_view).toBe(
      'false'
    );
  });

  it('treats a missing flag as off ("false"), never undefined/absent', () => {
    const attrs = buildRumExperimentAttributes({});
    expect(attrs.exp_feed_reserve_cls).toBe('false');
    expect(attrs.exp_gen_tab_defer_view).toBe('false');
  });

  it('coerces every value to a string (MetaAttributes must be strings)', () => {
    const attrs = buildRumExperimentAttributes({ feedReserveCls: true });
    for (const value of Object.values(attrs)) {
      expect(typeof value).toBe('string');
    }
  });

  it('only emits allowlisted flags — never leaks a non-curated flag onto beacons', () => {
    // A truthy flag that is NOT in the curated allowlist must not appear as any attribute.
    const features = {
      feedReserveCls: true,
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

  it('emits exactly one attribute per curated flag', () => {
    const attrs = buildRumExperimentAttributes({ feedReserveCls: true });
    expect(Object.keys(attrs).length).toBe(RUM_EXPERIMENT_FLAGS.length);
  });
});
