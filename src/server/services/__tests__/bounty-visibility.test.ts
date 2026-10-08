import { readFileSync } from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  assertBountyVisible,
  bountyVisibilityWhere,
  canViewBounty,
} from '~/server/services/bounty-visibility';
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
    expect(
      canViewBounty({ availability: Availability.Private, userId: null }, { id: undefined })
    ).toBe(false);
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

describe('assertBountyVisible', () => {
  beforeEach(() => vi.clearAllMocks());

  it('404s a private bounty for a stranger, by bounty id and by entry id', async () => {
    dbMock.dbRead.bounty.findUnique.mockResolvedValue({
      availability: Availability.Private,
      userId: 5,
    });
    await expect(assertBountyVisible({ bountyId: 9 }, { id: 6 })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    dbMock.dbRead.bountyEntry.findUnique.mockResolvedValue({
      bounty: { availability: Availability.Private, userId: 5 },
    });
    await expect(assertBountyVisible({ entryId: 3 }, undefined)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('lets the owner through, and a moderator without reading anything', async () => {
    dbMock.dbRead.bounty.findUnique.mockResolvedValue({
      availability: Availability.Private,
      userId: 5,
    });
    await expect(assertBountyVisible({ bountyId: 9 }, { id: 5 })).resolves.toBeUndefined();

    vi.clearAllMocks();
    await expect(
      assertBountyVisible({ bountyId: 9 }, { id: 6, isModerator: true })
    ).resolves.toBeUndefined();
    expect(dbMock.dbRead.bounty.findUnique).not.toHaveBeenCalled();
  });

  it('leaves a missing bounty to the caller', async () => {
    dbMock.dbRead.bounty.findUnique.mockResolvedValue(null);
    await expect(assertBountyVisible({ bountyId: 9 }, null)).resolves.toBeUndefined();
  });
});
