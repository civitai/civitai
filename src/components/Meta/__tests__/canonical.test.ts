import { describe, expect, it } from 'vitest';
import { ownDomainCanonical, resolveMetaHref } from '~/components/Meta/canonical';
import type { ServerDomains } from '~/shared/constants/domain.constants';

const BASE = 'https://civitai.com';

describe('resolveMetaHref', () => {
  it("prefixes a relative canonical with this deployment's base", () => {
    expect(resolveMetaHref('/tag/anime', BASE)).toBe('https://civitai.com/tag/anime');
  });

  it('leaves a cross-domain canonical alone', () => {
    expect(resolveMetaHref('https://civitai.green/tag/anime', BASE)).toBe(
      'https://civitai.green/tag/anime'
    );
  });

  it('never concatenates two absolute URLs', () => {
    expect(resolveMetaHref('http://civitai.green/tag/anime', BASE)).not.toContain(`${BASE}http`);
  });
});

describe('ownDomainCanonical', () => {
  const serverDomains: ServerDomains = {
    green: { primary: 'civitai.com', aliases: [] },
    red: { primary: 'civitai.red', aliases: ['www.civitai.red'] },
    blue: undefined,
  };
  const on = (color: 'green' | 'red' | 'blue') => ({
    green: color === 'green',
    red: color === 'red',
    blue: color === 'blue',
  });

  it('claims a red-only page for red', () => {
    expect(ownDomainCanonical('/tag/nsfw', on('red'), serverDomains)).toBe(
      'https://civitai.red/tag/nsfw'
    );
  });

  it('uses whichever colour serves civitai.red (blue in production)', () => {
    const prod: ServerDomains = {
      green: { primary: 'civitai.com', aliases: [] },
      blue: { primary: 'civitai.red', aliases: [] },
      red: undefined,
    };
    expect(ownDomainCanonical('/models/1', on('blue'), prod)).toBe('https://civitai.red/models/1');
  });

  it('leaves green relative, so Meta resolves it against the green base as before', () => {
    expect(ownDomainCanonical('/tag/anime', on('green'), serverDomains)).toBe('/tag/anime');
  });

  it('never rewrites an explicit cross-domain canonical', () => {
    expect(ownDomainCanonical('https://civitai.com/tag/anime', on('red'), serverDomains)).toBe(
      'https://civitai.com/tag/anime'
    );
  });

  it('leaves the path alone when the colour has no configured host', () => {
    expect(ownDomainCanonical('/tag/x', on('blue'), serverDomains)).toBe('/tag/x');
  });
});
