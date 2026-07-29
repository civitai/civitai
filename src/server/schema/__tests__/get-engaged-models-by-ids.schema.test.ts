import { describe, it, expect } from 'vitest';
import { getEngagedModelsByIdsSchema } from '~/server/schema/user.schema';

// PR1 of the getEngagedModels freeze-fix: the per-visible-set membership input is bounded
// (min 1, max 200) so a caller can never re-open the unbounded whole-history door that froze
// an api-primary pod. Over-cap must REJECT (not truncate) so the widening surfaces loudly.
describe('getEngagedModelsByIdsSchema', () => {
  it('accepts a valid bounded modelIds array', () => {
    const res = getEngagedModelsByIdsSchema.safeParse({ modelIds: [1, 2, 3] });
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.modelIds).toEqual([1, 2, 3]);
  });

  it('accepts exactly 200 ids (the cap)', () => {
    const modelIds = Array.from({ length: 200 }, (_, i) => i + 1);
    const res = getEngagedModelsByIdsSchema.safeParse({ modelIds });
    expect(res.success).toBe(true);
  });

  it('rejects 201 ids (over cap) — does not truncate', () => {
    const modelIds = Array.from({ length: 201 }, (_, i) => i + 1);
    const res = getEngagedModelsByIdsSchema.safeParse({ modelIds });
    expect(res.success).toBe(false);
  });

  it('rejects an empty array (min 1)', () => {
    const res = getEngagedModelsByIdsSchema.safeParse({ modelIds: [] });
    expect(res.success).toBe(false);
  });

  it('rejects a missing modelIds field', () => {
    const res = getEngagedModelsByIdsSchema.safeParse({});
    expect(res.success).toBe(false);
  });

  it('rejects non-number ids', () => {
    const res = getEngagedModelsByIdsSchema.safeParse({ modelIds: ['a', 'b'] });
    expect(res.success).toBe(false);
  });
});
