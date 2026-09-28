import { describe, expect, it } from 'vitest';
import { isNavLinkActive, navHref } from '$lib/nav-links';
import { applyGrants, canAccess, navForUser, pageAccessState } from '$lib/server/access';

const page = { path: '/models/minor-hash-matches', label: 'Minor Hash Matches' };
const appeals = { path: page.path, query: 'tab=appeals', label: 'Model Flag Appeals' };
const siblings = [page, appeals];
const at = (href: string) => new URL(href, 'https://mod.test');

describe('navHref', () => {
  it('carries a view link query', () => {
    expect(navHref(appeals)).toBe('/models/minor-hash-matches?tab=appeals');
    expect(navHref(page)).toBe('/models/minor-hash-matches');
  });
});

describe('isNavLinkActive', () => {
  it('marks the view, not the page, while its query is on the URL', () => {
    const url = at('/models/minor-hash-matches?tab=appeals&page=2');
    expect(isNavLinkActive(appeals, siblings, url)).toBe(true);
    expect(isNavLinkActive(page, siblings, url)).toBe(false);
  });

  it('marks the page on any other tab', () => {
    const url = at('/models/minor-hash-matches?tab=auto');
    expect(isNavLinkActive(appeals, siblings, url)).toBe(false);
    expect(isNavLinkActive(page, siblings, url)).toBe(true);
    expect(isNavLinkActive(page, siblings, at('/models/minor-hash-matches'))).toBe(true);
  });

  it('matches neither on another page', () => {
    const url = at('/bounties/poi-appeals?tab=appeals');
    expect(isNavLinkActive(appeals, siblings, url)).toBe(false);
    expect(isNavLinkActive(page, siblings, url)).toBe(false);
  });
});

describe('a view link in NAVIGATION', () => {
  const reviewer = { roles: ['moderator:reviewer'] };
  const labelsUnder = (group: string) =>
    navForUser(reviewer)
      .find((l) => l.path === group)
      ?.children?.map((c) => c.label);

  it('reaches whoever holds the page grant, with no grant of its own', () => {
    applyGrants({ '/models/minor-hash-matches': ['moderator:reviewer'] });
    expect(labelsUnder('/models')).toEqual(['Minor Hash Matches', 'Model Flag Appeals']);
    expect(canAccess(reviewer, '/models/minor-hash-matches')).toBe(true);
  });

  it('is hidden from whoever lacks the page grant', () => {
    applyGrants({ '/bounties/poi-appeals': ['moderator:reviewer'] });
    expect(labelsUnder('/models')).toBeUndefined();
  });

  it('is not offered as a separate grant on /admin', () => {
    const models = pageAccessState().tree.find((n) => n.key === '/models');
    expect(models?.children.map((c) => c.label)).toEqual(['Minor Hash Matches']);
  });
});
