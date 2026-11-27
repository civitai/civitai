import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock, redisMock, resetSharedMocks } from '~/__tests__/mocks';
import { BlocklistType } from '~/server/common/enums';
import { notifications } from '~/server/notifications/client';
import {
  AppReviewThreadError,
  listReviewMessages,
  postReviewMessage,
} from '~/server/services/blocks/app-review-thread.service';

/**
 * `postReviewMessage` / `listReviewMessages` against the real service, the real access resolver
 * (`resolveListingAccess`, `resolveAppAccess`) and the real blocklist filter. Only the shared
 * boundaries are faked: the Prisma clients (`dbMock`), redis (the blocklist cache) and the
 * notifications client, whose `createNotification` is the one place a notification leaves.
 *
 * Who is on the thread follows the app's CURRENT canonical owner. The ownership-transfer case is
 * the regression: before the fix the original submitter stayed a participant (and kept getting
 * moderator-reply notifications) after the app changed hands.
 */

// Pairwise distinct, so an assertion naming one cannot be satisfied by another.
const SUBMITTER = 7101;
const NEW_OWNER = 7202;
const STRANGER = 7303;
const REVIEWER = 7404;
const EDITOR = 7505;

const OWNED = 'pubreq_Owned01';
const FIRST = 'pubreq_First01';
const LISTING_REQ = 'alpr_Listing01';

const state = {
  /** The app's canonical owner (`OauthClient.userId`), moved by a transfer. */
  blockOwner: SUBMITTER,
  /** The off-site listing's owner column, moved by a transfer or a moderator claim. */
  offsiteOwner: SUBMITTER,
  /** A listing already holding the first version's slug, and who owns it. */
  firstSlugOwner: null as number | null,
  messageId: 991,
};

const reviewerChip = { id: REVIEWER, username: 'reviewer_a', image: null, deletedAt: null };

function versionRow(id: string) {
  if (id === OWNED) {
    return {
      slug: 'pixel-pal',
      version: '1.2.0',
      manifest: { name: 'Pixel Pal' },
      status: 'rejected',
      rejectionReason: 'Add a spend confirmation.',
      approvalNotes: null,
      submittedByUserId: SUBMITTER,
      reviewedByUserId: REVIEWER,
      appBlockId: 'ab_owned',
      reviewedBy: reviewerChip,
    };
  }
  if (id === FIRST) {
    return {
      slug: 'first-app',
      version: '0.1.0',
      manifest: { name: 'First App' },
      status: 'rejected',
      rejectionReason: 'Crashes on load.',
      approvalNotes: null,
      submittedByUserId: SUBMITTER,
      reviewedByUserId: REVIEWER,
      appBlockId: null,
      reviewedBy: reviewerChip,
    };
  }
  return null;
}

function listingRow(id: string) {
  if (id === 'apl_owned') {
    return {
      id,
      userId: SUBMITTER, // the denormalized copy a transfer of an on-site app leaves stale
      slug: 'pixel-pal',
      kind: 'onsite',
      appBlockId: 'ab_owned',
      revisionOfId: null,
      appBlock: { app: { userId: state.blockOwner } },
      revisionOf: null,
    };
  }
  if (id === 'apl_offsite') {
    return {
      id,
      userId: state.offsiteOwner,
      slug: 'link-out',
      kind: 'offsite',
      appBlockId: null,
      revisionOfId: null,
      appBlock: null,
      revisionOf: null,
    };
  }
  if (id === 'apl_first' && state.firstSlugOwner != null) {
    return {
      id,
      userId: state.firstSlugOwner,
      slug: 'first-app',
      kind: 'onsite',
      appBlockId: null,
      revisionOfId: null,
      appBlock: null,
      revisionOf: null,
    };
  }
  return null;
}

const createNotification = vi.mocked(notifications.createNotification);
const createMessage = dbMock.dbWrite.appReviewMessage.create;

