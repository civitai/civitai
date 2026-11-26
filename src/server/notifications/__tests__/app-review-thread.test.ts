import { describe, expect, it, vi } from 'vitest';
import { setEnv } from '~/__tests__/mocks/env.mock';
import type { DetailFetcherContext } from '~/server/notifications/detail-fetchers/base.detail-fetcher';

setEnv({ NEXTAUTH_URL: 'https://civitai.com' });

const { getNotificationMessage } = await import('~/server/notifications/utils.notifications');
const { emailNotificationTypes } = await import('@civitai/notifications/constants');
const { appReviewReplyDetailFetcher } = await import(
  '~/server/notifications/detail-fetchers/app-review-reply.detail-fetcher'
);
const { postReviewMessageSchema } = await import('~/server/schema/blocks/app-review-thread.schema');
const {
  canSubmitReviewReply,
  developerSideRecipients,
  isDecidedReviewStatus,
  normalizeReviewMessageBody,
  parseReviewSubjectId,
  reviewReplyExcerpt,
  reviewThreadDeveloperUrl,
  reviewThreadModeratorUrl,
  reviewThreadViewerRole,
  routeReply,
} = await import('~/shared/utils/app-review-thread');

/**
 * The reply thread on an app review decision: the rules that need no database. Pure; the one DB
 * read (the detail fetcher) gets a fake client through its context argument.
 */

describe('parseReviewSubjectId', () => {
  it('reads a version request and a listing request', () => {
    expect(parseReviewSubjectId('pubreq_01HZX4ABCD')).toEqual({
      kind: 'version',
      id: 'pubreq_01HZX4ABCD',
    });
    expect(parseReviewSubjectId('alpr_01HZX4ABCD')).toEqual({
      kind: 'listing',
      id: 'alpr_01HZX4ABCD',
    });
  });

  it('refuses anything that is not a request id', () => {
    for (const junk of [
      '',
      'pubreq_',
      'alpr_',
      'apl_01HZX4ABCD',
      'PUBREQ_01HZX4ABCD',
      'pubreq_01 HZX',
      'pubreq_01/../x',
      ' pubreq_01HZX4ABCD',
      42,
      null,
      undefined,
      ['pubreq_01HZX4ABCD'],
    ]) {
      expect(parseReviewSubjectId(junk), String(junk)).toBeNull();
    }
  });
});

describe('message bounds', () => {
  it('trims, then requires 1 to 2000 characters', () => {
    expect(normalizeReviewMessageBody('  Fixed it.  ')).toEqual({ ok: true, body: 'Fixed it.' });
    expect(normalizeReviewMessageBody('   \n  ')).toEqual({ ok: false, reason: 'empty' });
    expect(normalizeReviewMessageBody('x'.repeat(2000))).toEqual({
      ok: true,
      body: 'x'.repeat(2000),
    });
    expect(normalizeReviewMessageBody('x'.repeat(2001))).toEqual({
      ok: false,
      reason: 'too-long',
    });
    // Whitespace around a body at the limit does not count against it.
    expect(normalizeReviewMessageBody(`  ${'x'.repeat(2000)}  `)).toEqual({
      ok: true,
      body: 'x'.repeat(2000),
    });
  });

  it('the input schema applies the same bounds after trimming', () => {
    const parse = (body: string) =>
      postReviewMessageSchema.safeParse({ subjectId: 'pubreq_01', body });
    expect(parse('   ').success).toBe(false);
    expect(parse('x'.repeat(2001)).success).toBe(false);
    const ok = parse('  Thanks  ');
    expect(ok.success && ok.data.body).toBe('Thanks');
  });

  it('the reply box submits only something postable, and never twice', () => {
    expect(canSubmitReviewReply('Thanks', false)).toBe(true);
    expect(canSubmitReviewReply('Thanks', true)).toBe(false);
    expect(canSubmitReviewReply('   ', false)).toBe(false);
    expect(canSubmitReviewReply('x'.repeat(2001), false)).toBe(false);
  });
});

