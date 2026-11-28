import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `notifyAppBlockSubmitter` helper — forwards to `createNotification` with the right
 * shape via its dynamic import. Only the notifications client is mocked; the helper's
 * static imports are a type (erased) and a dependency-free leaf, so nothing else is pulled. `~/server/common/enums`
 * is the REAL module (so we assert the actual `NotificationCategory.System` value).
 */

const { mockCreateNotification } = vi.hoisted(() => ({
  mockCreateNotification: vi.fn(async (..._a: unknown[]) => undefined),
}));

vi.mock('~/server/services/notification.service', () => ({
  createNotification: mockCreateNotification,
}));

const { notifyAppBlockSubmitter } = await import('~/server/services/blocks/app-block-notify');
const { notifyAppListingOwner } = await import('~/server/services/blocks/app-listing-notify');

/** The details the one notification was created with. */
const sentDetails = () =>
  (mockCreateNotification.mock.calls[0][0] as { details: Record<string, unknown> }).details;

beforeEach(() => {
  mockCreateNotification.mockReset().mockResolvedValue(undefined);
});

describe('notifyAppBlockSubmitter', () => {
  it('forwards a single-user System notification with the type, key and details', async () => {
    await notifyAppBlockSubmitter(
      {
        type: 'app-block-approved',
        userId: 77,
        key: 'app-block-approved:req_1',
        details: { slug: 'cool-app', name: 'Cool App', version: '1.0.0' },
        attribution: { kind: 'moderator', requestId: 'pubreq_1' },
      },
      async () => true
    );

    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
    const arg = mockCreateNotification.mock.calls[0][0];
    expect(arg).toMatchObject({
      userId: 77,
      category: 'System',
      type: 'app-block-approved',
      key: 'app-block-approved:req_1',
      details: {
        slug: 'cool-app',
        name: 'Cool App',
        version: '1.0.0',
        reviewedByModerator: true,
        reviewRequestId: 'pubreq_1',
      },
    });
  });

  it('records an automated decision as automated, with no reviewer id', async () => {
    await notifyAppBlockSubmitter(
      {
        type: 'app-block-rejected',
        userId: 5,
        key: 'app-block-rejected:req_3',
        details: { slug: 's', reason: 'nope' },
        attribution: { kind: 'automated' },
      },
      async () => true
    );
    expect(sentDetails()).toEqual({ slug: 's', reason: 'nope', reviewedAutomatically: true });
  });

  it('carries the rejection reason through in details, and never asks about run pages', async () => {
    const canOpen = vi.fn(async (_userId: number) => true);
    await notifyAppBlockSubmitter(
      {
        type: 'app-block-rejected',
        userId: 5,
        key: 'app-block-rejected:req_2',
        details: { slug: 's', reason: 'nope' },
        attribution: { kind: 'moderator', requestId: 'pubreq_1' },
      },
      canOpen
    );
    const arg = mockCreateNotification.mock.calls[0][0];
    expect(arg.type).toBe('app-block-rejected');
    expect(arg.details.reason).toBe('nope');
    expect(sentDetails()).not.toHaveProperty('canOpenRunPage');
    expect(canOpen).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    '🔴 an approval records canOpenRunPage=%s, asked of the SUBMITTER',
    async (answer) => {
      const canOpen = vi.fn(async (_userId: number) => answer);
      await notifyAppBlockSubmitter(
        {
          type: 'app-block-approved',
          userId: 77,
          key: 'app-block-approved:req_1',
          details: { slug: 'cool-app', hasPage: true },
          attribution: { kind: 'moderator', requestId: 'pubreq_1' },
        },
        canOpen
      );
      expect(canOpen.mock.calls).toEqual([[77]]);
      expect(sentDetails()).toEqual({
        slug: 'cool-app',
        hasPage: true,
        reviewedByModerator: true,
        reviewRequestId: 'pubreq_1',
        canOpenRunPage: answer,
      });
    }
  );

  it('🔴 a failed run-page read still sends the approval, with canOpenRunPage false', async () => {
    await notifyAppBlockSubmitter(
      {
        type: 'app-block-approved',
        userId: 77,
        key: 'app-block-approved:req_1',
        details: { slug: 'cool-app', hasPage: true },
        attribution: { kind: 'moderator', requestId: 'pubreq_1' },
      },
      async () => Promise.reject(new Error('flags unreadable'))
    );
    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
    expect(sentDetails().canOpenRunPage).toBe(false);
  });
});

describe('notifyAppBlockSubmitter — the owner’s copy of a staff on-behalf outcome', () => {
  it('an owner approval asks whether the OWNER can open run pages; an owner rejection never asks', async () => {
    const canOpen = vi.fn(async (userId: number) => userId === 7101);
    await notifyAppBlockSubmitter(
      {
        type: 'app-platform-update-approved',
        userId: 7101,
        key: 'app-platform-update-approved:req_1',
        details: { slug: 'g', updateId: 'apu_1', byUsername: 'mod-ana' },
        attribution: { kind: 'moderator', requestId: 'req_1' },
      },
      canOpen
    );
    expect(canOpen.mock.calls).toEqual([[7101]]);
    expect(sentDetails()).toEqual({
      slug: 'g',
      updateId: 'apu_1',
      byUsername: 'mod-ana',
      reviewedByModerator: true,
      reviewRequestId: 'req_1',
      canOpenRunPage: true,
    });

    mockCreateNotification.mockClear();
    canOpen.mockClear();
    await notifyAppBlockSubmitter(
      {
        type: 'app-platform-update-rejected',
        userId: 7101,
        key: 'app-platform-update-rejected:req_1',
        details: { slug: 'g', reason: 'nope', updateId: 'apu_1', byUsername: 'mod-ana' },
        attribution: { kind: 'moderator', requestId: 'req_1' },
      },
      canOpen
    );
    expect(canOpen).not.toHaveBeenCalled();
    expect(sentDetails()).not.toHaveProperty('canOpenRunPage');
  });
});

/**
 * 🔴 What the notification is CREATED with is what the realtime new-notification push sends to
 * the browser as-is (no detail fetcher runs on it), so a moderator decision must store no
 * reviewer account id: only the marker and the decided request, which the detail fetcher
 * resolves server-side.
 */
describe('a moderator decision stores no reviewer account id', () => {
  /** The whole createNotification argument, as the push would serialise it. */
  const created = () => mockCreateNotification.mock.calls[0][0] as Record<string, unknown>;

  it.each(['app-block-approved', 'app-block-rejected'] as const)('%s', async (type) => {
    await notifyAppBlockSubmitter(
      {
        type,
        userId: 77,
        key: `${type}:pubreq_9`,
        details: { slug: 'cool-app', name: 'Cool App', version: '1.0.0' },
        attribution: { kind: 'moderator', requestId: 'pubreq_9' },
      },
      async () => true
    );
    const details = created().details as Record<string, unknown>;
    expect(details).not.toHaveProperty('reviewerUserId');
    expect(details).toMatchObject({ reviewedByModerator: true, reviewRequestId: 'pubreq_9' });
  });

  it.each(['app-listing-approved', 'app-listing-rejected'] as const)('%s', async (type) => {
    await notifyAppListingOwner({
      type,
      userId: 77,
      key: `${type}:alpr_9`,
      details: { slug: 'cool-app', name: 'Cool App', listingId: 'apl_9', reason: null },
      attribution: { kind: 'moderator', requestId: 'alpr_9' },
    });
    expect(created()).toEqual({
      userId: 77,
      category: 'System',
      type,
      key: `${type}:alpr_9`,
      details: {
        slug: 'cool-app',
        name: 'Cool App',
        listingId: 'apl_9',
        reason: null,
        reviewedByModerator: true,
        reviewRequestId: 'alpr_9',
      },
    });
  });

  it('🔴 never copies a reviewer id handed in alongside the request', async () => {
    // A caller that still passes the moderator's id in `attribution` must not get it stored.
    await notifyAppListingOwner({
      type: 'app-listing-approved',
      userId: 77,
      key: 'app-listing-approved:alpr_9',
      details: { slug: 'cool-app', listingId: 'apl_9' },
      attribution: { kind: 'moderator', requestId: 'alpr_9', userId: 90417 } as never,
    });
    expect(created().details).not.toHaveProperty('reviewerUserId');
    expect(JSON.stringify(created())).not.toContain('90417');
  });

  it('🔴 never stores attribution fields a caller passes in details', async () => {
    // `details` is typed with the stored attribution fields, so a caller can type-check one in.
    const stray = { reviewerUserId: 90417, reviewedByModerator: true, reviewRequestId: 'alpr_x' };
    await notifyAppBlockSubmitter(
      {
        type: 'app-block-rejected',
        userId: 77,
        key: 'app-block-rejected:pubreq_9',
        details: { slug: 'cool-app', reason: 'nope', ...stray },
        attribution: { kind: 'team' },
      },
      async () => true
    );
    await notifyAppListingOwner({
      type: 'app-listing-hidden',
      userId: 77,
      key: 'app-listing-hidden:evt_9',
      details: { slug: 'cool-app', reason: 'Spam', ...stray },
      attribution: { kind: 'team' },
    });
    const [block, listing] = mockCreateNotification.mock.calls.map(
      ([arg]) => (arg as { details: unknown }).details
    );
    expect(block).toEqual({ slug: 'cool-app', reason: 'nope', reviewedByTeam: true });
    expect(listing).toEqual({ slug: 'cool-app', reason: 'Spam', reviewedByTeam: true });
  });

  // Invariant guard: a takedown was already team-only before this change.
  it('a takedown stores the team only', async () => {
    await notifyAppListingOwner({
      type: 'app-listing-hidden',
      userId: 77,
      key: 'app-listing-hidden:evt_9',
      details: { slug: 'cool-app', listingId: 'apl_9', reason: 'Spam' },
      attribution: { kind: 'team' },
    });
    expect(created().details).toEqual({
      slug: 'cool-app',
      listingId: 'apl_9',
      reason: 'Spam',
      reviewedByTeam: true,
    });
  });
});
