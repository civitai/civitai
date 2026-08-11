import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as CollectionService from '~/server/services/collection.service';
import type * as LoggingClient from '~/server/logging/client';
import type { Context } from '~/server/createContext';

/**
 * `collection.getById` serves every collection detail page view, and it now carries the
 * collaborator roster. The rules that keep that safe live in `getCollectionRoster` and in the one
 * field assignment in `getCollectionByIdHandler`; a refactor of either would re-open a disclosure
 * with nothing to stop it. These tests run the REAL handler and the REAL roster derivation against
 * a mocked `dbRead`, so the guards are asserted where they actually execute.
 */

const { mockDbRead, mockDbWrite, mockGetPermissions, mockGetCollectionById, mockLogToAxiom } =
  vi.hoisted(() => ({
    mockDbRead: {
      collectionContributor: { findMany: vi.fn().mockResolvedValue([]) },
      collectionInvite: { findMany: vi.fn().mockResolvedValue([]) },
    },
    mockDbWrite: {},
    mockGetPermissions: vi.fn(),
    mockGetCollectionById: vi.fn(),
    mockLogToAxiom: vi.fn().mockResolvedValue(undefined),
  }));

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbWrite }));

vi.mock('~/server/services/collection.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CollectionService>()),
  getUserCollectionPermissionsById: mockGetPermissions,
  getCollectionById: mockGetCollectionById,
}));

vi.mock('~/server/logging/client', async (importOriginal) => ({
  ...(await importOriginal<typeof LoggingClient>()),
  logToAxiom: mockLogToAxiom,
}));

const { getCollectionByIdHandler } = await import('~/server/controllers/collection.controller');

const COLLECTION_ID = 10;
const OWNER_ID = 999;
const MANAGER_ID = 777;
const CONTRIBUTOR_ID = 555;
const FOLLOWER_ID = 321;
const VIEWER_ID = 4242;

function arrangeCollection({
  userId = OWNER_ID,
  mode = null,
  read = 'Public',
  write = 'Public',
}: {
  userId?: number;
  mode?: string | null;
  read?: string;
  write?: string;
} = {}) {
  mockGetCollectionById.mockResolvedValue({ id: COLLECTION_ID, userId, mode, read, write });
}

function arrangePermissions({ manage = false }: { manage?: boolean } = {}) {
  mockGetPermissions.mockResolvedValue({
    collectionId: COLLECTION_ID,
    isOwner: false,
    manage,
    read: true,
    write: false,
    collaborationDisabled: false,
    collectionMode: null,
  });
}

function callHandler() {
  const ctx = { user: { id: VIEWER_ID, isModerator: false } } as unknown as Context;
  return getCollectionByIdHandler({ ctx, input: { id: COLLECTION_ID } });
}

// Staged so that a roster WOULD be produced if the guard under test were removed — otherwise an
// empty result proves nothing about the guard and everything about the fixture.
function stageRosterRowsThatWouldLeak() {
  mockDbRead.collectionContributor.findMany.mockResolvedValue([
    { userId: MANAGER_ID, permissions: ['VIEW', 'ADD', 'MANAGE'] },
  ]);
  mockDbRead.collectionInvite.findMany.mockResolvedValue([{ userId: MANAGER_ID }]);
}

beforeEach(() => {
  vi.clearAllMocks();
  arrangePermissions();
  arrangeCollection();
  mockDbRead.collectionContributor.findMany.mockResolvedValue([]);
  mockDbRead.collectionInvite.findMany.mockResolvedValue([]);
  mockLogToAxiom.mockResolvedValue(undefined);
});

describe('collection.getById roster — collections that must never publish one', () => {
  it('withholds the roster for a curated (Contest) collection, before either query runs', async () => {
    arrangeCollection({ mode: 'Contest' });
    stageRosterRowsThatWouldLeak();

    const result = await callHandler();

    expect(result.collaborators).toEqual([]);
    // The exclusion has to short-circuit, not filter after the fact: a Contest collection's staff
    // ADD/MANAGE rows must not even be read.
    expect(mockDbRead.collectionContributor.findMany).not.toHaveBeenCalled();
    expect(mockDbRead.collectionInvite.findMany).not.toHaveBeenCalled();
  });

  it('withholds the roster for the system-owned curation set (userId -1), before either query runs', async () => {
    arrangeCollection({ userId: -1, write: 'Private' });
    stageRosterRowsThatWouldLeak();

    const result = await callHandler();

    expect(result.collaborators).toEqual([]);
    expect(mockDbRead.collectionContributor.findMany).not.toHaveBeenCalled();
    expect(mockDbRead.collectionInvite.findMany).not.toHaveBeenCalled();
  });

  it('withholds the roster from a caller with no read permission', async () => {
    mockGetPermissions.mockResolvedValue({
      collectionId: COLLECTION_ID,
      isOwner: false,
      manage: true,
      read: false,
      write: false,
      collaborationDisabled: false,
      collectionMode: null,
    });
    stageRosterRowsThatWouldLeak();

    const result = await callHandler();

    expect(result.collaborators).toEqual([]);
    expect(mockDbRead.collectionContributor.findMany).not.toHaveBeenCalled();
  });

  // Without this the three cases above would all pass against a handler that never returns a
  // roster at all.
  it('does publish a roster for an eligible collection', async () => {
    stageRosterRowsThatWouldLeak();

    const result = await callHandler();

    expect(result.collaborators).toEqual([{ userId: MANAGER_ID, role: 'Manager' }]);
    expect(mockDbRead.collectionContributor.findMany).toHaveBeenCalledTimes(1);
  });
});

