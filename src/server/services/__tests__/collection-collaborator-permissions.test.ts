import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
const mockDbRead = dbMock.dbRead;
const mockDbWrite = dbMock.dbWrite;

const { addContributorToCollection, getUserCollectionPermissionsById } = await import(
  '~/server/services/collection.service'
);

const COLLECTION_ID = 10;
const OWNER_ID = 999;
const OTHER_ID = 777;

function arrange({
  read = 'Public',
  write = 'Private',
  contributorPermissions = null,
  collaborationDisabledAt = null,
  hasAcceptedSeat = false,
  ownerId = OWNER_ID,
  mode = null,
}: {
  read?: 'Public' | 'Unlisted' | 'Private';
  write?: 'Public' | 'Review' | 'Private';
  contributorPermissions?: string[] | null;
  collaborationDisabledAt?: Date | null;
  hasAcceptedSeat?: boolean;
  ownerId?: number;
  mode?: string | null;
}) {
  mockDbRead.$queryRaw.mockReset();
  mockDbRead.$queryRaw.mockResolvedValueOnce([
    {
      id: COLLECTION_ID,
      read,
      write,
      userId: ownerId,
      type: 'Image',
      mode,
      contributorPermissions,
      collaborationDisabledAt,
      hasAcceptedSeat,
    },
  ]);
}

describe('collection collaborator permissions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not treat a plain follower as a collaborator', async () => {
    arrange({ write: 'Review', contributorPermissions: ['VIEW', 'ADD_REVIEW'] });
    const permissions = await getUserCollectionPermissionsById({
      id: COLLECTION_ID,
      userId: OTHER_ID,
    });
    expect(permissions.isCollaborator).toBe(false);
    expect(permissions.isContributor).toBe(true);
  });

  it('does not treat ADD as collaboration on a Public-write collection', async () => {
    arrange({ write: 'Public', contributorPermissions: ['VIEW', 'ADD'] });
    const permissions = await getUserCollectionPermissionsById({
      id: COLLECTION_ID,
      userId: OTHER_ID,
    });
    expect(permissions.isCollaborator).toBe(false);
  });

  // The sidebar groups on this flag while the detail header groups on the roster. On a
  // write:Public collection an accepted Contributor's {VIEW, ADD} is identical to a follower's,
  // so without the seat signal the two surfaces disagree about the same person.
  it('treats an accepted seat on a Public-write collection as collaboration', async () => {
    arrange({ write: 'Public', contributorPermissions: ['VIEW', 'ADD'], hasAcceptedSeat: true });
    const permissions = await getUserCollectionPermissionsById({
      id: COLLECTION_ID,
      userId: OTHER_ID,
    });
    expect(permissions.isCollaborator).toBe(true);
  });

  it('does not treat an accepted seat with no contributor row as collaboration', async () => {
    arrange({ write: 'Public', contributorPermissions: null, hasAcceptedSeat: true });
    const permissions = await getUserCollectionPermissionsById({
      id: COLLECTION_ID,
      userId: OTHER_ID,
    });
    expect(permissions.isCollaborator).toBe(false);
  });

  // `getCollectionRoster` refuses system-owned and curated collections outright, so their staff
  // rows must not read as collaboration here either — otherwise the sidebar files a collection
  // under "Shared with me" whose own header roster is empty.
  it('does not treat a staff row on a system-owned collection as collaboration', async () => {
    arrange({ ownerId: -1, contributorPermissions: ['VIEW', 'ADD', 'MANAGE'] });
    const permissions = await getUserCollectionPermissionsById({
      id: COLLECTION_ID,
      userId: OTHER_ID,
    });
    expect(permissions.isCollaborator).toBe(false);
  });

  it('does not treat a judge row on a curated collection as collaboration', async () => {
    arrange({ mode: 'Contest', contributorPermissions: ['VIEW', 'ADD'] });
    const permissions = await getUserCollectionPermissionsById({
      id: COLLECTION_ID,
      userId: OTHER_ID,
    });
    expect(permissions.isCollaborator).toBe(false);
  });

  it('treats ADD on a Private-write collection as collaboration', async () => {
    arrange({ write: 'Private', contributorPermissions: ['VIEW', 'ADD'] });
    const permissions = await getUserCollectionPermissionsById({
      id: COLLECTION_ID,
      userId: OTHER_ID,
    });
    expect(permissions.isCollaborator).toBe(true);
    expect(permissions.write).toBe(true);
  });

  it('treats MANAGE as collaboration and grants manage', async () => {
    arrange({ write: 'Review', contributorPermissions: ['VIEW', 'ADD', 'MANAGE'] });
    const permissions = await getUserCollectionPermissionsById({
      id: COLLECTION_ID,
      userId: OTHER_ID,
    });
    expect(permissions.isCollaborator).toBe(true);
    expect(permissions.manage).toBe(true);
  });

  it('closes public submission when collaboration is disabled', async () => {
    arrange({ write: 'Review', collaborationDisabledAt: new Date('2026-08-01') });
    const permissions = await getUserCollectionPermissionsById({
      id: COLLECTION_ID,
      userId: OTHER_ID,
    });
    expect(permissions.writeReview).toBe(false);
    expect(permissions.collaborationDisabled).toBe(true);
    expect(permissions.followPermissions).not.toContain('ADD_REVIEW');
  });

  it('leaves the owner unaffected when collaboration is disabled', async () => {
    arrange({ write: 'Review', collaborationDisabledAt: new Date('2026-08-01') });
    const permissions = await getUserCollectionPermissionsById({
      id: COLLECTION_ID,
      userId: OWNER_ID,
    });
    expect(permissions.manage).toBe(true);
    expect(permissions.write).toBe(true);
  });

  it('leaves an existing collaborator unaffected when collaboration is disabled', async () => {
    arrange({
      write: 'Review',
      contributorPermissions: ['VIEW', 'ADD', 'MANAGE'],
      collaborationDisabledAt: new Date('2026-08-01'),
    });
    const permissions = await getUserCollectionPermissionsById({
      id: COLLECTION_ID,
      userId: OTHER_ID,
    });
    expect(permissions.manage).toBe(true);
    expect(permissions.write).toBe(true);
  });

  it('does not treat a lapsed Public-write follower as a collaborator', async () => {
    arrange({
      write: 'Public',
      contributorPermissions: ['VIEW', 'ADD'],
      collaborationDisabledAt: new Date('2026-08-01'),
    });
    const permissions = await getUserCollectionPermissionsById({
      id: COLLECTION_ID,
      userId: OTHER_ID,
    });
    expect(permissions.isCollaborator).toBe(false);
    expect(permissions.write).toBe(false);
  });

  it('does not treat a lapsed Review-write follower as a collaborator', async () => {
    arrange({
      write: 'Review',
      contributorPermissions: ['VIEW', 'ADD_REVIEW'],
      collaborationDisabledAt: new Date('2026-08-01'),
    });
    const permissions = await getUserCollectionPermissionsById({
      id: COLLECTION_ID,
      userId: OTHER_ID,
    });
    expect(permissions.isCollaborator).toBe(false);
    expect(permissions.writeReview).toBe(false);
  });
});

