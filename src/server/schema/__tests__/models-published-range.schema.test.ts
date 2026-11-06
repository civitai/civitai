import { describe, expect, it } from 'vitest';
import { getAllModelsSchema, modelsEndpointSchema } from '~/server/schema/model.schema';

describe('published range on the model feed input', () => {
  it('is accepted by getAll', () => {
    const parsed = getAllModelsSchema.parse({
      publishedFrom: '2024-12-01',
      publishedTo: '2024-12-31',
    });
    expect(parsed.publishedFrom).toBe('2024-12-01');
    expect(parsed.publishedTo).toBe('2024-12-31');
  });

  it('rejects a date that is not a real day', () => {
    expect(getAllModelsSchema.safeParse({ publishedFrom: '2024-02-31' }).success).toBe(false);
  });

  // /api/v1/models extends getAll's schema and is a documented contract: a new field there is a
  // new public query param, which needs its docs page first.
  it('is not a public /api/v1/models query param', () => {
    expect(Object.keys(modelsEndpointSchema.shape)).not.toContain('publishedFrom');
    const parsed = modelsEndpointSchema.parse({
      publishedFrom: '2024-12-01',
      publishedTo: '2024-12-31',
    });
    expect(parsed).not.toHaveProperty('publishedFrom');
    expect(parsed).not.toHaveProperty('publishedTo');
  });
});
