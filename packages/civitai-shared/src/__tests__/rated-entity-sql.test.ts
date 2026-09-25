import { describe, expect, it } from 'vitest';
import {
  articleModerationFloorText,
  bountyBuzzType,
  challengeDerivedNsfwLevel,
  greenBountyPredicateText,
  isTextScanRaised,
  overrideBasisDropped,
  raiseNsfwLevelText,
  ratedEntityContentNsfwLevelText,
  ratedEntityDerivedNsfwLevelText,
  scanFloorText,
  textScanRaisedMinLevel,
  textScanVerdictPredicateText,
} from '../rated-entity-sql';

describe('scanFloorText', () => {
  const text = scanFloorText('Post', 'p.id');

  it('matches the live row by exact entity type, so shadow rows never match', () => {
    expect(text).toContain(`em."entityType" = 'Post'`);
    expect(text).not.toMatch(/LIKE/i);
  });

  it('reads only a text-scan verdict at PG13 or above', () => {
    expect(text).toContain(`em.result->>'version' IS NOT NULL AND em."nsfwLevel" >= 2`);
  });

  it('does not require Succeeded, so a rescan in flight keeps the floor', () => {
    expect(text).not.toContain('status');
  });

  it('correlates on the given column and defaults to 0', () => {
    expect(text).toContain('em."entityId" = p.id');
    expect(text).toMatch(/^COALESCE\(\(SELECT em\."nsfwLevel"/);
    expect(text).toMatch(/, 0\)$/);
  });

  it('refuses anything that is not a known entity or a plain identifier', () => {
    expect(() => scanFloorText('Collection' as never, 'c.id')).toThrow();
    expect(() => scanFloorText('Post', 'p.id; DROP TABLE x')).toThrow();
  });
});

describe('textScanVerdictPredicateText', () => {
  it('takes a higher minimum for Model disputes', () => {
    expect(textScanVerdictPredicateText('em', 4)).toBe(
      `em.result->>'version' IS NOT NULL AND em."nsfwLevel" >= 4`
    );
    expect(() => textScanVerdictPredicateText('em', 1.5)).toThrow();
  });
});

describe('raiseNsfwLevelText', () => {
  it('is exactly the CASE Step 4 checks against Postgres', () => {
    expect(raiseNsfwLevelText('l', 'f')).toBe(
      '(CASE WHEN l = 0 OR f = 0 THEN l WHEN (l & ~(f - 1)) = 0 THEN f ELSE l & ~(f - 1) END)'
    );
  });
});

describe('articleModerationFloorText', () => {
  const text = articleModerationFloorText('a.id');

  it('keeps the flat R floor for XGuard rows, whatever their status', () => {
    expect(text).toContain(`em.result->>'version' IS NULL`);
    expect(text).toContain(`'nsfw' = ANY(em."triggeredLabels")`);
    expect(text).not.toContain('em.status');
    expect(text).toContain('THEN 4');
  });

  it('keeps the Actioned NSFW report floor', () => {
    expect(text).toContain(`r.reason = 'NSFW'::"ReportReason"`);
    expect(text).toContain(`r.status = 'Actioned'::"ReportStatus"`);
  });

  it('adds the text-scan floor for Article', () => {
    expect(text).toContain(scanFloorText('Article', 'a.id'));
  });
});

describe('ratedEntityDerivedNsfwLevelText', () => {
  it.each([
    ['Post', 'p', 'FROM "Image" i WHERE i."postId" = p.id'],
    ['BountyEntry', 'be', `ic."entityType" = 'BountyEntry' AND ic."entityId" = be.id`],
    ['Bounty', 'b', `ic."entityType" = 'Bounty' AND ic."entityId" = b.id`],
  ] as const)('%s raises its own images by its own floor', (entityType, alias, images) => {
    const text = ratedEntityDerivedNsfwLevelText(entityType, alias);
    expect(text).toContain(images);
    expect(text).toContain(scanFloorText(entityType, `${alias}.id`));
    expect(text).toContain(raiseNsfwLevelText('d.l', 'd.f'));
  });

  it('pins an nsfw bounty to the NSFW flag before anything else', () => {
    expect(ratedEntityDerivedNsfwLevelText('Bounty', 'b')).toMatch(
      /^\(CASE WHEN b\.nsfw = TRUE THEN 60 ELSE /
    );
    expect(ratedEntityDerivedNsfwLevelText('Post', 'p')).not.toContain('nsfw = TRUE');
  });

  it('refuses an alias the text uses internally', () => {
    expect(() => ratedEntityDerivedNsfwLevelText('Post', 'i')).toThrow();
  });
});

describe('ratedEntityContentNsfwLevelText', () => {
  it('is the derived text without the bounty flag, and identical for Post and BountyEntry', () => {
    expect(ratedEntityContentNsfwLevelText('Bounty', 'b')).not.toContain('nsfw = TRUE');
    expect(ratedEntityDerivedNsfwLevelText('Bounty', 'b')).toContain(ratedEntityContentNsfwLevelText('Bounty', 'b'));
    expect(ratedEntityContentNsfwLevelText('Post', 'p')).toBe(ratedEntityDerivedNsfwLevelText('Post', 'p'));
    expect(ratedEntityContentNsfwLevelText('BountyEntry', 'be')).toBe(ratedEntityDerivedNsfwLevelText('BountyEntry', 'be'));
  });
});

describe('isTextScanRaised', () => {
  const ts = (nsfwLevel: number | null, entityType = 'Post') => ({ entityType, nsfwLevel, result: { version: 1 } });

  it('uses the same minimum as the SQL predicate', () => {
    expect(textScanVerdictPredicateText('em', textScanRaisedMinLevel('Post'))).toBe(textScanVerdictPredicateText('em'));
    expect(textScanRaisedMinLevel('Model')).toBe(4);
  });

  it('needs a text-scan result at or above the minimum', () => {
    expect(isTextScanRaised(ts(2))).toBe(true);
    expect(isTextScanRaised(ts(1))).toBe(false);
    expect(isTextScanRaised(ts(2, 'Model'))).toBe(false);
    expect(isTextScanRaised(ts(4, 'Model'))).toBe(true);
    expect(isTextScanRaised({ entityType: 'Post', nsfwLevel: 8, result: { labels: [] } })).toBe(false);
    expect(isTextScanRaised({ entityType: 'Post', nsfwLevel: null, result: { version: 1 } })).toBe(false);
  });
});

describe('challengeDerivedNsfwLevel', () => {
  it.each([
    [3, 2],
    [7, 4],
    [1, 1],
    [0, 1],
  ])('allowed %i → %i', (allowed, level) => {
    expect(challengeDerivedNsfwLevel(allowed)).toBe(level);
  });
});

describe('overrideBasisDropped', () => {
  const at = (derivedLevel: number | null, moderatorNsfwLevelBasis: number | null = 4) =>
    overrideBasisDropped({ moderatorNsfwLevel: 1, moderatorNsfwLevelBasis, derivedLevel });

  it('is true only when the highest derived bit fell below the basis', () => {
    expect(at(1)).toBe(true);
    expect(at(4)).toBe(false);
    expect(at(8)).toBe(false);
  });

  it('compares highest bits, so dropping a PG image from PG|X is not a drop', () => {
    expect(at(8, 9)).toBe(false);
  });

  it('fails closed without an override, a basis or a derived level', () => {
    expect(at(null)).toBe(false);
    expect(at(0)).toBe(false);
    expect(at(1, null)).toBe(false);
    expect(
      overrideBasisDropped({ moderatorNsfwLevel: null, moderatorNsfwLevelBasis: 4, derivedLevel: 1 })
    ).toBe(false);
  });
});

describe('bountyBuzzType', () => {
  it.each([
    [{ buzzType: 'green', nsfw: false, lockedProperties: ['nsfw'] }, 'green'],
    [{ buzzType: 'yellow', nsfw: false, lockedProperties: ['nsfw'] }, 'yellow'],
    [{ buzzType: null, nsfw: false, lockedProperties: ['nsfw'] }, 'unknown'],
    [{ buzzType: null, nsfw: true, lockedProperties: ['nsfw'] }, 'yellow'],
    [{ buzzType: null, nsfw: false, lockedProperties: [] }, 'yellow'],
  ] as const)('%o → %s', (row, kind) => {
    expect(bountyBuzzType({ ...row, lockedProperties: [...row.lockedProperties] })).toBe(kind);
  });
});

describe('greenBountyPredicateText', () => {
  it('matches a stored green bounty and the legacy lock shape bountyBuzzType calls unknown', () => {
    expect(greenBountyPredicateText('b')).toBe(
      `(b."buzzType" = 'green' OR (b."buzzType" IS NULL AND b.nsfw = FALSE AND 'nsfw' = ANY(b."lockedProperties")))`
    );
  });

  it('refuses a non-identifier alias', () => {
    expect(() => greenBountyPredicateText('b; --')).toThrow();
  });
});

