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
 * and on the developer's own submission history. Pure — the one DB read (the detail fetcher)
 * gets a fake client through its context argument.
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
    expect(appReviewAttributionDetails({ kind: 'moderator', userId: 7 })).toEqual({
      reviewerUserId: 7,
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
  const ctx = (users: { id: number; username: string }[]) => {
    const findMany = vi.fn(async (_args: unknown) => users);
    return {
      findMany,
      ctx: { db: { user: { findMany } }, showSfwFace: true } as unknown as DetailFetcherContext,
    };
  };

  it('resolves the stored reviewer into the actor, excluding deleted accounts', async () => {
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
  });

  it('makes no query for notifications without a reviewer', async () => {
    const { findMany, ctx: c } = ctx([]);
    await appReviewDetailFetcher.fetcher([{ id: 1, type: 'app-block-rejected', details: BASE }], c);
    expect(findMany).not.toHaveBeenCalled();
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
