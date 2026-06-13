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
