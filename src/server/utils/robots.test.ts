import { describe, expect, it } from 'vitest';
import {
  buildRobotsTxt,
  crawlBudgetDisallowPaths,
  metaExternalAgentDisallowPaths,
  parseRobotsGroups,
} from '~/server/utils/robots';

const BASE = 'https://example.test';
// Built inside a helper, not at module scope: a throw at module scope surfaces
// as a COLLECTION error ("no tests") rather than a failure, which reads as
// nothing-to-see in a report-only lane.
const build = () => {
  const txt = buildRobotsTxt(BASE);
  return { txt, groups: parseRobotsGroups(txt) };
};

describe('robots.txt', () => {
  it('emits exactly two user-agent groups', () => {
    const { groups } = build();
    expect(Object.keys(groups).sort()).toEqual(['*', 'meta-externalagent']);
  });

  // 🔴 The value this whole change exists to add. Without a LITERAL pin, every
  // wrong value passes: a singular `/model/*/reviews` typo (change is inert) and
  // an over-broad `/models/*` (deindexes the entire model catalogue for Meta)
  // both satisfied every other assertion here. Both failure directions are
  // silent in production.
  it('pins the exact disallowed paths, literally', () => {
    expect(metaExternalAgentDisallowPaths).toEqual(['/models/*/reviews', '/3d-models/*/reviews']);
  });

  // Kills the drift where an entry added to `crawlBudgetDisallow` reaches only
  // the meta group. These paths must appear in the `*` group too.
  it('emits every crawl-budget path in the * group', () => {
    const { groups } = build();
    expect(crawlBudgetDisallowPaths.length).toBeGreaterThan(0); // positive control
    for (const path of crawlBudgetDisallowPaths) expect(groups['*']).toContain(path);
  });

  // 🔴 The load-bearing one. A crawler obeys only its most specific matching
  // group and ignores `*` entirely, so a meta-externalagent block that does not
  // repeat every `*` disallow would LOOSEN the rules for Meta. This fails if a
  // future edit adds a path to the `*` group without adding it to Meta's.
  it('meta-externalagent disallows a strict superset of the * group', () => {
    const { groups } = build();
    const wildcard = groups['*'];
    const meta = groups['meta-externalagent'];
    expect(wildcard.length).toBeGreaterThan(0); // positive control: not vacuous
    const missing = wildcard.filter((p) => !meta.includes(p));
    expect(missing).toEqual([]);
    expect(meta.length).toBeGreaterThan(wildcard.length);
  });

  it('disallows the review routes for meta-externalagent only', () => {
    const { groups } = build();
    for (const path of metaExternalAgentDisallowPaths) {
      expect(groups['meta-externalagent']).toContain(path);
      expect(groups['*']).not.toContain(path);
    }
  });

  it('keeps the * group unchanged — pinned to the full shipped text', () => {
    const { txt } = build();
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

  it('keeps Allow: /api/trpc/* in BOTH groups', () => {
    const { txt } = build();
    const meta = txt.slice(txt.indexOf('# meta-externalagent'));
    expect(meta).toContain('Allow: /api/trpc/*');
    expect(txt.slice(0, txt.indexOf('# meta-externalagent'))).toContain('Allow: /api/trpc/*');
  });

  it('still emits Host and every sitemap, after the new group', () => {
    const { txt, groups } = build();
    expect(groups['meta-externalagent']).toBeDefined();
    expect(txt).toContain(`Host: ${BASE}`);
    for (const s of ['', '-pages', '-articles', '-models'])
      expect(txt).toContain(`Sitemap: ${BASE}/sitemap${s}.xml`);
    expect(txt.indexOf('# meta-externalagent')).toBeLessThan(txt.indexOf('# Host'));
  });
});