beforeEach(() => {
  resetSharedMocks();
  state.blockOwner = SUBMITTER;
  state.offsiteOwner = SUBMITTER;
  state.firstSlugOwner = null;

  dbMock.dbRead.appBlockPublishRequest.findUnique.mockImplementation((async (args: {
    where: { id: string };
  }) => versionRow(args.where.id)) as never);
  dbMock.dbRead.appListingPublishRequest.findUnique.mockImplementation((async (args: {
    where: { id: string };
  }) =>
    args.where.id === LISTING_REQ
      ? {
          slug: 'link-out',
          status: 'approved',
          rejectionReason: null,
          approvalNotes: 'Looks good.',
          submittedByUserId: SUBMITTER,
          reviewedByUserId: REVIEWER,
          appListingId: 'apl_offsite',
          appListing: { name: 'Link Out' },
          reviewedBy: reviewerChip,
        }
      : null) as never);
  dbMock.dbRead.appListing.findUnique.mockImplementation((async (args: {
    where: { id?: string; appBlockId?: string; slug?: string };
  }) => {
    const { where } = args;
    if (where.appBlockId === 'ab_owned') return { id: 'apl_owned' };
    if (where.slug === 'first-app') {
      return state.firstSlugOwner != null ? { id: 'apl_first', revisionOfId: null } : null;
    }
    return where.id ? listingRow(where.id) : null;
  }) as never);
  // An accepted editor seat exists on the app: it must not make the editor a participant.
  dbMock.dbRead.appCollaborator.findFirst.mockImplementation((async (args: {
    where: { userId: number };
  }) => (args.where.userId === EDITOR ? { userId: EDITOR } : null)) as never);
  dbMock.dbRead.user.findUnique.mockImplementation((async (args: { where: { id: number } }) =>
    args.where.id === REVIEWER
      ? { id: REVIEWER, deletedAt: null, bannedAt: null, isModerator: true }
      : null) as never);
  createMessage.mockImplementation((async () => ({ id: state.messageId })) as never);
  dbMock.dbRead.appReviewMessage.findMany.mockResolvedValue([] as never);

  // The blocklist cache: one blocked link domain, no message patterns.
  redisMock.redis.get.mockImplementation((async (key: string) => {
    if (key.endsWith(`:${BlocklistType.LinkDomain}`))
      return JSON.stringify({ type: BlocklistType.LinkDomain, data: ['blocked.example'] });
    if (key.endsWith(`:${BlocklistType.MessagePattern}`))
      return JSON.stringify({ type: BlocklistType.MessagePattern, data: [] });
    return null;
  }) as never);

  createNotification.mockReset();
  createNotification.mockResolvedValue(undefined as never);
});

const developer = (userId: number) => ({ userId, isModerator: false });
const moderator = { userId: REVIEWER, isModerator: true };

async function codeOf(promise: Promise<unknown>): Promise<string | null> {
  return promise.then(
    () => null,
    (err: unknown) => (err instanceof AppReviewThreadError ? err.code : String(err))
  );
}

function transfer() {
  state.blockOwner = NEW_OWNER;
}

