import { describe, expect, it, vi } from 'vitest';
import { setEnv } from '~/__tests__/mocks/env.mock';
import type { DetailFetcherContext } from '~/server/notifications/detail-fetchers/base.detail-fetcher';

setEnv({ NEXTAUTH_URL: 'https://civitai.com' });

const { getNotificationMessage } = await import('~/server/notifications/utils.notifications');
const {
  appReviewByline,
  decisionReviewer,
  decisionReviewerByline,
  withApprovalNote,
  appReviewAttributionDetails,
} = await import('~/server/notifications/app-review-attribution');
const { appReviewDetailFetcher } = await import(
  '~/server/notifications/detail-fetchers/app-review.detail-fetcher'
);
const { notificationEmail } = await import('~/server/email/templates/notification.email');

/**
 * Review attribution: who an app-review decision came from, on the notification (bell + email)
 * and on the developer's own submission history. Pure — the DB reads (the detail fetcher)
 * get a fake client through its context argument.
 */

/** The decisions that name the individual reviewer. A takedown (`app-listing-hidden`) never does. */
const NAMED_TYPES = [
  'app-block-approved',
  'app-block-rejected',
  'app-listing-approved',
  'app-listing-rejected',
  'app-platform-update-approved',
  'app-platform-update-rejected',
] as const;
const ALL_DECISION_TYPES = [...NAMED_TYPES, 'app-listing-hidden'] as const;

const BASE = { slug: 'pixel-pal', name: 'Pixel Pal', reason: 'Broken build' };
const named = { reviewerUserId: 31, actor: { username: 'reviewer_ada', deletedAt: null } };

describe('appReviewByline', () => {
  it('names a live reviewer', () => {
    expect(appReviewByline(named)).toBe('Reviewed by @reviewer_ada, Civitai App Review');
  });

  it('falls back to the team when the reviewer account is gone', () => {
    // The fetcher resolves no actor for a deleted account; a stale actor with deletedAt too.
    expect(appReviewByline({ reviewerUserId: 31 })).toBe('Reviewed by Civitai App Review');
    expect(
      appReviewByline({ reviewerUserId: 31, actor: { username: 'gone', deletedAt: new Date() } })
    ).toBe('Reviewed by Civitai App Review');
  });

  it('names only the team for a team attribution', () => {
    expect(appReviewByline({ reviewedByTeam: true, ...named })).toBe(
      'Reviewed by Civitai App Review'
    );
  });

  it('says an automated decision was automated, even if an actor is present', () => {
    expect(appReviewByline({ reviewedAutomatically: true, ...named })).toBe(
      'Reviewed automatically by Civitai App Review'
    );
  });

  it('is absent on a notification sent before attribution existed', () => {
    expect(appReviewByline({})).toBeUndefined();
  });

  it('maps an emitter attribution to the stored fields', () => {
    // A moderator decision stores the decided request and a marker, never the reviewer's id.
    expect(appReviewAttributionDetails({ kind: 'moderator', requestId: 'pubreq_7' })).toEqual({
      reviewedByModerator: true,
      reviewRequestId: 'pubreq_7',
    });
    expect(appReviewAttributionDetails({ kind: 'automated' })).toEqual({
      reviewedAutomatically: true,
    });
    expect(appReviewAttributionDetails({ kind: 'team' })).toEqual({ reviewedByTeam: true });
    expect(appReviewAttributionDetails(undefined)).toEqual({});
  });
});

