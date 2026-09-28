import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { bountyVisibilityWhere, canViewBounty } from '~/server/services/bounty-visibility';
import { Availability } from '~/shared/utils/prisma/enums';

const priv = { availability: Availability.Private, userId: 5 };

describe('canViewBounty', () => {
  it('shows a public bounty to everyone', () => {
    expect(canViewBounty({ availability: Availability.Public, userId: 5 }, null)).toBe(true);
  });

  it('shows a private bounty only to its owner and moderators', () => {
    expect(canViewBounty(priv, null)).toBe(false);
    expect(canViewBounty(priv, { id: 6 })).toBe(false);
    expect(canViewBounty(priv, { id: 5 })).toBe(true);
    expect(canViewBounty(priv, { id: 6, isModerator: true })).toBe(true);
  });

  it('does not treat a missing owner as a match for an anonymous viewer', () => {
    expect(canViewBounty({ availability: Availability.Private, userId: null }, { id: undefined })).toBe(false);
  });
});

describe('bountyVisibilityWhere', () => {
  it('filters nothing for moderators', () => {
    expect(bountyVisibilityWhere({ id: 1, isModerator: true })).toEqual({});
  });

  it('excludes private bounties for anonymous viewers', () => {
    expect(bountyVisibilityWhere(undefined)).toEqual({
      OR: [{ availability: { not: Availability.Private } }],
    });
  });

  it("keeps a signed-in viewer's own private bounties", () => {
    expect(bountyVisibilityWhere({ id: 5 })).toEqual({
      OR: [{ availability: { not: Availability.Private } }, { userId: 5 }],
    });
  });
});

// Read as text: importing the index module builds the meilisearch client at load.
describe('bounties search index', () => {
  it('never indexes a private bounty', () => {
    const source = readFileSync(
      path.resolve(__dirname, '../../search-index/bounties.search-index.ts'),
      'utf8'
    );
    expect(source).toContain(
      `b."availability" NOT IN ('Unsearchable'::"Availability", 'Private'::"Availability")`
    );
  });
});
