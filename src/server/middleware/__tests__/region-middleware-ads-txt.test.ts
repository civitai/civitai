import { describe, expect, it } from 'vitest';
import { shouldRunRegionMiddleware } from '~/server/middleware/region-middleware-utils';

describe('region middlewares and ads.txt', () => {
  it('let a crawler in any region fetch /ads.txt, as /robots.txt', () => {
    expect(shouldRunRegionMiddleware('/ads.txt')).toBe(false);
    expect(shouldRunRegionMiddleware('/robots.txt')).toBe(false);
  });

  it('still run on pages (control)', () => {
    expect(shouldRunRegionMiddleware('/models')).toBe(true);
    expect(shouldRunRegionMiddleware('/ads.txt/x')).toBe(true);
  });
});
