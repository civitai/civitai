import { describe, expect, it } from 'vitest';
import { activeHref, NAV_ITEMS } from './nav';

describe('activeHref', () => {
  it.each([
    ['/home', '/home'],
    ['/play', '/play'],
    ['/codex', '/codex'],
    ['/shop', '/shop'],
    ['/shop/inventory', '/shop'],
  ])('puts %s on the %s tab', (path, href) => {
    expect(activeHref(path)).toBe(href);
  });

  it('keeps the pages reached from Home on the Home tab', () => {
    for (const path of ['/judgments', '/leaderboard']) expect(activeHref(path)).toBe('/home');
  });

  it('does not match on a shared prefix alone', () => {
    expect(activeHref('/playground')).toBeNull();
    expect(activeHref('/homestead')).toBeNull();
  });

  it('highlights nothing on a page with no tab, and on the welcome page', () => {
    expect(activeHref('/dev/simulate')).toBeNull();
    expect(activeHref('/')).toBeNull();
  });

  it('gives every tab a distinct address', () => {
    expect(new Set(NAV_ITEMS.map((item) => item.href)).size).toBe(NAV_ITEMS.length);
  });
});