describe('collection.getById roster — the follower-disclosure rule', () => {
  it('excludes a row that only mirrors the free grant and includes one elevated beyond it', async () => {
    // write:Public grants ADD to everyone, so a plain follower's row carries {VIEW, ADD} and is
    // indistinguishable from a Contributor's by permissions alone.
    arrangeCollection({ read: 'Public', write: 'Public' });
    mockDbRead.collectionContributor.findMany.mockResolvedValue([
      { userId: FOLLOWER_ID, permissions: ['VIEW', 'ADD'] },
      { userId: MANAGER_ID, permissions: ['VIEW', 'ADD', 'MANAGE'] },
      { userId: CONTRIBUTOR_ID, permissions: ['VIEW', 'ADD'] },
    ]);
    // Only the accepted Contributor holds a seat; the follower never went through invite/accept.
    mockDbRead.collectionInvite.findMany.mockResolvedValue([{ userId: CONTRIBUTOR_ID }]);

    const result = await callHandler();

    expect(result.collaborators).toEqual(
      expect.arrayContaining([
        { userId: MANAGER_ID, role: 'Manager' },
        { userId: CONTRIBUTOR_ID, role: 'Contributor' },
      ])
    );
    expect(result.collaborators).toHaveLength(2);
    expect(result.collaborators.map((c) => c.userId)).not.toContain(FOLLOWER_ID);
  });

  it('counts an ADD row as elevated when the collection does not grant ADD for free', async () => {
    // Same permissions as the excluded follower above — what changes is the baseline.
    arrangeCollection({ read: 'Public', write: 'Private' });
    mockDbRead.collectionContributor.findMany.mockResolvedValue([
      { userId: CONTRIBUTOR_ID, permissions: ['VIEW', 'ADD'] },
    ]);

    const result = await callHandler();

    expect(result.collaborators).toEqual([{ userId: CONTRIBUTOR_ID, role: 'Contributor' }]);
  });

  it('never reads the owner’s own contributor row into the roster', async () => {
    await callHandler();

    expect(mockDbRead.collectionContributor.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          collectionId: COLLECTION_ID,
          userId: { not: OWNER_ID },
        }),
      })
    );
  });
});

describe('collection.getById roster — a roster failure must not take the page down', () => {
  it('still resolves the page payload with an empty roster when the roster read rejects', async () => {
    mockDbRead.collectionContributor.findMany.mockRejectedValue(new Error('pool timeout'));

    const result = await callHandler();

    expect(result.collaborators).toEqual([]);
    expect(result.collection).toEqual(expect.objectContaining({ id: COLLECTION_ID }));
    expect(result.permissions).toEqual(expect.objectContaining({ read: true }));
  });

  it('reports the swallowed roster failure rather than hiding it', async () => {
    mockDbRead.collectionContributor.findMany.mockRejectedValue(new Error('pool timeout'));

    await callHandler();

    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        name: 'collection-roster-failed',
        message: 'pool timeout',
        collectionId: COLLECTION_ID,
      })
    );
  });

  // The degrade is scoped to the roster read; the reads it sits beside genuinely should fail loud.
  it('still fails the request when the collection read itself fails', async () => {
    mockGetCollectionById.mockRejectedValue(new Error('collection read down'));

    await expect(callHandler()).rejects.toThrow();
  });

  it('still fails the request when the permission read fails', async () => {
    mockGetPermissions.mockRejectedValue(new Error('permission read down'));

    await expect(callHandler()).rejects.toThrow();
  });
});

describe('collection.getById roster — invite data', () => {
  it('exposes no invite fields, and reads nothing but userId off the invite table', async () => {
    mockDbRead.collectionContributor.findMany.mockResolvedValue([
      { userId: CONTRIBUTOR_ID, permissions: ['VIEW', 'ADD', 'MANAGE'] },
    ]);
    mockDbRead.collectionInvite.findMany.mockResolvedValue([
      {
        userId: CONTRIBUTOR_ID,
        id: 9,
        role: 'Contributor',
        createdAt: new Date(),
        status: 'Pending',
      },
    ]);

    const result = await callHandler();

    for (const entry of result.collaborators) {
      expect(Object.keys(entry).sort()).toEqual(['role', 'userId']);
    }
    expect(mockDbRead.collectionInvite.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ select: { userId: true } })
    );
  });

  it('returns no invites field even to a manage-holding caller', async () => {
    arrangePermissions({ manage: true });
    mockDbRead.collectionInvite.findMany.mockResolvedValue([
      { userId: CONTRIBUTOR_ID, id: 9, role: 'Contributor', createdAt: new Date() },
    ]);

    const result = await callHandler();

    expect(result).not.toHaveProperty('invites');
    // The manage-gated pending-invite lookup belongs to getCollaborators; getById must make only
    // the roster's own seated-invite read.
    expect(mockDbRead.collectionInvite.findMany).toHaveBeenCalledTimes(1);
  });
});