describe('the attributed notification types', () => {
  it.each(NAMED_TYPES)('%s carries the named byline', (type) => {
    const prepared = getNotificationMessage({ type, details: { ...BASE, ...named } });
    expect(prepared?.byline).toBe('Reviewed by @reviewer_ada, Civitai App Review');
  });

  it.each(ALL_DECISION_TYPES)('%s renders an old notification exactly as before', (type) => {
    const prepared = getNotificationMessage({ type, details: { ...BASE } });
    expect(prepared?.byline).toBeUndefined();
  });

  it('🔴 a takedown names the team, never the moderator, whatever the details carry', () => {
    const team = getNotificationMessage({
      type: 'app-listing-hidden',
      details: { ...BASE, reviewedByTeam: true },
    });
    expect(team?.byline).toBe('Reviewed by Civitai App Review');
    // A stored id and a resolved actor (say, sent through another path) still name nobody.
    const leaked = getNotificationMessage({
      type: 'app-listing-hidden',
      details: { ...BASE, ...named, reviewedByTeam: true },
    });
    expect(leaked?.byline).toBe('Reviewed by Civitai App Review');
    const noTeam = getNotificationMessage({
      type: 'app-listing-hidden',
      details: { ...BASE, ...named },
    });
    expect(noTeam?.byline).toBeUndefined();
    // Positive control: the same details on a named type do name the reviewer.
    expect(
      getNotificationMessage({ type: 'app-listing-rejected', details: { ...BASE, ...named } })
        ?.byline
    ).toBe('Reviewed by @reviewer_ada, Civitai App Review');
  });

  it('never resolves a reviewer for a takedown', () => {
    expect(appReviewDetailFetcher.types).not.toContain('app-listing-hidden');
    expect(appReviewDetailFetcher.types).toEqual([...NAMED_TYPES]);
  });

  it('pins the approved copy with and without an approval note', () => {
    expect(getNotificationMessage({ type: 'app-block-approved', details: BASE })?.message).toBe(
      'Your app "Pixel Pal" was approved and will be live in a few minutes.'
    );
    expect(
      getNotificationMessage({
        type: 'app-block-approved',
        details: { ...BASE, approvalNote: '  Lovely onboarding.  ' },
      })?.message
    ).toBe(
      'Your app "Pixel Pal" was approved and will be live in a few minutes. Note from the reviewer: Lovely onboarding.'
    );
    expect(
      getNotificationMessage({
        type: 'app-listing-approved',
        details: { ...BASE, approvalNote: 'Great screenshots.' },
      })?.message
    ).toBe(
      '"Pixel Pal" was approved and is now live in the app store. Note from the reviewer: Great screenshots.'
    );
    expect(withApprovalNote('Approved.', '   ')).toBe('Approved.');
  });

  it('leaves the types outside the decision scope without a byline', () => {
    for (const type of ['app-listing-purged', 'app-listing-reset-to-pending']) {
      expect(getNotificationMessage({ type, details: { ...BASE, ...named } })?.byline).toBe(
        undefined
      );
    }
  });
});

describe('notification email', () => {
  const data = (byline?: string) => ({
    to: 'dev@example.com',
    typeName: 'App approved',
    message: 'Your app "Pixel Pal" was approved.',
    url: '/apps/build',
    byline,
    unsubscribeUrl: 'https://civitai.com/api/notifications/email-unsubscribe?u=1&t=x&s=x',
  });

  it('shows the byline in both the HTML and the plain-text part, escaped', () => {
    const byline = 'Reviewed by @a<b>&c, Civitai App Review';
    const html = notificationEmail.getHtml(data(byline));
    const text = notificationEmail.getText(data(byline));
    expect(html).toContain('Reviewed by @a&lt;b&gt;&amp;c, Civitai App Review');
    expect(html).not.toContain('@a<b>');
    expect(text).toContain(byline);
  });

  it('renders no byline paragraph when there is none', () => {
    const html = notificationEmail.getHtml(data());
    expect(html).not.toContain('Reviewed by');
    expect(notificationEmail.getText(data())).not.toContain('Reviewed by');
  });
});

