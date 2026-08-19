import { describe, expect, it } from 'vitest';
import {
  buildRobotsTxt,
  metaExternalAgentDisallowPaths,
  parseRobotsGroups,
} from '~/server/utils/robots';

const BASE = 'https://example.test';
const txt = buildRobotsTxt(BASE);
const groups = parseRobotsGroups(txt);

describe('robots.txt', () => {
  it('emits exactly two user-agent groups', () => {
    expect(Object.keys(groups).sort()).toEqual(['*', 'meta-externalagent']);
  });

  // 🔴 The load-bearing one. A crawler obeys only its most specific matching
  // group and ignores `*` entirely, so a meta-externalagent block that does not
  // repeat every `*` disallow would LOOSEN the rules for Meta. This fails if a
  // future edit adds a path to the `*` group without adding it to Meta's.
  it('meta-externalagent disallows a strict superset of the * group', () => {
    const wildcard = groups['*'];
    const meta = groups['meta-externalagent'];
    expect(wildcard.length).toBeGreaterThan(0); // positive control: not vacuous
    const missing = wildcard.filter((p) => !meta.includes(p));
    expect(missing).toEqual([]);
    expect(meta.length).toBeGreaterThan(wildcard.length);
  });

  it('disallows the review routes for meta-externalagent only', () => {
    for (const path of metaExternalAgentDisallowPaths) {
      expect(groups['meta-externalagent']).toContain(path);
      expect(groups['*']).not.toContain(path);
    }
  });

  it('keeps the * group unchanged — pinned to the full shipped text', () => {
    // Pinned literally, not derived from the arrays under test, so a change to
    // those arrays cannot silently update the expectation too.
    const wildcardSection = txt.slice(0, txt.indexOf('# meta-externalagent'));
    expect(wildcardSection).toBe(
      [
        '# *',
        'User-agent: *',
        'Allow: /api/trpc/*',
        'Disallow: /*/create',
        'Disallow: /api/*',
        'Disallow: /discord/*',
        'Disallow: /dmca/*',
        'Disallow: /intent/*',
        'Disallow: /models/train',
        'Disallow: /models/*/wizard',
        'Disallow: /models/*/model-versions/*/wizard',
        'Disallow: /moderator/*',
        'Disallow: /payment/*',
        'Disallow: /redirect',
        'Disallow: /search/*',
        'Disallow: /testing/*',
        'Disallow: /user/account',
        'Disallow: /user/downloads',
        'Disallow: /user/notifications',
        'Disallow: /user/transactions',
        'Disallow: /user/buzz-dashboard',
        'Disallow: /user/vault',
        'Disallow: /user/membership',
        'Disallow: /user/stripe-connect/onboard',
        'Disallow: /user/earn-potential',
        'Disallow: /tipalti/*',
        'Disallow: /research/*',
        'Disallow: /claim/*',
        'Disallow: /collections/youtube/auth',
        'Disallow: /questions/*',
        '',
        '# Login pages — high alternate-canonical volume from /login?returnUrl=... variants',
        'Disallow: /login',
        '',
        '# Ad/affiliate tracking parameters — canonical handles correctness, but each',
        '# variant wastes crawl budget',
        'Disallow: /*?adid=',
        'Disallow: /*&adid=',
        '',
        '# Site-search query URLs — thin/duplicate content, low SEO value',
        'Disallow: /*?query=',
        'Disallow: /*&query=',
        '',
        // the blank line that separates this group from the next one
        '',
      ].join('\n')
    );
  });

  it('still emits Host and every sitemap, after the new group', () => {
    expect(txt).toContain(`Host: ${BASE}`);
    for (const s of ['', '-pages', '-articles', '-models'])
      expect(txt).toContain(`Sitemap: ${BASE}/sitemap${s}.xml`);
    expect(txt.indexOf('# meta-externalagent')).toBeLessThan(txt.indexOf('# Host'));
  });
});
