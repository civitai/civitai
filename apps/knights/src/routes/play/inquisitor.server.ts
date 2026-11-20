import { error, fail, type RequestEvent } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { openReviewToken, sealReview } from '$lib/server/feed-token';
import { imageUrl } from '$lib/server/image-url';
import { moderatorStats, reviewSidebar } from '$lib/server/inquisitor/context';
import { setImageLevelAsModerator } from '$lib/server/inquisitor/main-app';
import { OverrideWriteError } from '$lib/server/inquisitor/override-error';
import {
  castReviewVote,
  nextReview,
  sendToInquisitor,
  type ReviewVoteRejection,
} from '$lib/server/inquisitor/review.service';
import { queueDeps } from '$lib/server/queue/runtime';
import { skillChecks } from '$lib/server/skill-check/runtime';
import { feedSecret } from '$lib/server/smites/runtime';

/** The rating levels a moderator answers with; Blocked is the separate "Send to Inquisitor". */
const LEVELS = [
  { value: '1', label: 'PG' },
  { value: '2', label: 'PG-13' },
  { value: '4', label: 'R' },
  { value: '8', label: 'X' },
  { value: '16', label: 'XXX' },
];

const HELD_TEXT = 'This image came under review or a hold; your vote was not recorded.';

const REJECTION_TEXT: Record<ReviewVoteRejection | 'not-found', string> = {
  'not-found': 'This review is gone. Here is the next one.',
  'not-open': 'This review was closed by another moderator. Here is the next one.',
  'bad-answer': 'Pick one of the levels.',
  'own-image': 'You cannot review your own image.',
  'already-voted': 'You already voted on this one.',
  held: HELD_TEXT,
  unavailable: 'This image cannot be checked right now. Try again shortly.',
  claimed: 'Another moderator is closing this one right now. Here is the next one.',
  'override-unavailable': 'The level cannot be written right now. Try again.',
  'override-failed': 'Civitai did not take the new level. Your vote was not recorded; try again.',
  'override-uncertain':
    'Civitai may have taken the new level; check the image before voting again.',
};

/** What a vote that went through tells the moderator, when it needs saying. */
const RESULT_TEXT: Partial<Record<string, string>> = {
  excluded: HELD_TEXT,
  'written-not-closed':
    'The new level was written to the image, but this review could not be closed and no skill check was added.',
};

async function assertModerator(locals: App.Locals) {
  if (locals.user?.isModerator !== true) error(403, 'Moderators only.');
  if (!(await skillChecks()).enabled) error(404, 'The inquisitor queue is switched off.');
}

/** What `/play` shows a moderator: the next review with its sidebar, and their stats. */
export async function inquisitorView(moderatorId: number) {
  const now = queueDeps.now();
  const [review, stats] = await Promise.all([
    nextReview(db, { moderatorId, now }),
    moderatorStats(db, { moderatorId, now }),
  ]);
  return {
    mode: 'inquisitor' as const,
    stats,
    levels: LEVELS,
    review: review && {
      token: sealReview(feedSecret(), moderatorId, review.reviewId),
      src: imageUrl(review.imageKey),
      width: review.width,
      height: review.height,
      votes: review.votes,
      sidebar: await reviewSidebar(db, review),
    },
  };
}

function reviewIdFrom(form: FormData, moderatorId: number) {
  const token = form.get('token');
  return typeof token === 'string' ? openReviewToken(feedSecret(), moderatorId, token) : null;
}

export const inquisitorActions = {
  inquisitorVote: async ({ request, locals }: RequestEvent) => {
    await assertModerator(locals);
    const form = await request.formData();
    const reviewId = reviewIdFrom(form, locals.user.id);
    const answer = form.get('answer');
    if (reviewId === null || typeof answer !== 'string') {
      return fail(400, { message: 'This page is out of date. Reload it to keep reviewing.' });
    }
    const cookie = request.headers.get('cookie');
    const result = await castReviewVote(
      db,
      { reviewId, moderatorId: locals.user.id, answer },
      {
        now: queueDeps.now,
        poolCap: (await skillChecks()).poolCap,
        setImageLevel: async (imageId, level) => {
          const written = await setImageLevelAsModerator({ cookie, imageId, level });
          if (!written.ok) {
            throw new OverrideWriteError('no moderator session to write the level with', false);
          }
        },
      }
    );
    if (result.status === 'rejected') {
      return fail(409, { message: REJECTION_TEXT[result.reason] });
    }
    const message = RESULT_TEXT[result.status];
    return message ? { reviewed: result.status, message } : { reviewed: result.status };
  },

  sendToInquisitor: async ({ request, locals }: RequestEvent) => {
    await assertModerator(locals);
    const reviewId = reviewIdFrom(await request.formData(), locals.user.id);
    if (reviewId === null) {
      return fail(400, { message: 'This page is out of date. Reload it to keep reviewing.' });
    }
    const result = await sendToInquisitor(
      db,
      { reviewId, moderatorId: locals.user.id },
      { now: queueDeps.now }
    );
    if (result.status === 'rejected') return fail(409, { message: REJECTION_TEXT[result.reason] });
    return { reviewed: 'sent' as const };
  },
};