describe('appReviewDetailFetcher', () => {
  type RequestRow = { id: string; reviewedByUserId: number | null };
  const ctx = (
    users: { id: number; username: string }[],
    requests: { block?: RequestRow[]; listing?: RequestRow[] } = {}
  ) => {
    const findMany = vi.fn(async (_args: unknown) => users);
    // Each fake answers only the ids it was asked for, as the real `where: { id: { in } }` does.
    const requestTable = (rows: RequestRow[]) =>
      vi.fn(async (args: { where: { id: { in: string[] } } }) =>
        rows.filter((r) => args.where.id.in.includes(r.id))
      );
    const blockFindMany = requestTable(requests.block ?? []);
    const listingFindMany = requestTable(requests.listing ?? []);
    return {
      findMany,
      blockFindMany,
      listingFindMany,
      ctx: {
        db: {
          user: { findMany },
          appBlockPublishRequest: { findMany: blockFindMany },
          appListingPublishRequest: { findMany: listingFindMany },
        },
        showSfwFace: true,
      } as unknown as DetailFetcherContext,
    };
  };

  // What a moderator decision stores now: a marker and the decided request, no account id.
  const decided = (reviewRequestId: string) => ({
    ...BASE,
    reviewedByModerator: true,
    reviewRequestId,
  });

  it('🔴 resolves the reviewer from the decided request, per type, excluding deleted accounts', async () => {
    // Both requests carry the SAME id, one in each table: each notification must read the table
    // its type names, never the other one's row.
    const {
      findMany,
      blockFindMany,
      listingFindMany,
      ctx: c,
    } = ctx([{ id: 31, username: 'reviewer_ada' }], {
      block: [{ id: 'req_shared', reviewedByUserId: 31 }],
      listing: [{ id: 'req_shared', reviewedByUserId: 44 }],
    });
    const live = { id: 1, type: 'app-block-approved', details: decided('req_shared') };
    const gone = { id: 2, type: 'app-listing-rejected', details: decided('req_shared') };
    await appReviewDetailFetcher.fetcher([live, gone], c);

    expect(blockFindMany.mock.calls[0]![0]).toMatchObject({
      where: { id: { in: ['req_shared'] } },
    });
    expect(listingFindMany.mock.calls[0]![0]).toMatchObject({
      where: { id: { in: ['req_shared'] } },
    });
    expect((findMany.mock.calls[0]![0] as { where: unknown }).where).toEqual({
      id: { in: [31, 44] },
      deletedAt: null,
    });
    expect(live.details).toEqual({
      ...BASE,
      actor: { username: 'reviewer_ada' },
      reviewedByModerator: true,
    });
    // 44 is not a live account (deleted): the team byline.
    expect(gone.details).toEqual({ ...BASE, reviewedByModerator: true });
    // What the client receives carries neither reviewer id nor the request ids.
    expect(JSON.stringify([live, gone])).not.toMatch(/\b(31|44)\b|req_shared/);
    expect(getNotificationMessage(live)?.byline).toBe(
      'Reviewed by @reviewer_ada, Civitai App Review'
    );
    expect(getNotificationMessage(gone)?.byline).toBe('Reviewed by Civitai App Review');
  });

  it('🔴 the owner’s copy of a staff on-behalf outcome reads the BLOCK request table', async () => {
    // Its request is an AppBlockPublishRequest (the on-behalf submit), though its type is not
    // `app-block-*`. The same id in the listing table names another reviewer.
    const {
      blockFindMany,
      listingFindMany,
      ctx: c,
    } = ctx([{ id: 31, username: 'reviewer_ada' }], {
      block: [{ id: 'pubreq_ob', reviewedByUserId: 31 }],
      listing: [{ id: 'pubreq_ob', reviewedByUserId: 44 }],
    });
    const approved = {
      id: 1,
      type: 'app-platform-update-approved',
      details: decided('pubreq_ob'),
    };
    const rejected = {
      id: 2,
      type: 'app-platform-update-rejected',
      details: decided('pubreq_ob'),
    };
    await appReviewDetailFetcher.fetcher([approved, rejected], c);
    expect(blockFindMany).toHaveBeenCalledTimes(1);
    expect(listingFindMany).not.toHaveBeenCalled();
    for (const n of [approved, rejected]) {
      expect(n.details).toEqual({
        ...BASE,
        actor: { username: 'reviewer_ada' },
        reviewedByModerator: true,
      });
    }
  });

  it('falls back to the team when the request has no reviewer or is gone', async () => {
    const { findMany, ctx: c } = ctx([], {
      block: [{ id: 'pubreq_unset', reviewedByUserId: null }],
    });
    const unset = { id: 1, type: 'app-block-rejected', details: decided('pubreq_unset') };
    const missing = { id: 2, type: 'app-listing-approved', details: decided('alpr_missing') };
    await appReviewDetailFetcher.fetcher([unset, missing], c);
    expect(findMany).not.toHaveBeenCalled();
    for (const n of [unset, missing]) {
      expect(n.details).toEqual({ ...BASE, reviewedByModerator: true });
      expect(getNotificationMessage(n)?.byline).toBe('Reviewed by Civitai App Review');
    }
  });

  it('resolves a legacy stored reviewer id into the actor, excluding deleted accounts', async () => {
    const { findMany, ctx: c } = ctx([{ id: 31, username: 'reviewer_ada' }]);
    const live = { id: 1, type: 'app-block-approved', details: { ...BASE, reviewerUserId: 31 } };
    const gone = { id: 2, type: 'app-listing-rejected', details: { ...BASE, reviewerUserId: 44 } };
    await appReviewDetailFetcher.fetcher([live, gone], c);

    const where = (findMany.mock.calls[0]![0] as { where: unknown }).where;
    expect(where).toEqual({ id: { in: [31, 44] }, deletedAt: null });
    expect(live.details).toMatchObject({ actor: { username: 'reviewer_ada' } });
    expect((live.details as Record<string, unknown>).actor).not.toHaveProperty('id');
    expect(gone.details).not.toHaveProperty('actor');
    expect(getNotificationMessage(gone)?.byline).toBe('Reviewed by Civitai App Review');
    expect(getNotificationMessage(live)?.byline).toBe(
      'Reviewed by @reviewer_ada, Civitai App Review'
    );
  });

  it('🔴 returns no reviewer account id from a legacy notification, resolved or deleted', async () => {
    const { ctx: c } = ctx([{ id: 31, username: 'reviewer_ada' }]);
    const live = { id: 1, type: 'app-block-approved', details: { ...BASE, reviewerUserId: 31 } };
    const gone = { id: 2, type: 'app-listing-rejected', details: { ...BASE, reviewerUserId: 44 } };
    const unset = { id: 3, type: 'app-block-rejected', details: { ...BASE, reviewerUserId: null } };
    await appReviewDetailFetcher.fetcher([live, gone, unset], c);

    for (const n of [live, gone, unset]) expect(n.details).not.toHaveProperty('reviewerUserId');
    // Nothing in what the client receives carries either id.
    expect(JSON.stringify([live, gone, unset])).not.toMatch(/\b(31|44)\b/);
    expect(live.details).toEqual({
      ...BASE,
      actor: { username: 'reviewer_ada' },
      reviewedByModerator: true,
    });
    expect(gone.details).toEqual({ ...BASE, reviewedByModerator: true });
    // A null id named nobody: no byline, as before attribution.
    expect(unset.details).toEqual(BASE);
    expect(getNotificationMessage(unset)?.byline).toBeUndefined();
  });

  it('makes no query for notifications without a reviewer', async () => {
    const { findMany, blockFindMany, listingFindMany, ctx: c } = ctx([]);
    const n = { id: 1, type: 'app-block-rejected', details: { ...BASE } };
    await appReviewDetailFetcher.fetcher([n], c);
    expect(findMany).not.toHaveBeenCalled();
    expect(blockFindMany).not.toHaveBeenCalled();
    expect(listingFindMany).not.toHaveBeenCalled();
    expect(n.details).toEqual(BASE);
  });
});

