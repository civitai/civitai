import { describe, expect, it } from 'vitest';
import {
  getOwnHosts,
  isSameSitePath,
  toCurrentDomainHref,
  toOwnRootRelative,
} from '~/utils/current-domain-href';

const own = getOwnHosts({
  // The shape server-domain.ts describes: civitai.red is both blue's and red's primary.
  green: { primary: 'civitai.com', aliases: [] },
  blue: { primary: 'civitai.red', aliases: ['civitaired.com'] },
  red: { primary: 'civitai.red', aliases: [] },
});

describe('toCurrentDomainHref', () => {
  it('moves a link to another of our hosts onto the current one, keeping path, query and hash', () => {
    expect(toCurrentDomainHref('https://civitai.com/models/1?a=b#c', 'civitai.red', own)).toBe(
      'https://civitai.red/models/1?a=b#c'
    );
    expect(toCurrentDomainHref('https://civitai.red/articles/2', 'civitai.com', own)).toBe(
      'https://civitai.com/articles/2'
    );
    expect(toCurrentDomainHref('https://CIVITAI.COM/x', 'civitaired.com', own)).toBe(
      'https://civitaired.com/x'
    );
    expect(toCurrentDomainHref('//civitai.com/x', 'civitai.red', own)).toBe(
      'https://civitai.red/x'
    );
  });

  it.each([
    ['external', 'https://example.com/civitai.com'],
    ['another subdomain of ours', 'https://orchestration.civitai.com/x'],
    ['www, not in the config', 'https://www.civitai.com/x'],
    ['suffix lookalike', 'https://civitai.com.evil.test/x'],
    ['prefix lookalike', 'https://evilcivitai.com/x'],
    ['userinfo hiding an external host', 'https://civitai.com@evil.test/x'],
    ['userinfo on our host', 'https://evil.test@civitai.com/x'],
    ['relative', '/models/1'],
    ['javascript scheme', 'javascript:alert(1)//civitai.com'],
    ['data scheme', 'data:text/html,<a href="https://civitai.com">'],
    ['mailto', 'mailto:support@civitai.com'],
    ['unparseable', 'https://'],
    ['already current', 'https://civitai.red/x'],
    ['bare-domain link to the other site', 'https://civitai.com'],
    ['bare-domain link with a slash', 'https://civitai.com/'],
  ])('leaves alone: %s', (_case, href) => {
    expect(toCurrentDomainHref(href, 'civitai.red', own)).toBe(href);
  });

  it('keeps a deep link to the other site on the current one, while the bare domain stays', () => {
    expect(toCurrentDomainHref('https://civitai.red/models/1', 'civitai.com', own)).toBe(
      'https://civitai.com/models/1'
    );
    expect(toCurrentDomainHref('https://civitai.red/?tab=new', 'civitai.com', own)).toBe(
      'https://civitai.com/?tab=new'
    );
    expect(toCurrentDomainHref('https://civitai.red', 'civitai.com', own)).toBe(
      'https://civitai.red'
    );
  });

  it('rewrites nothing when the current host is not ours', () => {
    expect(toCurrentDomainHref('https://civitai.com/x', 'preview.example.dev', own)).toBe(
      'https://civitai.com/x'
    );
    expect(toCurrentDomainHref('https://civitai.com/x', '', own)).toBe('https://civitai.com/x');
  });
});

describe('toOwnRootRelative', () => {
  const own = ['civitai.com', 'civitai.red', 'civitai.green'];

  it.each([
    ['https://civitai.com/articles/1', '/articles/1'],
    ['http://CIVITAI.RED/models/2?x=1#y', '/models/2?x=1#y'],
  ])('makes %s root-relative', (href, expected) => {
    expect(toOwnRootRelative(href, own)).toBe(expected);
  });

  it.each([
    'https://example.com/articles/1',
    'https://civitai.com.evil.test/articles/1',
    'https://orchestration.civitai.com/x',
    'https://user:pw@civitai.com/x',
    'https://civitai.red',
    // Their paths start "//": made relative, they would leave the site.
    'https://civitai.com//evil.com/x',
    'https://civitai.com/\\evil.com/x',
    'https://civitai.com/.//evil.com/x',
    'https://civitai.com/a/..//evil.com/x',
    'mailto:a@civitai.com',
    '/already/relative',
  ])('leaves %s alone', (href) => {
    expect(toOwnRootRelative(href, own)).toBe(href);
  });
});

describe('isSameSitePath', () => {
  it.each(['/articles/1', '/%2F%2Fevil.com', '/a?b=//c'])('%s stays on this site', (href) => {
    expect(isSameSitePath(href)).toBe(true);
  });

  it.each(['//evil.com', '/\\evil.com', '/\t/evil.com', 'https://civitai.com/x', 'x/y', ''])(
    '%j leaves it or is not a path',
    (href) => {
      expect(isSameSitePath(href)).toBe(false);
    }
  );
});