describe('routeReply', () => {
  const live = { id: 31, deletedAt: null, bannedAt: null, isModerator: true };

  it('a developer reply goes to the live moderator who decided', () => {
    expect(routeReply({ authorRole: 'developer', reviewer: live })).toEqual({
      to: 'reviewer',
      userId: 31,
    });
    // The id is the reviewer's own, not a constant.
    expect(routeReply({ authorRole: 'developer', reviewer: { ...live, id: 4077 } })).toEqual({
      to: 'reviewer',
      userId: 4077,
    });
  });

  it('goes to the queue when no individual can take it', () => {
    const queue = { to: 'queue' };
    // Automated or undecided: no reviewer recorded.
    expect(routeReply({ authorRole: 'developer', reviewer: null })).toEqual(queue);
    expect(
      routeReply({ authorRole: 'developer', reviewer: { ...live, deletedAt: new Date() } })
    ).toEqual(queue);
    expect(
      routeReply({ authorRole: 'developer', reviewer: { ...live, bannedAt: '2027-01-01' } })
    ).toEqual(queue);
    expect(
      routeReply({ authorRole: 'developer', reviewer: { ...live, isModerator: false } })
    ).toEqual(queue);
    expect(
      routeReply({ authorRole: 'developer', reviewer: { ...live, isModerator: null } })
    ).toEqual(queue);
  });

  it('a moderator reply goes to the developer side, whoever reviewed', () => {
    expect(routeReply({ authorRole: 'moderator', reviewer: live })).toEqual({ to: 'developer' });
    expect(routeReply({ authorRole: 'moderator', reviewer: null })).toEqual({ to: 'developer' });
  });
});

describe('reviewThreadViewerRole', () => {
  const base = { submittedByUserId: 7, listingOwnerUserId: 9 };

  it('the submitter and the listing owner are the developer side', () => {
    expect(reviewThreadViewerRole({ ...base, viewerUserId: 7, viewerIsModerator: false })).toBe(
      'developer'
    );
    expect(reviewThreadViewerRole({ ...base, viewerUserId: 9, viewerIsModerator: false })).toBe(
      'developer'
    );
  });

  it('a moderator who is not a party writes as a moderator', () => {
    expect(reviewThreadViewerRole({ ...base, viewerUserId: 31, viewerIsModerator: true })).toBe(
      'moderator'
    );
  });

  it('a moderator on their own submission writes as its developer', () => {
    expect(reviewThreadViewerRole({ ...base, viewerUserId: 7, viewerIsModerator: true })).toBe(
      'developer'
    );
  });

  it('anyone else is not a participant', () => {
    expect(reviewThreadViewerRole({ ...base, viewerUserId: 55, viewerIsModerator: false })).toBe(
      null
    );
    expect(
      reviewThreadViewerRole({
        submittedByUserId: 7,
        listingOwnerUserId: null,
        viewerUserId: 9,
        viewerIsModerator: false,
      })
    ).toBe(null);
  });
});

describe('developerSideRecipients', () => {
  it('the submitter and the listing owner, once each', () => {
    expect(developerSideRecipients(7, 9)).toEqual([7, 9]);
    expect(developerSideRecipients(7, 7)).toEqual([7]);
    expect(developerSideRecipients(7, null)).toEqual([7]);
    expect(developerSideRecipients(7, undefined)).toEqual([7]);
  });
});

describe('reviewReplyExcerpt', () => {
  it('is the message on one line', () => {
    expect(reviewReplyExcerpt('  Fixed the\n\nspend   prompt.  ')).toBe('Fixed the spend prompt.');
    expect(reviewReplyExcerpt(null)).toBe('');
  });

  it('keeps a 200-character message whole', () => {
    const exact = 'y'.repeat(200);
    expect(reviewReplyExcerpt(exact)).toBe(exact);
  });

  it('cuts a longer one to 200 characters, ending in an ellipsis', () => {
    const long = 'word '.repeat(60);
    const excerpt = reviewReplyExcerpt(long);
    expect(excerpt).toBe(`${'word '.repeat(39)}word…`);
    expect(excerpt).toHaveLength(200);
  });

  it('drops a trailing space at the cut', () => {
    expect(reviewReplyExcerpt(`${'x'.repeat(198)} ${'y'.repeat(50)}`)).toBe(`${'x'.repeat(198)}…`);
  });
});

describe('thread links', () => {
  it('the developer page, and where a moderator reads each kind', () => {
    expect(reviewThreadDeveloperUrl('pubreq_01HZX4ABCD')).toBe(
      '/apps/submissions/pubreq_01HZX4ABCD'
    );
    expect(reviewThreadModeratorUrl('pubreq_01HZX4ABCD')).toBe(
      '/apps/review/pubreq_01HZX4ABCD?tab=conversation'
    );
    // A listing request has no review page: the queue's Replies tab opens it.
    expect(reviewThreadModeratorUrl('alpr_01HZX4ABCD')).toBe(
      '/apps/review?tab=replies&thread=alpr_01HZX4ABCD'
    );
  });

  it('the conversation is offered on decided submissions only', () => {
    expect(isDecidedReviewStatus('approved')).toBe(true);
    expect(isDecidedReviewStatus('rejected')).toBe(true);
    for (const status of ['pending', 'withdrawn', '', null, undefined]) {
      expect(isDecidedReviewStatus(status)).toBe(false);
    }
  });
});

