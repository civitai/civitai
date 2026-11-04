import { describe, expect, it } from 'vitest';
import {
  appsRunBackTarget,
  parseAppsRunOrigin,
  withHomeLaunchOrigin,
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
