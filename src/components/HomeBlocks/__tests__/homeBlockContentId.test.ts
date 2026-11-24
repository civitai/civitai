import { describe, expect, it } from 'vitest';
import { homeBlockContentId } from '~/components/HomeBlocks/homeBlockContentId';

// Rows as `homeBlock.getHomeBlocks` lists them. Ids, owners and sources are pairwise distinct, so
// each answer can only have come from one field.
describe('homeBlockContentId', () => {
  it("a clone of a system block reads its source's content", () => {
    expect(homeBlockContentId({ id: 4101, sourceId: 37, source: { userId: -1 } })).toBe(37);
  });

  it('the system block itself reads by its own id', () => {
    expect(homeBlockContentId({ id: 37, sourceId: null })).toBe(37);
    expect(homeBlockContentId({ id: 38 })).toBe(38);
  });

  it("a viewer's own block reads by its own id", () => {
    expect(homeBlockContentId({ id: 4102, sourceId: null, source: null })).toBe(4102);
  });

  it('a clone whose source is not a system block reads by its own id', () => {
    expect(homeBlockContentId({ id: 4103, sourceId: 52, source: { userId: 9001 } })).toBe(4103);
  });

  it('a clone listed without its source reads by its own id', () => {
    expect(homeBlockContentId({ id: 4104, sourceId: 61 })).toBe(4104);
    expect(homeBlockContentId({ id: 4105, sourceId: 62, source: null })).toBe(4105);
  });
});
