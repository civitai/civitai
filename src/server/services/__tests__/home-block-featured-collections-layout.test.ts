import { describe, expect, it } from 'vitest';
import { resolveFeaturedCollectionsLayout } from '~/server/services/home-block.service';

const resolve = resolveFeaturedCollectionsLayout;

describe('resolveFeaturedCollectionsLayout', () => {
  it('raises a fetch pool smaller than the visible slice', () => {
    expect(resolve({ limit: 8, rows: 2 }, 11).limit).toBe(14);
    expect(resolve({ limit: 8, rows: 4 }, 11).limit).toBe(28);
  });

  it('leaves a fetch pool already above the visible slice alone', () => {
    expect(resolve({ limit: 40, rows: 2 }, 11).limit).toBe(40);
    expect(resolve({ limit: 8, rows: 1 }, 11).limit).toBe(8);
  });

  it('keeps a stored maxPerUser of 0 as 0', () => {
    expect(resolve({ maxPerUser: 0 }, 11).maxPerUser).toBe(0);
    expect(resolve({}, 11).maxPerUser).toBe(2);
  });
});
