import { describe, expect, it } from 'vitest';
import { manifestSettingsSchema } from '../manifest-settings.meta.schema';

/**
 * Shape coverage for the manifest-settings meta-schema. This is the contract
 * the W2 webhook handler validates a `block.manifest.json` against on push,
 * and the same shape `validateBlockSettings` reads at runtime.
 *
 * Tests intentionally exercise both the discriminated-union narrowing AND the
 * cross-field superRefine pass — failures in either layer should surface as
 * meta-schema rejections, not generic "settings doesn't match" errors.
 */

describe('manifestSettingsSchema — happy paths', () => {
  it('accepts an empty record', () => {
    expect(manifestSettingsSchema.safeParse({}).success).toBe(true);
  });

  it('accepts the canonical generate-from-model shape', () => {
    const result = manifestSettingsSchema.safeParse({
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
        description: 'The checkpoint to use when this block runs on a LoRA without a per-user override.',
        default: null,
        widget_options: {
          resource_type: 'Checkpoint',
          filter_by_ecosystem: true,
        },
      },
      show_advanced: {
        scope: 'publisher',
        type: 'boolean',
        widget: 'toggle',
        label: 'Show advanced controls',
        description: 'Reveal seed, sampler, and step controls. Off by default for the one-tap UX.',
        default: false,
      },
      preferred_checkpoint_version_id: {
        scope: 'viewer',
        type: 'number',
        widget: 'resource_picker',
        label: 'My preferred checkpoint',
        description: 'Override the publisher default with your own choice.',
        default: null,
      },
    });
    expect(result.success).toBe(true);
  });

  it('defaults widget to the per-type sensible value when omitted', () => {
    const result = manifestSettingsSchema.safeParse({
      a_number: { scope: 'publisher', type: 'number', label: 'L', description: 'D' },
      a_string: { scope: 'publisher', type: 'string', label: 'L', description: 'D' },
      a_bool: { scope: 'publisher', type: 'boolean', label: 'L', description: 'D' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.a_number.widget).toBe('number');
      expect(result.data.a_string.widget).toBe('text');
      expect(result.data.a_bool.widget).toBe('toggle');
    }
  });
});

describe('manifestSettingsSchema — key validation', () => {
  it.each([
    'CamelCase',
    'kebab-case',
    'with space',
    '1starts_with_digit',
    '_leading_underscore',
    '',
    'a'.repeat(42),
  ])('rejects bad key %s', (key) => {
    const result = manifestSettingsSchema.safeParse({
      [key]: { scope: 'publisher', type: 'boolean', label: 'L', description: 'D' },
    });
    expect(result.success).toBe(false);
  });

  it.each(['a', 'a1', 'snake_case', 'budget_v2', 'a'.repeat(41)])(
    'accepts good key %s',
    (key) => {
      const result = manifestSettingsSchema.safeParse({
        [key]: { scope: 'publisher', type: 'boolean', label: 'L', description: 'D' },
      });
      expect(result.success).toBe(true);
    }
  );

  it('rejects >32 settings', () => {
    const tooMany: Record<string, unknown> = {};
    for (let i = 0; i < 33; i++) {
      tooMany[`field_${i}`] = { scope: 'publisher', type: 'boolean', label: 'L', description: 'D' };
    }
    expect(manifestSettingsSchema.safeParse(tooMany).success).toBe(false);
  });
});

