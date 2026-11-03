import { beforeEach, describe, expect, it, vi } from 'vitest';

import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  assertModeratorMayUseShadow,
  OWNER_REVISION_IN_PROGRESS_MESSAGE,
  recordModeratorListingEdit,
  REVISION_IN_REVIEW_MESSAGE,
} from '~/server/services/blocks/app-listing-moderator-edit';

const findListing = dbMock.dbWrite.appListing.findUnique;
const createEvent = dbMock.dbWrite.appListingModerationEvent.create;

beforeEach(() => createEvent.mockClear());

describe('recordModeratorListingEdit', () => {
  it('records an edit of a shadow revision on its parent, under the public slug', async () => {
    findListing.mockResolvedValue({
      id: 'apl_shadow',
      slug: 'rev-01',
      revisionOf: { id: 'apl_parent', slug: 'cool-app' },
    });
    await recordModeratorListingEdit({
      appListingId: 'apl_shadow',
      actorUserId: 7,
      surface: 'details',
    });
    expect(createEvent).toHaveBeenCalledWith({
      data: expect.objectContaining({
        appListingId: 'apl_parent',
        slug: 'cool-app',
        action: 'moderator-edit',
        actorUserId: 7,
        detail: 'details',
        reason: "A moderator edited this listing's details.",
      }),
    });
  });

  it('records a top-level listing on itself', async () => {
    findListing.mockResolvedValue({ id: 'apl_1', slug: 'app', revisionOf: null });
    await recordModeratorListingEdit({ appListingId: 'apl_1', actorUserId: 7, surface: 'media' });
    expect(createEvent).toHaveBeenCalledWith({
      data: expect.objectContaining({ appListingId: 'apl_1', slug: 'app', detail: 'media' }),
    });
  });

  it('refuses, writing nothing, when the listing is gone', async () => {
    findListing.mockResolvedValue(null);
    await expect(
      recordModeratorListingEdit({ appListingId: 'apl_x', actorUserId: 7, surface: 'details' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(createEvent).not.toHaveBeenCalled();
  });
});

describe('assertModeratorMayUseShadow', () => {
  const MOD = 7;
  const OTHER_MOD = 8;
  const parentRow = { name: 'Cool App', tagline: 't', iconId: 1, coverId: 2 };
  let shadowRow: Record<string, unknown>;

  beforeEach(() => {
    shadowRow = { ...parentRow };
    dbMock.dbWrite.appListingPublishRequest.findFirst.mockResolvedValue(null);
    findListing.mockImplementation(
      async (args: { where: { id: string }; select: Record<string, unknown> }) => {
        if ('revisionOfId' in args.select) {
          return args.where.id === 'apl_shadow'
            ? { revisionOfId: 'apl_parent' }
            : { revisionOfId: null };
        }
        if ('revisionOf' in args.select) {
          return {
            id: args.where.id,
            slug: 'rev-01',
            revisionOf: { id: 'apl_parent', slug: 'cool-app' },
          };
        }
        if ('sourceRepoUrl' in args.select) return { sourceRepoUrl: null };
        return args.where.id === 'apl_shadow' ? shadowRow : parentRow;
      }
    );
    dbMock.dbWrite.appListingScreenshot.findMany.mockResolvedValue([]);
    dbMock.dbWrite.$queryRaw.mockResolvedValue([]);
    dbMock.dbWrite.appListingModerationEvent.findFirst.mockResolvedValue(null);
  });

  async function moderatorSaves(actorUserId: number) {
    createEvent.mockClear();
    await recordModeratorListingEdit({
      appListingId: 'apl_shadow',
      actorUserId,
      surface: 'details',
    });
    const after = (createEvent.mock.calls[0][0] as { data: { after: unknown } }).data.after;
    dbMock.dbWrite.appListingModerationEvent.findFirst.mockResolvedValue({ actorUserId, after });
  }

  const check = (actorUserId = MOD) =>
    assertModeratorMayUseShadow(dbMock.dbWrite as never, { shadowId: 'apl_shadow', actorUserId });

  it('allows a revision that still matches the live listing', async () => {
    await expect(check()).resolves.toBeUndefined();
  });

  it("refuses a revision holding someone else's unsubmitted changes", async () => {
    shadowRow = { ...parentRow, tagline: 'owner draft' };
    await expect(check()).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: OWNER_REVISION_IN_PROGRESS_MESSAGE,
    });
  });

  it('allows a revision holding only this moderator’s own last save', async () => {
    shadowRow = { ...parentRow, tagline: 'mod edit' };
    await moderatorSaves(MOD);
    await expect(check()).resolves.toBeUndefined();
  });

  it('refuses once anyone changes the revision after the moderator’s last save', async () => {
    shadowRow = { ...parentRow, tagline: 'mod edit' };
    await moderatorSaves(MOD);
    shadowRow = { ...parentRow, tagline: 'owner edit on top' };
    await expect(check()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it("refuses another moderator's revision", async () => {
    shadowRow = { ...parentRow, tagline: 'mod edit' };
    await moderatorSaves(OTHER_MOD);
    await expect(check(MOD)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses a revision awaiting review, even one that matches the live listing', async () => {
    dbMock.dbWrite.appListingPublishRequest.findFirst.mockResolvedValue({ id: 'alpr_1' });
    await expect(check()).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: REVISION_IN_REVIEW_MESSAGE,
    });
  });

  it('refuses even the moderator’s own revision once it is awaiting review', async () => {
    shadowRow = { ...parentRow, tagline: 'mod edit' };
    await moderatorSaves(MOD);
    dbMock.dbWrite.appListingPublishRequest.findFirst.mockResolvedValue({ id: 'alpr_1' });
    await expect(check()).rejects.toMatchObject({ message: REVISION_IN_REVIEW_MESSAGE });
  });

  it('a re-packed screenshot order is not mistaken for someone else’s change', async () => {
    shadowRow = { ...parentRow, tagline: 'mod edit' };
    dbMock.dbWrite.appListingScreenshot.findMany.mockResolvedValue([
      { imageId: 31, order: 1, caption: null },
      { imageId: 32, order: 2, caption: null },
    ]);
    await moderatorSaves(MOD);
    dbMock.dbWrite.appListingScreenshot.findMany.mockResolvedValue([
      { imageId: 31, order: 0, caption: null },
      { imageId: 32, order: 1, caption: null },
    ]);
    await expect(check()).resolves.toBeUndefined();
  });

  it('a reordered set of screenshots is a change', async () => {
    shadowRow = { ...parentRow, tagline: 'mod edit' };
    dbMock.dbWrite.appListingScreenshot.findMany.mockResolvedValue([
      { imageId: 31, order: 0, caption: null },
      { imageId: 32, order: 1, caption: null },
    ]);
    await moderatorSaves(MOD);
    dbMock.dbWrite.appListingScreenshot.findMany.mockResolvedValue([
      { imageId: 32, order: 0, caption: null },
      { imageId: 31, order: 1, caption: null },
    ]);
    await expect(check()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('the audit fingerprint inside a transaction', () => {
  it('does not read a missing source-repo column through the transaction', async () => {
    const txFind = vi.fn(async (args: { select: Record<string, unknown> }) => {
      if ('sourceRepoUrl' in args.select) throw new Error('would abort the transaction');
      if ('revisionOf' in args.select) {
        return {
          id: 'apl_shadow',
          slug: 'rev-01',
          revisionOf: { id: 'apl_parent', slug: 'cool-app' },
        };
      }
      return { name: 'n' };
    });
    const tx = {
      appListing: { findUnique: txFind },
      appListingScreenshot: { findMany: vi.fn(async () => []) },
      appListingModerationEvent: { create: vi.fn(async () => ({})) },
      $queryRaw: vi.fn(async () => []),
    };
    findListing.mockRejectedValue(Object.assign(new Error('missing column'), { code: 'P2022' }));
    await recordModeratorListingEdit({
      db: tx as never,
      appListingId: 'apl_shadow',
      actorUserId: 7,
      surface: 'details',
    });
    expect(tx.appListingModerationEvent.create).toHaveBeenCalled();
    expect(txFind.mock.calls.some(([a]) => 'sourceRepoUrl' in a.select)).toBe(false);
  });
});
