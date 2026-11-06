import { describe, expect, it } from 'vitest';
import type { SiteAlert } from '~/shared/constants/site-alert.constants';
import {
  isValidAlertPathPattern,
  matchAlertPath,
  matchesAnyAlertPath,
  visibleSiteAlerts,
} from '~/shared/utils/site-alert-match';

describe('matchAlertPath', () => {
  it.each([
    ['/models/*/edit', '/models/123/edit', true],
    ['/models/*/edit', '/models/edit', false],
    ['/models/*/edit', '/models/1/2/edit', false],
    ['/models/*', '/models', false],
    ['/generate/**', '/generate', true],
    ['/generate/**', '/generate/a/b/c', true],
    ['/models/**/edit', '/models/edit', true],
    ['/models/**/edit', '/models/1/versions/2/edit', true],
    ['/models/**/edit', '/models/1/versions/2', false],
    ['/search/**', '/searching', false],
    ['/login', '/login', true],
    ['/login', '/login/popup-done', false],
    ['/', '/', true],
    ['/', '/models', false],
    ['/**', '/anything/at/all', true],
  ])('%s against %s → %s', (pattern, path, expected) => {
    expect(matchAlertPath(pattern, path)).toBe(expected);
  });

  it('ignores the query string, the hash, a trailing slash and letter case', () => {
    expect(matchAlertPath('/models/create', '/Models/Create/?ref=nav#top')).toBe(true);
    expect(matchAlertPath('/posts/*/edit', '/posts/9/edit?draft=1')).toBe(true);
  });
});

describe('matchesAnyAlertPath', () => {
  it('treats an empty list as every path', () => {
    expect(matchesAnyAlertPath([], '/images/1')).toBe(true);
  });

  it('matches when any one pattern does', () => {
    expect(matchesAnyAlertPath(['/login', '/models/*/edit'], '/models/4/edit')).toBe(true);
    expect(matchesAnyAlertPath(['/login', '/models/*/edit'], '/images/4')).toBe(false);
  });
});

describe('isValidAlertPathPattern', () => {
  it.each(['/models/*/edit', '/generate/**', '/', '/a/**/b'])('accepts %s', (p) => {
    expect(isValidAlertPathPattern(p)).toBe(true);
  });

  it.each([
    ['relative', 'models/1'],
    ['a wildcard inside a segment', '/mod*'],
    ['a query string', '/models?x=1'],
    ['whitespace', '/models /x'],
    ['too many globstars', '/**/a/**/b/**/c/**'],
    ['regex syntax', '/models/(\\d+)*'],
  ])('rejects %s', (_, p) => {
    expect(isValidAlertPathPattern(p)).toBe(false);
  });
});

describe('visibleSiteAlerts', () => {
  const NOW = Date.parse('2026-10-22T12:00:00Z');
  const alert = (over: Partial<SiteAlert>): SiteAlert => ({
    id: 1,
    severity: 'warning',
    title: 't',
    message: null,
    paths: [],
    surfaces: ['everywhere'],
    domains: ['all'],
    startsAt: '2026-10-22T11:00:00Z',
    endsAt: '2026-10-22T13:00:00Z',
    dismissible: true,
    ...over,
  });
  const ctx = { pathname: '/models/1/edit', domain: 'blue' as const, now: NOW };
  const ids = (alerts: SiteAlert[]) => visibleSiteAlerts(alerts, ctx).map((x) => x.id);

  it('drops alerts outside their window, path, domain or surface', () => {
    expect(
      ids([
        alert({ id: 1 }),
        alert({ id: 2, startsAt: '2026-10-22T12:30:00Z' }),
        alert({ id: 3, endsAt: '2026-10-22T12:00:00Z' }),
        alert({ id: 4, paths: ['/images/**'] }),
        alert({ id: 5, domains: ['red'] }),
        alert({ id: 6, surfaces: ['generator'] }),
        alert({ id: 7, domains: ['blue'], paths: ['/models/*/edit'] }),
      ])
    ).toEqual([7, 1]);
  });

  it('puts outages first, then the newest', () => {
    expect(
      ids([
        alert({ id: 1, severity: 'info' }),
        alert({ id: 2, severity: 'outage' }),
        alert({ id: 3, severity: 'info' }),
      ])
    ).toEqual([2, 3, 1]);
  });
});
