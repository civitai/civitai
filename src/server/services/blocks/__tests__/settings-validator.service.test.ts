import { describe, expect, it } from 'vitest';
import type { ManifestSettings } from '../../../schema/blocks/manifest-settings.meta.schema';
import { validateBlockSettings } from '../settings-validator.service';

/**
 * Behavior coverage for the generic settings validator that replaces the
 * per-block-id schema map. Tests stick to pure-zod-derived shapes (no DB
 * mocking) because that's the whole point — cross-row checks live in
 * adjacent services and aren't this validator's responsibility.
 */

const publisherManifest: ManifestSettings = {
  buzz_budget_per_gen: {
    scope: 'publisher',
    type: 'number',
    widget: 'number',
    label: 'Max Buzz per generation',
    description: 'Cap on Buzz spent per generation request.',
    default: 10,
    min: 1,
    max: 1000,
    requires_scope: 'ai:write:budgeted',
  },
  default_checkpoint_version_id: {
    scope: 'publisher',
    type: 'number',
    widget: 'resource_picker',
    label: 'Default checkpoint',
    description: 'The checkpoint to use when this block runs on a LoRA.',
    default: null,
  },
  show_advanced: {
    scope: 'publisher',
    type: 'boolean',
    widget: 'toggle',
    label: 'Show advanced controls',
    description: 'Reveal seed, sampler, and step controls.',
    default: false,
  },
  greeting: {
    scope: 'publisher',
    type: 'string',
    widget: 'text',
    label: 'Greeting',
    description: 'Static text shown in the block header.',
    default: 'hi',
    max_length: 20,
    pattern: '^[a-z !]+$',
  },
  ecosystem: {
    scope: 'publisher',
    type: 'string',
    widget: 'select',
    label: 'Ecosystem',
    description: 'Restrict to a single base model family.',
    enum: ['flux', 'sdxl'],
    default: 'flux',
  },
  viewer_pref: {
    scope: 'viewer',
    type: 'number',
    widget: 'number',
    label: 'Per-viewer override',
    description: 'Per-viewer numeric override.',
    default: 5,
  },
};

const declaredScopes = ['ai:write:budgeted', 'models:read:self', 'buzz:read:self'];

describe('validateBlockSettings — happy paths', () => {
  it('validates a complete publisher payload', () => {
    const result = validateBlockSettings({
      manifestSettings: publisherManifest,
      inputSettings: {
        buzz_budget_per_gen: 25,
        default_checkpoint_version_id: 691639,
        show_advanced: true,
        greeting: 'hello!',
        ecosystem: 'sdxl',
      },
      declaredScopes,
      forScope: 'publisher',
    });
    expect(result).toEqual({
      buzz_budget_per_gen: 25,
      default_checkpoint_version_id: 691639,
      show_advanced: true,
      greeting: 'hello!',
      ecosystem: 'sdxl',
    });
  });

  it('applies defaults for missing fields', () => {
    const result = validateBlockSettings({
      manifestSettings: publisherManifest,
      inputSettings: {},
      declaredScopes,
      forScope: 'publisher',
    });
    expect(result).toEqual({
      buzz_budget_per_gen: 10,
      default_checkpoint_version_id: null,
      show_advanced: false,
      greeting: 'hi',
      ecosystem: 'flux',
    });
  });

  it('strips fields from the wrong scope (publisher request swallows viewer fields)', () => {
    const result = validateBlockSettings({
      manifestSettings: publisherManifest,
      inputSettings: { viewer_pref: 99, buzz_budget_per_gen: 50 },
      declaredScopes,
      forScope: 'publisher',
    });
    expect(result.viewer_pref).toBeUndefined();
    expect(result.buzz_budget_per_gen).toBe(50);
  });

  it('returns only viewer fields when forScope=viewer', () => {
    const result = validateBlockSettings({
      manifestSettings: publisherManifest,
      inputSettings: { viewer_pref: 42, buzz_budget_per_gen: 999 },
      declaredScopes,
      forScope: 'viewer',
    });
    expect(result).toEqual({ viewer_pref: 42 });
  });

  it('strips unknown keys silently (no leak about which fields are recognized)', () => {
    const result = validateBlockSettings({
      manifestSettings: publisherManifest,
      inputSettings: {
        buzz_budget_per_gen: 50,
        nonexistent: 'oops',
        __proto__: 'oops',
      },
      declaredScopes,
      forScope: 'publisher',
    });
    expect(result.nonexistent).toBeUndefined();
    expect(result.__proto__).not.toBe('oops');
  });
});

