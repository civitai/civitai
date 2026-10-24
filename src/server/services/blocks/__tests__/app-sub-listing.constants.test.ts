import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import {
  APP_SUB_LISTING_CONTENT_RATINGS,
  APP_SUB_LISTING_ID_RE,
  APP_SUB_LISTING_STATUSES,
  APP_SUB_LISTING_SUB_PATH_RE,
  effectiveSubListingRating,
  isAppSubListingId,
  isRatingAtLeastAsStrict,
  isValidSubListingExternalId,
  isValidSubListingLinkTemplate,
  isValidSubListingSubPath,
  APP_SUB_LISTING_LINK_TEMPLATE_MAX,
  APP_SUB_LISTING_LINK_TEMPLATE_PREFIX_RE,
  subListingExternalHref,
  subListingRunHref,
} from '~/shared/constants/app-sub-listing.constants';
import { newAppSubListingId } from '~/server/utils/app-block-ids';

// The constants and the migration ship together, so these are invariant guards against a
// later one-sided edit, not regression coverage.
const MIGRATION = path.resolve(
  __dirname,
  '../../../../../packages/civitai-db-schema/prisma/migrations/20261010120000_app_sub_listings/migration.sql'
);
const sql = readFileSync(MIGRATION, 'utf8');

function inList(column: string): string[] {
  const m = sql.match(new RegExp(`"${column}"\\s+IN\\s*\\(([^)]*)\\)`, 'i'));
  if (!m) throw new Error(`no IN-list for ${column}`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

describe('app sub-listing constants ⟺ migration', () => {
  it('parses non-empty lists (the instrument can see something)', () => {
    expect(inList('status').length).toBeGreaterThan(0);
    expect(inList('content_rating').length).toBeGreaterThan(0);
  });

  it('status CHECK equals APP_SUB_LISTING_STATUSES', () => {
    expect(inList('status')).toEqual([...APP_SUB_LISTING_STATUSES]);
  });

  it('both rating CHECKs equal APP_SUB_LISTING_CONTENT_RATINGS', () => {
    expect(inList('content_rating')).toEqual([...APP_SUB_LISTING_CONTENT_RATINGS]);
    expect(inList('pending_content_rating')).toEqual([...APP_SUB_LISTING_CONTENT_RATINGS]);
  });

  it('both sub_path CHECKs use the same pattern as the code', () => {
    const patterns = [...sql.matchAll(/"(?:pending_)?sub_path" ~ '([^']+)'/g)].map((m) => m[1]);
    expect(patterns).toHaveLength(2);
    for (const p of patterns)
      expect(p).toBe(APP_SUB_LISTING_SUB_PATH_RE.source.replace(/\\\//g, '/'));
  });

  it('does not create a per-parent store cap', () => {
    expect(sql).not.toMatch(/store_cap/);
  });
});

describe('subPath allowlist', () => {
  const ulid = '01J9ZK3Q4R5S6T7V8W9X0Y1Z2A';
  it.each([`g/${ulid}`, 'abc', 'a-b_c/d/e/f', 'A'.repeat(64)])('accepts %s', (p) => {
    expect(isValidSubListingSubPath(p)).toBe(true);
  });

  it.each([
    '../x',
    'g/../x',
    'g//x',
    '/g/x',
    'g/x/',
    'https://evil.example',
    'javascript:alert(1)',
    'g/x?y=1',
    'g/x#frag',
    'g/%2e%2e',
    'g\\x',
    'g/x.y',
    '',
    'a/b/c/d/e',
    'A'.repeat(65),
    `${'a'.repeat(64)}/${'b'.repeat(64)}/c`,
  ])('rejects %s', (p) => {
    expect(isValidSubListingSubPath(p)).toBe(false);
  });

  it('caps the total length at 128 even when every segment is legal', () => {
    const p = ['a'.repeat(64), 'b'.repeat(64), 'c'].join('/');
    expect(p.length).toBeGreaterThan(128);
    expect(APP_SUB_LISTING_SUB_PATH_RE.test(p)).toBe(true);
    expect(isValidSubListingSubPath(p)).toBe(false);
  });
});

describe('ids', () => {
  it('newAppSubListingId mints the shape the open event accepts', () => {
    const id = newAppSubListingId();
    expect(id).toMatch(APP_SUB_LISTING_ID_RE);
    expect(isAppSubListingId(id)).toBe(true);
  });

  it.each(['apl_01J9ZK3Q4R5S6T7V8W9X0Y1Z2A', 'asl_short', 'asl_01J9ZK3Q4R5S6T7V8W9X0Y1Z2a', 42])(
    'rejects %s',
    (v) => {
      expect(isAppSubListingId(v)).toBe(false);
    }
  );
});

describe('ratings', () => {
  it('allows only equal-or-stricter child ratings', () => {
    expect(isRatingAtLeastAsStrict('pg13', 'pg')).toBe(true);
    expect(isRatingAtLeastAsStrict('pg', 'pg')).toBe(true);
    expect(isRatingAtLeastAsStrict('g', 'pg13')).toBe(false);
    // Unset inherits the parent's rating; the card shows the stricter of the two.
    expect(isRatingAtLeastAsStrict(null, 'r')).toBe(true);
    expect(isRatingAtLeastAsStrict(null, null)).toBe(true);
    expect(isRatingAtLeastAsStrict('x', null)).toBe(true);
  });

  it('effective rating is the stricter of the two', () => {
    expect(effectiveSubListingRating('pg', 'r')).toBe('r');
    expect(effectiveSubListingRating('x', 'pg')).toBe('x');
    expect(effectiveSubListingRating(null, 'pg13')).toBe('pg13');
    expect(effectiveSubListingRating(null, null)).toBeNull();
  });

  it('an unknown stored rating wins rather than being read as SFW', () => {
    expect(effectiveSubListingRating('weird', 'g')).toBe('weird');
    expect(effectiveSubListingRating('g', 'weird')).toBe('weird');
  });
});

describe('subListingRunHref', () => {
  it('builds the run route under the parent with the id in sl', () => {
    expect(subListingRunHref('custom-generators', 'g/ABC', 'asl_X')).toBe(
      '/apps/run/custom-generators/g/ABC?sl=asl_X'
    );
  });
});

describe('link_template ⟺ catalog-sync migration', () => {
  const catalogSql = readFileSync(
    path.resolve(
      __dirname,
      '../../../../../packages/civitai-db-schema/prisma/migrations/20261015120000_app_sub_listing_catalog_sync/migration.sql'
    ),
    'utf8'
  );

  it('the CHECK uses the same prefix pattern and bound as the code', () => {
    const prefix = [...catalogSql.matchAll(/"link_template" ~ '([^']+)'/g)].map((m) => m[1]);
    expect(prefix).toEqual([APP_SUB_LISTING_LINK_TEMPLATE_PREFIX_RE.source.replace(/\\\//g, '/')]);
    expect(catalogSql).toContain(
      `char_length("link_template") <= ${APP_SUB_LISTING_LINK_TEMPLATE_MAX}`
    );
    expect(catalogSql).toContain("replace(\"link_template\", '{id}', ''))) = 4");
  });
});

describe('isValidSubListingLinkTemplate', () => {
  it.each([
    'https://games.civitai.com/?game={id}',
    'https://games.example.com:8443/g/{id}/play',
    'https://a.b/{id}',
  ])('accepts %s', (t) => expect(isValidSubListingLinkTemplate(t)).toBe(true));

  it.each([
    ['http', 'http://games.example.com/?game={id}'],
    ['no path', 'https://games.example.com?game={id}'],
    ['no placeholder', 'https://games.example.com/'],
    ['two placeholders', 'https://games.example.com/{id}/{id}'],
    ['userinfo', 'https://user@games.example.com/{id}'],
    ['too long', `https://games.example.com/${'a'.repeat(300)}{id}`],
  ])('refuses %s', (_label, t) => expect(isValidSubListingLinkTemplate(t)).toBe(false));

  it('accepts exactly 300 characters and refuses 301', () => {
    const base = 'https://g.example.com/{id}';
    const at = base + 'a'.repeat(300 - base.length);
    expect(at).toHaveLength(300);
    expect(isValidSubListingLinkTemplate(at)).toBe(true);
    expect(isValidSubListingLinkTemplate(at + 'a')).toBe(false);
  });
});

describe('subListingExternalHref', () => {
  const T = 'https://games.example.com/?game={id}';

  it('fills the id into the template', () => {
    expect(subListingExternalHref(T, 'neon-drift')).toBe(
      'https://games.example.com/?game=neon-drift'
    );
    expect(subListingExternalHref('https://g.example.com/play/{id}', 'A_1')).toBe(
      'https://g.example.com/play/A_1'
    );
  });

  it('encodes the id, so it cannot leave the template’s origin or path', () => {
    expect(subListingExternalHref('https://g.example.com/{id}', '@evil.example/x')).toBe(
      'https://g.example.com/%40evil.example%2Fx'
    );
    expect(subListingExternalHref('https://g.example.com/{id}', '//evil.example')).toBe(
      'https://g.example.com/%2F%2Fevil.example'
    );
  });

  it('is null for a missing or invalid template', () => {
    expect(subListingExternalHref(null, 'x')).toBeNull();
    expect(subListingExternalHref('http://g.example.com/{id}', 'x')).toBeNull();
    expect(subListingExternalHref('https://g.example.com/', 'x')).toBeNull();
  });

  it('matches the item id the catalog accepts', () => {
    expect(isValidSubListingExternalId('neon-drift_2')).toBe(true);
    for (const bad of ['', 'a/b', 'a.b', 'a%b', 'x'.repeat(65)]) {
      expect(isValidSubListingExternalId(bad)).toBe(false);
    }
  });
});
