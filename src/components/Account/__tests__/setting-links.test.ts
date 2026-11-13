import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { accountSections } from '~/components/Account/account-sections';
import {
  getSettingHref,
  readSettingAnchor,
  resolveSettingRedirect,
  settingPanes,
  slugifyAnchor,
} from '~/components/Account/setting-links';

describe('readSettingAnchor', () => {
  it('reads ?setting=', () => {
    expect(readSettingAnchor({ search: '?setting=hide-reaction-lists', hash: '' })).toBe(
      'hide-reaction-lists'
    );
  });

  it('reads the fragment', () => {
    expect(readSettingAnchor({ search: '', hash: '#privacy' })).toBe('privacy');
  });

  it('prefers the query over the fragment', () => {
    expect(readSettingAnchor({ search: '?setting=privacy', hash: '#features' })).toBe('privacy');
  });

  it('normalises case and encoding, and ignores unrelated params', () => {
    expect(readSettingAnchor({ search: '?setting=API%20Keys', hash: '' })).toBe('api keys');
    expect(readSettingAnchor({ search: '?tab=privacy', hash: '' })).toBeUndefined();
  });

  it('returns nothing for an empty or malformed value instead of throwing', () => {
    expect(readSettingAnchor({ search: '?setting=', hash: '' })).toBeUndefined();
    expect(readSettingAnchor({ search: '', hash: '#%E0%A4%A' })).toBeUndefined();
  });
});

describe('resolveSettingRedirect', () => {
  const at = (pathname: string, search = '', hash = '') => ({ pathname, search, hash });

  it('sends the bare account URL to the pane that owns the setting', () => {
    expect(resolveSettingRedirect(at('/user/account', '?setting=hide-reaction-lists'))).toEqual({
      pathname: '/user/account/preferences',
      query: { setting: 'hide-reaction-lists' },
      hash: '',
    });
  });

  it('maps a fragment the same way and keeps it', () => {
    expect(resolveSettingRedirect(at('/user/account', '', '#privacy'))).toEqual({
      pathname: '/user/account/preferences',
      query: {},
      hash: 'privacy',
    });
  });

  it('is a no-op once on the right pane', () => {
    expect(
      resolveSettingRedirect(at('/user/account/preferences', '?setting=privacy'))
    ).toBeUndefined();
  });

  it('corrects a wrong pane', () => {
    expect(resolveSettingRedirect(at('/user/account/profile', '?setting=privacy'))?.pathname).toBe(
      '/user/account/preferences'
    );
  });

  it('leaves unknown anchors and plain URLs alone', () => {
    expect(resolveSettingRedirect(at('/user/account', '?setting=nope'))).toBeUndefined();
    expect(resolveSettingRedirect(at('/user/account'))).toBeUndefined();
  });

  it('keeps other query params', () => {
    expect(
      resolveSettingRedirect(at('/user/account', '?setting=privacy&ref=support'))?.query
    ).toEqual({ setting: 'privacy', ref: 'support' });
  });
});

describe('getSettingHref', () => {
  it('builds the link support hands out', () => {
    expect(getSettingHref('hide-reaction-lists')).toBe('/user/account?setting=hide-reaction-lists');
  });
});

describe('slugifyAnchor', () => {
  it.each([
    ['Privacy', 'privacy'],
    ['CivBot Assistant', 'civbot-assistant'],
    ['File preferences', 'file-preferences'],
    ['Sign-in methods', 'sign-in-methods'],
    [' API keys! ', 'api-keys'],
  ])('%s -> %s', (title, slug) => {
    expect(slugifyAnchor(title)).toBe(slug);
  });
});

describe('settingPanes', () => {
  it('only names panes that exist', () => {
    const ids = new Set(accountSections.map((section) => section.id));
    for (const [anchor, pane] of Object.entries(settingPanes)) {
      expect(ids.has(pane), `${anchor} -> ${pane}`).toBe(true);
    }
  });

  // An anchor matching no element fails silently, so pin each to an `id="..."` or the slug of a literal `title="..."` in the components.
  it('matches an id or title in the components', () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), '..');
    const source = readdirSync(dir)
      .filter((file) => file.endsWith('.tsx') && !/\.(browser\.)?test\./.test(file))
      .map((file) => readFileSync(join(dir, file), 'utf8'))
      .join('\n');

    const present = new Set<string>();
    for (const match of source.matchAll(/\bid=["']([a-z0-9-]+)["']/g)) present.add(match[1]);
    for (const match of source.matchAll(/\btitle=["']([^"']+)["']/g))
      present.add(slugifyAnchor(match[1]));
    for (const match of source.matchAll(/\bid: ['"]([a-z0-9-]+)['"]/g)) present.add(match[1]);

    const missing = Object.keys(settingPanes).filter((anchor) => !present.has(anchor));
    expect(missing).toEqual([]);
  });
});
