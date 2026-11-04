import { describe, expect, it } from 'vitest';
import { getOwnHosts, toCurrentDomainHref } from '~/utils/current-domain-href';

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