// I2: `collection.follow` takes an optional userId and uses it as the TARGET, while the
// upsert REPLACES that user's permissions — so on any community collection a stranger could
// rewrite a manager's row down to the collection's follow grant.
describe('addContributorToCollection authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbWrite.collectionContributor.upsert.mockResolvedValue({});
  });

  it("refuses to write another user's row without manage", async () => {
    arrange({ write: 'Public', contributorPermissions: ['VIEW', 'ADD'] });

    await expect(
      addContributorToCollection({
        collectionId: COLLECTION_ID,
        userId: OTHER_ID,
        targetUserId: 555,
      })
    ).rejects.toThrow();
    expect(mockDbWrite.collectionContributor.upsert).not.toHaveBeenCalled();
  });

  it('still lets a user follow on their own behalf', async () => {
    arrange({ write: 'Public' });

    await addContributorToCollection({
      collectionId: COLLECTION_ID,
      userId: OTHER_ID,
      targetUserId: OTHER_ID,
    });
    expect(mockDbWrite.collectionContributor.upsert).toHaveBeenCalled();
  });

  it('lets a manager add someone else', async () => {
    arrange({ write: 'Public', contributorPermissions: ['VIEW', 'ADD', 'MANAGE'] });

    await addContributorToCollection({
      collectionId: COLLECTION_ID,
      userId: OTHER_ID,
      targetUserId: 555,
    });
    expect(mockDbWrite.collectionContributor.upsert).toHaveBeenCalled();
  });
});