describe('validateBlockSettings — requires_scope gating', () => {
  it('omits a field whose requires_scope is not in declaredScopes', () => {
    const result = validateBlockSettings({
      manifestSettings: publisherManifest,
      inputSettings: { buzz_budget_per_gen: 50 },
      declaredScopes: ['models:read:self'], // ai:write:budgeted absent
      forScope: 'publisher',
    });
    expect(result.buzz_budget_per_gen).toBeUndefined();
  });

  it('admits the field when the required scope IS declared', () => {
    const result = validateBlockSettings({
      manifestSettings: publisherManifest,
      inputSettings: { buzz_budget_per_gen: 50 },
      declaredScopes: ['ai:write:budgeted'],
      forScope: 'publisher',
    });
    expect(result.buzz_budget_per_gen).toBe(50);
  });
});

describe('validateBlockSettings — null vs undefined', () => {
  it('writes explicit null when the field has default: null', () => {
    const result = validateBlockSettings({
      manifestSettings: publisherManifest,
      inputSettings: { default_checkpoint_version_id: null },
      declaredScopes,
      forScope: 'publisher',
    });
    expect(result.default_checkpoint_version_id).toBeNull();
  });

  it('treats null on a non-nullable field as missing and falls back to default', () => {
    const result = validateBlockSettings({
      manifestSettings: publisherManifest,
      inputSettings: { buzz_budget_per_gen: null },
      declaredScopes,
      forScope: 'publisher',
    });
    expect(result.buzz_budget_per_gen).toBe(10);
  });
});

describe('validateBlockSettings — type + range errors', () => {
  it('rejects number out of range', () => {
    expect(() =>
      validateBlockSettings({
        manifestSettings: publisherManifest,
        inputSettings: { buzz_budget_per_gen: 99999 },
        declaredScopes,
        forScope: 'publisher',
      })
    ).toThrowError(/buzz_budget_per_gen.*<= 1000/);
  });

  it('rejects wrong type (string for number)', () => {
    expect(() =>
      validateBlockSettings({
        manifestSettings: publisherManifest,
        inputSettings: { buzz_budget_per_gen: '50' },
        declaredScopes,
        forScope: 'publisher',
      })
    ).toThrowError(/buzz_budget_per_gen.*finite number/);
  });

  it('rejects wrong type (number for boolean)', () => {
    expect(() =>
      validateBlockSettings({
        manifestSettings: publisherManifest,
        inputSettings: { show_advanced: 1 },
        declaredScopes,
        forScope: 'publisher',
      })
    ).toThrowError(/show_advanced.*boolean/);
  });

  it('rejects string exceeding max_length', () => {
    expect(() =>
      validateBlockSettings({
        manifestSettings: publisherManifest,
        inputSettings: { greeting: 'a'.repeat(50) },
        declaredScopes,
        forScope: 'publisher',
      })
    ).toThrowError(/greeting.*max length/);
  });

  it('rejects string failing pattern', () => {
    expect(() =>
      validateBlockSettings({
        manifestSettings: publisherManifest,
        inputSettings: { greeting: 'HELLO' }, // uppercase fails ^[a-z !]+$
        declaredScopes,
        forScope: 'publisher',
      })
    ).toThrowError(/greeting.*invalid/);
  });

  it('rejects string not in enum (select widget)', () => {
    expect(() =>
      validateBlockSettings({
        manifestSettings: publisherManifest,
        inputSettings: { ecosystem: 'sd15' },
        declaredScopes,
        forScope: 'publisher',
      })
    ).toThrowError(/ecosystem.*not in allowed values/);
  });

  it('rejects non-finite number (NaN, Infinity)', () => {
    expect(() =>
      validateBlockSettings({
        manifestSettings: publisherManifest,
        inputSettings: { buzz_budget_per_gen: Number.NaN },
        declaredScopes,
        forScope: 'publisher',
      })
    ).toThrowError(/finite number/);
    expect(() =>
      validateBlockSettings({
        manifestSettings: publisherManifest,
        inputSettings: { buzz_budget_per_gen: Number.POSITIVE_INFINITY },
        declaredScopes,
        forScope: 'publisher',
      })
    ).toThrowError(/finite number/);
  });
});