describe('the reply notifications', () => {
  const toModerator = {
    subjectId: 'pubreq_01HZX4ABCD',
    slug: 'pixel-pal',
    name: 'Pixel Pal',
    excerpt: 'Fixed the spend prompt.',
  };
  const toDeveloper = {
    subjectId: 'alpr_01HZX4WXYZ',
    slug: 'pixel-pal',
    name: 'Pixel Pal',
    excerpt: 'Please add a confirm step.',
    authorUserId: 31,
  };

  it('to the reviewer: the developer replied, linking the review conversation', () => {
    const prepared = getNotificationMessage({
      type: 'app-review-reply-to-moderator',
      details: toModerator,
    });
    expect(prepared?.message).toBe(
      'A developer replied about your review of "Pixel Pal": Fixed the spend prompt.'
    );
    expect(prepared?.url).toBe('/apps/review/pubreq_01HZX4ABCD?tab=conversation');
    expect(prepared?.emailButtonLabel).toBe('Open the conversation');
    expect(prepared?.byline).toBeUndefined();
    // No display name: the slug.
    expect(
      getNotificationMessage({
        type: 'app-review-reply-to-moderator',
        details: { ...toModerator, name: null },
      })?.message
    ).toBe('A developer replied about your review of "pixel-pal": Fixed the spend prompt.');
  });

  it('to the developer: Civitai App Review replied, from the named moderator', () => {
    const prepared = getNotificationMessage({
      type: 'app-review-reply-to-developer',
      details: { ...toDeveloper, actor: { username: 'reviewer_ada', deletedAt: null } },
    });
    expect(prepared?.message).toBe(
      'Civitai App Review replied about "Pixel Pal": Please add a confirm step.'
    );
    expect(prepared?.url).toBe('/apps/submissions/alpr_01HZX4WXYZ');
    expect(prepared?.byline).toBe('From @reviewer_ada, Civitai App Review');
  });

  it('names the team once the moderator account is gone or unresolved', () => {
    for (const actor of [{ username: 'reviewer_ada', deletedAt: '2027-01-01' }, undefined]) {
      expect(
        getNotificationMessage({
          type: 'app-review-reply-to-developer',
          details: { ...toDeveloper, actor },
        })?.byline
      ).toBe('From Civitai App Review');
    }
  });

  it('both send email, and the fan-out worker list says so', () => {
    expect(emailNotificationTypes).toEqual(
      expect.arrayContaining(['app-review-reply-to-moderator', 'app-review-reply-to-developer'])
    );
  });
});

describe('appReviewReplyDetailFetcher', () => {
  const ctx = (users: { id: number; username: string }[]) => {
    const findMany = vi.fn(async (_args: unknown) => users);
    return {
      findMany,
      ctx: { db: { user: { findMany } }, showSfwFace: true } as unknown as DetailFetcherContext,
    };
  };
  const BASE = { subjectId: 'alpr_01HZX4WXYZ', slug: 'pixel-pal', excerpt: 'Hi' };

  it('resolves the stored author into the actor, excluding deleted accounts', async () => {
    const { findMany, ctx: c } = ctx([{ id: 31, username: 'reviewer_ada' }]);
    const live = {
      id: 1,
      type: 'app-review-reply-to-developer',
      details: { ...BASE, authorUserId: 31 },
    };
    const gone = {
      id: 2,
      type: 'app-review-reply-to-developer',
      details: { ...BASE, authorUserId: 44 },
    };
    await appReviewReplyDetailFetcher.fetcher([live, gone], c);

    const where = (findMany.mock.calls[0]![0] as { where: unknown }).where;
    expect(where).toEqual({ id: { in: [31, 44] }, deletedAt: null });
    expect(live.details).toMatchObject({ actor: { username: 'reviewer_ada' } });
    expect(gone.details).not.toHaveProperty('actor');
    expect(getNotificationMessage(live)?.byline).toBe('From @reviewer_ada, Civitai App Review');
    expect(getNotificationMessage(gone)?.byline).toBe('From Civitai App Review');
  });

  it('serves only the to-developer type, and makes no query without an author', async () => {
    expect(appReviewReplyDetailFetcher.types).toEqual(['app-review-reply-to-developer']);
    const { findMany, ctx: c } = ctx([]);
    await appReviewReplyDetailFetcher.fetcher(
      [{ id: 1, type: 'app-review-reply-to-developer', details: BASE }],
      c
    );
    expect(findMany).not.toHaveBeenCalled();
  });
});
