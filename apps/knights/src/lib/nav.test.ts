import { describe, expect, it } from 'vitest';
import { activeHref, NAV_ITEMS, navItems } from './nav';

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

describe('navItems', () => {
  it('leaves the Shop out for the Inquisitor, who earns no gold, and keeps it for players', () => {
    expect(navItems(true).map((item) => item.href)).toEqual(['/home', '/play', '/codex']);
    expect(navItems(false)).toBe(NAV_ITEMS);
  });
});