describe('participants follow the current owner', () => {
  it('🔴 after a transfer the former owner gets NOT_FOUND, and nothing is written or sent', async () => {
    transfer();

    expect(
      await codeOf(listReviewMessages({ subjectId: OWNED, viewer: developer(SUBMITTER) }))
    ).toBe('NOT_FOUND');
    expect(
      await codeOf(
        postReviewMessage({
          input: { subjectId: OWNED, body: 'Still here?' },
          viewer: developer(SUBMITTER),
        })
      )
    ).toBe('NOT_FOUND');
    expect(dbMock.dbRead.appReviewMessage.findMany).not.toHaveBeenCalled();
    expect(createMessage).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('after a transfer the new owner reads the thread', async () => {
    transfer();
    await listReviewMessages({ subjectId: OWNED, viewer: developer(NEW_OWNER) });
    expect(dbMock.dbRead.appReviewMessage.findMany).toHaveBeenCalledTimes(1);
  });

  it('the submitter takes part while they are still the owner', async () => {
    await listReviewMessages({ subjectId: OWNED, viewer: developer(SUBMITTER) });
    expect(dbMock.dbRead.appReviewMessage.findMany).toHaveBeenCalledTimes(1);
    // …and the owner-to-be is nobody yet.
    expect(
      await codeOf(listReviewMessages({ subjectId: OWNED, viewer: developer(NEW_OWNER) }))
    ).toBe('NOT_FOUND');
  });

  it('a stranger and an accepted editor get NOT_FOUND, and nothing is written', async () => {
    for (const userId of [STRANGER, EDITOR]) {
      expect(
        await codeOf(
          postReviewMessage({ input: { subjectId: OWNED, body: 'Hi' }, viewer: developer(userId) })
        ),
        String(userId)
      ).toBe('NOT_FOUND');
    }
    expect(createMessage).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('a listing request follows the off-site owner column after a claim or transfer', async () => {
    state.offsiteOwner = NEW_OWNER;
    expect(
      await codeOf(listReviewMessages({ subjectId: LISTING_REQ, viewer: developer(SUBMITTER) }))
    ).toBe('NOT_FOUND');
    await listReviewMessages({ subjectId: LISTING_REQ, viewer: developer(NEW_OWNER) });
    expect(dbMock.dbRead.appReviewMessage.findMany).toHaveBeenCalledTimes(1);
  });

  it('a first version with no listing yet: its submitter is the developer side', async () => {
    await listReviewMessages({ subjectId: FIRST, viewer: developer(SUBMITTER) });
    expect(dbMock.dbRead.appReviewMessage.findMany).toHaveBeenCalledTimes(1);
  });

  it('a first version whose slug listing the submitter owns: still theirs', async () => {
    state.firstSlugOwner = SUBMITTER;
    await listReviewMessages({ subjectId: FIRST, viewer: developer(SUBMITTER) });
    expect(dbMock.dbRead.appReviewMessage.findMany).toHaveBeenCalledTimes(1);
  });

  it('a first version whose slug listing someone else owns: nobody on the developer side', async () => {
    state.firstSlugOwner = NEW_OWNER;
    for (const userId of [SUBMITTER, NEW_OWNER]) {
      expect(
        await codeOf(listReviewMessages({ subjectId: FIRST, viewer: developer(userId) })),
        String(userId)
      ).toBe('NOT_FOUND');
    }
    // A moderator still reads it.
    await listReviewMessages({ subjectId: FIRST, viewer: moderator });
    expect(dbMock.dbRead.appReviewMessage.findMany).toHaveBeenCalledTimes(1);
  });
});

describe('posting stores the row and sends exactly one notification', () => {
  it("a developer's reply goes to the reviewer", async () => {
    transfer();
    const out = await postReviewMessage({
      input: { subjectId: OWNED, body: '  Added the confirm step.  ' },
      viewer: developer(NEW_OWNER),
    });

    expect(out).toEqual({ id: state.messageId, routedTo: 'reviewer' });
    expect(createMessage).toHaveBeenCalledTimes(1);
    expect(createMessage.mock.calls[0]![0]).toMatchObject({
      data: {
        publishRequestId: OWNED,
        authorUserId: NEW_OWNER,
        authorRole: 'developer',
        body: 'Added the confirm step.',
        recipientUserId: REVIEWER,
      },
    });
    expect(createNotification).toHaveBeenCalledTimes(1);
    expect(createNotification.mock.calls[0]![0]).toMatchObject({
      type: 'app-review-reply-to-moderator',
      userIds: [REVIEWER],
      key: `app-review-reply:${state.messageId}`,
    });
  });

  it("🔴 a moderator's reply notifies the CURRENT owner only, never the former one", async () => {
    transfer();
    const out = await postReviewMessage({
      input: { subjectId: OWNED, body: 'Thanks, re-reviewing.' },
      viewer: moderator,
    });

    expect(out).toEqual({ id: state.messageId, routedTo: 'developer' });
    expect(createMessage).toHaveBeenCalledTimes(1);
    expect(createMessage.mock.calls[0]![0]).toMatchObject({
      data: { authorUserId: REVIEWER, authorRole: 'moderator', recipientUserId: null },
    });
    expect(createNotification).toHaveBeenCalledTimes(1);
    expect(createNotification.mock.calls[0]![0]).toMatchObject({
      type: 'app-review-reply-to-developer',
      userIds: [NEW_OWNER],
    });
  });

  it("🔴 the stored to-developer details carry no account id, only the message's", async () => {
    await postReviewMessage({
      input: { subjectId: OWNED, body: 'Looks good now.' },
      viewer: moderator,
    });

    const sent = createNotification.mock.calls[0]![0] as unknown as {
      details: Record<string, unknown>;
    };
    const details = sent.details;
    expect(details).toEqual({
      subjectId: OWNED,
      slug: 'pixel-pal',
      name: 'Pixel Pal',
      excerpt: 'Looks good now.',
      messageId: state.messageId,
    });
    // Whatever the key, the author's id is not in what the browser is sent.
    const values = JSON.stringify(details);
    expect(values).not.toContain(String(REVIEWER));
    expect(values).not.toContain(String(SUBMITTER));
  });

  it('a blocked link is refused: no row, no notification', async () => {
    expect(
      await codeOf(
        postReviewMessage({
          input: { subjectId: OWNED, body: 'Details at https://blocked.example/fix' },
          viewer: developer(SUBMITTER),
        })
      )
    ).toBe('BLOCKED_LINK');
    expect(createMessage).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();

    // Positive control: the same post without the link goes through.
    await postReviewMessage({
      input: { subjectId: OWNED, body: 'Details in the changelog.' },
      viewer: developer(SUBMITTER),
    });
    expect(createMessage).toHaveBeenCalledTimes(1);
  });
});
