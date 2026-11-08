import { describe, expect, it } from 'vitest';
import {
  appsRunBackTarget,
  parseAppsRunOrigin,
  withHomeLaunchOrigin,
  withRunLaunchOrigin,
} from '~/shared/utils/apps-run-origin';

/**
 * The run chrome's "where did you come from" signal: the home stamps `?from=home` on its
 * run links, the run page parses it, and the chrome's way out follows it.
 */
describe('parseAppsRunOrigin', () => {
  it('only the exact value `home` is the home', () => {
    expect(parseAppsRunOrigin('home')).toBe('home');
  });

  it.each([
    ['absent', undefined],
    ['empty', ''],
    ['another value', 'store'],
    ['different case', 'HOME'],
    ['a repeated param', ['home', 'home']],
    ['a number', 1],
  ])('anything else (%s) is the store', (_l, raw) => {
    expect(parseAppsRunOrigin(raw)).toBe('store');
  });
});

describe('withHomeLaunchOrigin', () => {
  it('adds from=home to a bare run path', () => {
    expect(withHomeLaunchOrigin('/apps/run/pixel-forge')).toBe('/apps/run/pixel-forge?from=home');
  });

  it('🔴 preserves an existing query (the store sub-listing `sl`) and the path', () => {
    expect(withHomeLaunchOrigin('/apps/run/pixel-forge/deep/view?sl=asl_01J9#tab')).toBe(
      '/apps/run/pixel-forge/deep/view?sl=asl_01J9&from=home#tab'
    );
  });

  it('does not duplicate the param', () => {
    expect(withHomeLaunchOrigin('/apps/run/x?from=store')).toBe('/apps/run/x?from=home');
  });

  it.each([
    'https://promptlab.example.org/app',
    '/apps/store-preview/pixel-forge',
    '/apps',
    '/apps/runner',
  ])('leaves a non-run href alone (%s)', (href) => {
    expect(withHomeLaunchOrigin(href)).toBe(href);
  });
});

describe('appsRunBackTarget', () => {
  it('home → My apps at /apps; store → Marketplace at /apps/store', () => {
    expect(appsRunBackTarget('home')).toEqual({ href: '/apps', label: 'My apps' });
    expect(appsRunBackTarget('store')).toEqual({ href: '/apps/store', label: 'Marketplace' });
  });

  it('round-trip: a home tile link parses back to the home target', () => {
    const href = withHomeLaunchOrigin('/apps/run/pixel-forge');
    const from = new URLSearchParams(href.split('?')[1]).get('from');
    expect(appsRunBackTarget(parseAppsRunOrigin(from))).toEqual({
      href: '/apps',
      label: 'My apps',
    });
  });
});

describe('withRunLaunchOrigin', () => {
  it('store: drops every `from` spelling and keeps the other pairs verbatim', () => {
    expect(
      withRunLaunchOrigin('/apps/run/x/y?a=1&from=home&q=a%20b&fr%6Fm=home&from#h', 'store')
    ).toBe('/apps/run/x/y?a=1&q=a%20b#h');
  });

  it('store: a query holding only `from` leaves no dangling `?`', () => {
    expect(withRunLaunchOrigin('/apps/run/x?from=home', 'store')).toBe('/apps/run/x');
    expect(withRunLaunchOrigin('/apps/run/x?from=home#h', 'store')).toBe('/apps/run/x#h');
  });

  it('store: an href with no `from` is unchanged', () => {
    expect(withRunLaunchOrigin('/apps/run/x/y?sl=asl_01J9', 'store')).toBe(
      '/apps/run/x/y?sl=asl_01J9'
    );
  });

  it('a malformed key is not mistaken for `from`', () => {
    expect(withRunLaunchOrigin('/apps/run/x?fr%m=1', 'store')).toBe('/apps/run/x?fr%m=1');
  });

  it('home: exactly one from=home, appended last', () => {
    expect(withRunLaunchOrigin('/apps/run/x?from=a&b=2&from=c', 'home')).toBe(
      '/apps/run/x?b=2&from=home'
    );
  });

  it('a non-run href is returned unchanged for either origin', () => {
    expect(withRunLaunchOrigin('/models/1?from=x', 'store')).toBe('/models/1?from=x');
    expect(withRunLaunchOrigin('/models/1', 'home')).toBe('/models/1');
  });
});
