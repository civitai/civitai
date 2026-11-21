import { describe, expect, it } from 'vitest';
import { isAdFreeRoute } from '../ad-free-routes';

describe('isAdFreeRoute', () => {
  it('keeps the ad stack off every takedown request page and the private case page', () => {
    expect(isAdFreeRoute('/requests', '/requests')).toBe(true);
    expect(isAdFreeRoute('/requests/[process]', '/requests/dmca-notice')).toBe(true);
    expect(isAdFreeRoute('/requests/case/[publicRef]', '/requests/case/TD-26-ABC123')).toBe(true);
    // A request URL the app answered with its 404 page.
    expect(isAdFreeRoute('/404', '/requests/case/not-a-ref#t=abc')).toBe(true);
  });

  it('still allows ads on an ordinary page, and keeps the existing exclusions', () => {
    expect(isAdFreeRoute('/images', '/images')).toBe(false);
    expect(isAdFreeRoute('/requestsx', '/requestsx')).toBe(false);
    expect(isAdFreeRoute('/gift/[code]', '/gift/abc')).toBe(true);
    expect(isAdFreeRoute('/models/[id]/edit', '/models/1/edit?x=1')).toBe(true);
  });
});