describe('decisionReviewer (the developer-facing history projection)', () => {
  const ada = { username: 'reviewer_ada', image: 'https://image.example/a.png', deletedAt: null };

  it('names the reviewer of a decided request, with no id', () => {
    expect(decisionReviewer('approved', ada)).toEqual({
      account: { username: 'reviewer_ada', image: 'https://image.example/a.png' },
    });
    expect(decisionReviewer('rejected', ada)).toEqual({
      account: { username: 'reviewer_ada', image: 'https://image.example/a.png' },
    });
  });

  it('falls back to the team for a deleted or missing reviewer', () => {
    expect(decisionReviewer('rejected', { ...ada, deletedAt: new Date() })).toEqual({
      account: null,
    });
    expect(decisionReviewer('approved', null)).toEqual({ account: null });
  });

  it('is null for a request nobody decided', () => {
    expect(decisionReviewer('pending', ada)).toBeNull();
    expect(decisionReviewer('withdrawn', ada)).toBeNull();
  });
});

describe('decisionReviewerByline (which byline the history row renders)', () => {
  it('names a reviewer with an account, avatar included', () => {
    expect(
      decisionReviewerByline({
        account: { username: 'reviewer_ada', image: 'https://i.example/a' },
      })
    ).toEqual({ kind: 'named', username: 'reviewer_ada', image: 'https://i.example/a' });
  });

  it('reads as the team for a gone account or a blank name', () => {
    expect(decisionReviewerByline({ account: null })).toEqual({ kind: 'team' });
    expect(decisionReviewerByline({ account: { username: '  ', image: null } })).toEqual({
      kind: 'team',
    });
  });

  it('renders nothing for an undecided entry or a projection without a reviewer', () => {
    expect(decisionReviewerByline(null)).toBeNull();
    expect(decisionReviewerByline(undefined)).toBeNull();
  });
});
