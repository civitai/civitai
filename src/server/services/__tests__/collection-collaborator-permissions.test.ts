import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDbRead, mockDbWrite } = vi.hoisted(() => ({
  mockDbRead: { $queryRaw: vi.fn() },
  mockDbWrite: { $queryRaw: vi.fn(), collectionContributor: { upsert: vi.fn() } },
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbWrite }));

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
}: {
  read?: 'Public' | 'Unlisted' | 'Private';
  write?: 'Public' | 'Review' | 'Private';
  contributorPermissions?: string[] | null;
  collaborationDisabledAt?: Date | null;
}) {
  mockDbRead.$queryRaw.mockReset();
  mockDbRead.$queryRaw.mockResolvedValueOnce([
    {
      id: COLLECTION_ID,
      read,
      write,
      userId: OWNER_ID,
      type: 'Image',
      mode: null,
      contributorPermissions,
      collaborationDisabledAt,
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

  it('refuses to write another user\'s row without manage', async () => {
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