describe('manifestSettingsSchema — base field validation', () => {
  it('rejects bad scope', () => {
    const result = manifestSettingsSchema.safeParse({
      x: { scope: 'admin', type: 'boolean', label: 'L', description: 'D' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty label/description', () => {
    expect(
      manifestSettingsSchema.safeParse({
        x: { scope: 'publisher', type: 'boolean', label: '', description: 'D' },
      }).success
    ).toBe(false);
    expect(
      manifestSettingsSchema.safeParse({
        x: { scope: 'publisher', type: 'boolean', label: 'L', description: '' },
      }).success
    ).toBe(false);
  });

  it('rejects oversized label/description', () => {
    expect(
      manifestSettingsSchema.safeParse({
        x: { scope: 'publisher', type: 'boolean', label: 'a'.repeat(81), description: 'D' },
      }).success
    ).toBe(false);
    expect(
      manifestSettingsSchema.safeParse({
        x: { scope: 'publisher', type: 'boolean', label: 'L', description: 'a'.repeat(281) },
      }).success
    ).toBe(false);
  });
});

describe('manifestSettingsSchema — number cross-field', () => {
  it('rejects min > max', () => {
    const result = manifestSettingsSchema.safeParse({
      n: { scope: 'publisher', type: 'number', label: 'L', description: 'D', min: 10, max: 5 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects default below min', () => {
    const result = manifestSettingsSchema.safeParse({
      n: {
        scope: 'publisher',
        type: 'number',
        label: 'L',
        description: 'D',
        min: 5,
        default: 1,
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects default above max', () => {
    const result = manifestSettingsSchema.safeParse({
      n: {
        scope: 'publisher',
        type: 'number',
        label: 'L',
        description: 'D',
        max: 5,
        default: 99,
      },
    });
    expect(result.success).toBe(false);
  });

  it('accepts equal min and max (single-value)', () => {
    const result = manifestSettingsSchema.safeParse({
      n: {
        scope: 'publisher',
        type: 'number',
        label: 'L',
        description: 'D',
        min: 5,
        max: 5,
        default: 5,
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts null default for nullable widget (resource_picker)', () => {
    const result = manifestSettingsSchema.safeParse({
      n: {
        scope: 'publisher',
        type: 'number',
        widget: 'resource_picker',
        label: 'L',
        description: 'D',
        default: null,
      },
    });
    expect(result.success).toBe(true);
  });
});

describe('manifestSettingsSchema — string cross-field', () => {
  it('rejects widget=select without enum', () => {
    const result = manifestSettingsSchema.safeParse({
      s: { scope: 'publisher', type: 'string', widget: 'select', label: 'L', description: 'D' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects widget=select with empty enum', () => {
    const result = manifestSettingsSchema.safeParse({
      s: {
        scope: 'publisher',
        type: 'string',
        widget: 'select',
        label: 'L',
        description: 'D',
        enum: [],
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects default not in enum', () => {
    const result = manifestSettingsSchema.safeParse({
      s: {
        scope: 'publisher',
        type: 'string',
        widget: 'select',
        label: 'L',
        description: 'D',
        enum: ['a', 'b'],
        default: 'c',
      },
    });
    expect(result.success).toBe(false);
  });

  it('accepts widget=select with valid enum + default', () => {
    const result = manifestSettingsSchema.safeParse({
      s: {
        scope: 'publisher',
        type: 'string',
        widget: 'select',
        label: 'L',
        description: 'D',
        enum: ['flux', 'sdxl'],
        default: 'flux',
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid RegExp pattern', () => {
    const result = manifestSettingsSchema.safeParse({
      s: {
        scope: 'publisher',
        type: 'string',
        label: 'L',
        description: 'D',
        pattern: '(unclosed',
      },
    });
    expect(result.success).toBe(false);
  });

  it('accepts valid RegExp pattern', () => {
    const result = manifestSettingsSchema.safeParse({
      s: {
        scope: 'publisher',
        type: 'string',
        label: 'L',
        description: 'D',
        pattern: '^[a-z]+$',
      },
    });
    expect(result.success).toBe(true);
  });
});

describe('manifestSettingsSchema — widget gating', () => {
  it('rejects unknown widget for type=boolean', () => {
    const result = manifestSettingsSchema.safeParse({
      b: { scope: 'publisher', type: 'boolean', widget: 'slider', label: 'L', description: 'D' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown widget for type=number', () => {
    const result = manifestSettingsSchema.safeParse({
      n: { scope: 'publisher', type: 'number', widget: 'textarea', label: 'L', description: 'D' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown type', () => {
    const result = manifestSettingsSchema.safeParse({
      x: { scope: 'publisher', type: 'array', label: 'L', description: 'D' },
    });
    expect(result.success).toBe(false);
  });
});
