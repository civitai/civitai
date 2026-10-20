import { describe, expect, it } from 'vitest';
import { modelUpsertSchema } from '~/server/schema/model.schema';
import { modelVersionUpsertSchema2 } from '~/server/schema/model-version.schema';

// A model whose `meta` is JSON null reaches ModelUpsertForm as `meta: null`, and
// react-hook-form's `get` resolves every `meta.*` path on it to null rather than to the
// field's default — so the three switches submit null and the whole edit is rejected.
// 927 published models were in that state when this was found.
const NULL_TOGGLES = {
  hideBuzz: null,
  hideDownloads: null,
  hideGenerations: null,
} as const;

const baseModelInput = {
  id: 1,
  name: 'A model',
  type: 'LORA',
  status: 'Published',
  uploadType: 'Created',
  description: '<p>hello</p>',
  tagsOnModels: [],
  availability: 'Public',
};

describe('metric-privacy meta toggles', () => {
  it('accepts null toggles on a model', () => {
    const result = modelUpsertSchema.safeParse({
      ...baseModelInput,
      meta: { commentsLocked: false, ...NULL_TOGGLES },
    });

    expect(result.success).toBe(true);
  });

  it('accepts null toggles on a model version', () => {
    const result = modelVersionUpsertSchema2.safeParse({
      modelId: 1,
      name: 'v1',
      baseModel: 'SD 1.5',
      meta: NULL_TOGGLES,
    });

    expect(result.success).toBe(true);
  });

  it('still rejects a non-boolean toggle', () => {
    const result = modelUpsertSchema.safeParse({
      ...baseModelInput,
      meta: { commentsLocked: false, hideBuzz: 'yes' },
    });

    expect(result.success).toBe(false);
  });
});

describe('metric visibility choices', () => {
  it('stores hide and show, drops inherit, and clears the legacy flags on a model', () => {
    const result = modelUpsertSchema.parse({
      ...baseModelInput,
      meta: {
        commentsLocked: false,
        hideBuzz: true,
        metricVisibility: { buzz: 'inherit', downloads: 'show', generations: 'hide' },
      },
    });

    expect(result.meta).toMatchObject({
      metricVisibility: { downloads: 'show', generations: 'hide' },
      hideBuzz: null,
      hideDownloads: null,
      hideGenerations: null,
    });
    expect(result.meta?.metricVisibility).not.toHaveProperty('buzz');
  });

  it('does the same on a model version', () => {
    const result = modelVersionUpsertSchema2.parse({
      modelId: 1,
      name: 'v1',
      baseModel: 'SD 1.5',
      meta: { hideDownloads: true, metricVisibility: { buzz: 'show', downloads: 'inherit' } },
    });

    expect(result.meta).toEqual({
      metricVisibility: { buzz: 'show' },
      hideBuzz: null,
      hideDownloads: null,
      hideGenerations: null,
    });
  });

  it('leaves a legacy-only save as it was', () => {
    const result = modelVersionUpsertSchema2.parse({
      modelId: 1,
      name: 'v1',
      baseModel: 'SD 1.5',
      meta: { hideBuzz: true },
    });

    expect(result.meta).toEqual({ hideBuzz: true });
  });

  it('rejects a choice that is not inherit, hide or show', () => {
    const result = modelVersionUpsertSchema2.safeParse({
      modelId: 1,
      name: 'v1',
      baseModel: 'SD 1.5',
      meta: { metricVisibility: { buzz: 'visible' } },
    });

    expect(result.success).toBe(false);
  });
});