describe('validateBlockSettings — patterned-input length cap (ReDoS defense-in-depth)', () => {
  // Simulate a pattern that was STORED before the submission gate existed and
  // therefore has NO max_length (the runtime type is derived from the meta
  // schema, but a legacy JSONB row could omit it — the cast models that).
  const legacyPatternManifest = {
    legacy_code: {
      scope: 'publisher',
      type: 'string',
      widget: 'text',
      label: 'Legacy code',
      description: 'A patterned field stored before max_length was required.',
      // deliberately a *polynomial* pattern with NO max_length declared
      pattern: '^(a+)+b$',
      // note: no max_length
    },
  } as unknown as ManifestSettings;

  it('rejects an over-cap input before running the regex (no max_length declared)', () => {
    const huge = 'a'.repeat(5000); // > MAX_PATTERNED_INPUT_LEN (1000)
    expect(() =>
      validateBlockSettings({
        manifestSettings: legacyPatternManifest,
        inputSettings: { legacy_code: huge },
        declaredScopes,
        forScope: 'publisher',
      })
    ).toThrowError(/legacy_code.*exceeds max length 1000/);
  });

  it('does NOT freeze the event loop on a crafted pattern + long input (bounded time)', () => {
    // Without the length cap, `(a+)+b` on 5000 non-matching chars would hang
    // for many seconds. The cap rejects it in O(1). Assert it returns fast.
    const evil = 'a'.repeat(5000);
    const start = Date.now();
    expect(() =>
      validateBlockSettings({
        manifestSettings: legacyPatternManifest,
        inputSettings: { legacy_code: evil },
        declaredScopes,
        forScope: 'publisher',
      })
    ).toThrow();
    const elapsedMs = Date.now() - start;
    // Generous bound — a real ReDoS here is measured in seconds; the cap makes
    // this constant-time. 500ms leaves huge headroom for a loaded CI worker.
    expect(elapsedMs).toBeLessThan(500);
  });

  it('still validates a normal patterned value at/under the cap', () => {
    const result = validateBlockSettings({
      manifestSettings: publisherManifest,
      inputSettings: { greeting: 'hello!' }, // ^[a-z !]+$, max_length 20
      declaredScopes,
      forScope: 'publisher',
    });
    expect(result.greeting).toBe('hello!');
  });
});

describe('validateBlockSettings — no fail-open on the slug pattern (F3 regression)', () => {
  // The removed `safe-regex` gate false-positived on the canonical slug pattern
  // `^[a-z0-9]+(-[a-z0-9]+)*$` and made `manifestSettingsSchema.safeParse` FAIL,
  // which on the install/save paths fell through to `input.settings` — skipping
  // ALL field validation (the fail-open). The meta-schema now accepts the slug
  // pattern (compile-check only), so field validation actually runs against it.
  const slugManifest: ManifestSettings = {
    handle: {
      scope: 'publisher',
      type: 'string',
      widget: 'text',
      label: 'Handle',
      description: 'A slug the app uses as an identifier.',
      pattern: '^[a-z0-9]+(-[a-z0-9]+)*$',
      max_length: 40,
    },
  };

  it('parses the slug-pattern manifest via manifestSettingsSchema (no fail-open)', async () => {
    const { manifestSettingsSchema } = await import(
      '../../../schema/blocks/manifest-settings.meta.schema'
    );
    expect(manifestSettingsSchema.safeParse(slugManifest).success).toBe(true);
  });

  it('ENFORCES the slug pattern (rejects a value that violates it)', () => {
    expect(() =>
      validateBlockSettings({
        manifestSettings: slugManifest,
        inputSettings: { handle: 'Bad Handle!' }, // spaces + caps fail the slug pattern
        declaredScopes,
        forScope: 'publisher',
      })
    ).toThrowError(/handle.*invalid/);
  });

  it('accepts a value that satisfies the slug pattern', () => {
    const result = validateBlockSettings({
      manifestSettings: slugManifest,
      inputSettings: { handle: 'my-cool-app' },
      declaredScopes,
      forScope: 'publisher',
    });
    expect(result.handle).toBe('my-cool-app');
  });
});

describe('validateBlockSettings — empty manifest', () => {
  it('returns an empty object regardless of input', () => {
    const result = validateBlockSettings({
      manifestSettings: {},
      inputSettings: { foo: 1, bar: 'baz' },
      declaredScopes,
      forScope: 'publisher',
    });
    expect(result).toEqual({});
  });
});
