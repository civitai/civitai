import { fail } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { dismissRecap, getDailyStatus, getRecap } from '$lib/server/daily/daily.service';
import { imageUrl } from '$lib/server/image-url';
import { openItem, sealItem } from '$lib/server/feed-token';
import {
  answerHiddenCheck,
  pickHiddenCheck,
  dismissHiddenNotices,
  readHiddenNotices,
} from '$lib/server/hidden/hidden.service';
import { hiddenSettings } from '$lib/server/hidden/runtime';
import { requireMember } from '$lib/server/membership';
import { rankTable } from '$lib/server/progression/rating';
import { ratingGuide } from '$lib/server/rules';
import { dismissGuide, dismissProgress, readNotices, type ProgressNotice } from '$lib/server/seen';
import { seenStore } from '$lib/server/seen-runtime';
import { skipStore } from '$lib/server/skip-runtime';
import { recordSkip, skippedFor } from '$lib/server/skips';
import { conversionEnabled } from '$lib/server/conversion/runtime';
import { castVote, getFeed, type RejectReason } from '$lib/server/queue/queue.service';
import { voteLockUntil } from '$lib/server/queue/vote-rate';
import { queueDeps } from '$lib/server/queue/runtime';
import { feedSecret } from '$lib/server/smites/runtime';
import { dismissResetNotice, hasUnseenReset } from '$lib/server/smites/smites.service';
import { pickYesNo } from '$lib/server/yesno/feed';
import { YESNO_ANSWERS } from '$lib/server/yesno/keys';
import { yesNoConfig } from '$lib/server/yesno/runtime';
import { castYesNoVote } from '$lib/server/yesno/vote';
import { apprenticeDeps } from '$lib/server/apprenticeship/runtime';
import { crossedMilestone } from '$lib/server/apprenticeship/standing';
import {
  acknowledgeCheckpoint,
  answerApprentice,
  getApprentice,
} from '$lib/server/apprenticeship/apprenticeship.service';
import { apprenticePayload } from './apprentice';
import type { Actions, PageServerLoad } from './$types';

const REJECTION_TEXT: Record<RejectReason, string> = {
  'no-player': 'You have not joined the Order yet.',
  'not-eligible': 'You cannot judge this one yet.',
  'bad-answer': 'That answer is not on offer.',
  'already-voted': 'You have already judged this one.',
  'not-open': 'This one has already been settled.',
  unavailable: 'This one is not open for judging.',
  'no-weight': 'Your standing is too low for your judgment to count yet.',
  'reset-pending': 'Your career is being reset. Return in a moment.',
};

const APPRENTICE_REJECTION_TEXT = {
  'no-player': 'You have not joined the Order yet.',
  'not-acolyte': 'Your apprenticeship is over.',
  'checkpoint-pending': 'Take a look at your recap first.',
  'not-current': 'That is not the image before you now.',
  'bad-answer': 'That answer is not on offer.',
} as const;

type RankPerks = { levels?: string; voteWeight?: number; goldMultiplier?: number };
type Notice = ProgressNotice & RankPerks & { milestone?: string };

// A rank-up notice says what the rank brings; a level-up carries nothing more.
function withRankPerks(progress: ProgressNotice | null): Notice | null {
  if (progress?.kind !== 'rank') return progress;
  const perks = rankTable().find((entry) => entry.rank === progress.rank);
  return perks
    ? {
        ...progress,
        levels: perks.levels,
        voteWeight: perks.voteWeight,
        goldMultiplier: perks.goldMultiplier,
      }
    : progress;
}

// An Acolyte levels up every few answers, so only the milestone levels are celebrated; every other level is recorded as seen.
async function acolyteMilestone(
  progress: Notice | null,
  status: { rank: string; level: number },
  userId: number
): Promise<Notice | null> {
  if (progress?.kind !== 'level') return progress;
  const milestone = crossedMilestone(progress.from, progress.level);
  if (milestone) return { ...progress, milestone: milestone.copy };
  await dismissProgress(seenStore, userId, status);
  return null;
}

export const load: PageServerLoad = async ({ locals, depends }) => {
  depends('app:play');
  const status = await requireMember(db, locals.user.id);
  const now = queueDeps.now();
  // Shown on whichever page the player lands on: a reset player lands back in the apprenticeship.
  const [resetNotice, notices, seen] = await Promise.all([
    hasUnseenReset(db, locals.user.id, now),
    readHiddenNotices(db, locals.user.id),
    readNotices(seenStore, locals.user.id, status),
  ]);
  const common = {
    status,
    resetNotice,
    notices,
    showGuide: seen.guide,
    progress: withRankPerks(seen.progress),
    ratingGuide: ratingGuide(),
  };

  if (status.rank === 'Acolyte') {
    const view = await getApprentice(db, locals.user.id);
    if (view.kind !== 'not-acolyte') {
      return {
        conversionOpen: conversionEnabled(),
        mode: 'apprentice' as const,
        ...common,
        progress: await acolyteMilestone(common.progress, status, locals.user.id),
        apprentice: apprenticePayload(view),
      };
    }
  }

  const lockedUntil =
    queueDeps.voteLimits && !locals.user.isModerator
      ? await voteLockUntil(db, locals.user.id, now, queueDeps.voteLimits)
      : null;
  const skipped = lockedUntil ? null : await skippedFor(skipStore, locals.user.id);
  const [feed, daily, recap] = await Promise.all([
    lockedUntil ? null : getFeed(db, locals.user.id, { limit: 1, exclude: skipped?.queue }),
    getDailyStatus(db, { playerId: locals.user.id, rank: status.rank, now }),
    getRecap(db, { playerId: locals.user.id, now }),
  ]);
  const resetPending = status.smites >= status.maxSmites;
  const conversionOpen = conversionEnabled();
  const lockoutSeconds = lockedUntil
    ? Math.max(1, Math.ceil((lockedUntil.getTime() - now.getTime()) / 1000))
    : null;
  const page = {
    mode: 'queue' as const,
    banner: null as { heading: string } | null,
    ...common,
    daily,
    recap,
    resetPending,
    conversionOpen,
    lockoutSeconds,
  };
  if (resetPending || lockedUntil) return { ...page, question: null, item: null };

  // A hidden check comes first, so its rate holds whatever the yes/no share is; it only ever rides on a rating question.
  if (feed) {
    const secret = feedSecret();
    const hidden = await pickHiddenCheck(db, {
      userId: locals.user.id,
      rank: status.rank,
      secret,
      questionKey: feed.question.key,
      rate: hiddenSettings().rate,
      exclude: skipped?.hidden,
    });
    if (hidden) {
      return {
        ...page,
        question: hidden.question,
        item: {
          id: sealItem(secret, locals.user.id, { kind: 'hidden', id: hidden.referenceId }),
          src: imageUrl(hidden.imageKey),
          width: hidden.width,
          height: hidden.height,
        },
      };
    }
  }

  // A yes/no question is rolled for next; with no rating to show, one is shown whenever there is one. A share of 0 switches them off.
  const yesNo = yesNoConfig();
  const offer =
    yesNo.share <= 0
      ? null
      : await pickYesNo(db, {
          userId: locals.user.id,
          rank: status.rank,
          secret: feedSecret(),
          share: yesNo.share,
          stretch: yesNo.stretch,
          force: !feed,
          exclude: skipped?.yesno,
        });
  if (offer) {
    return {
      ...page,
      banner: offer.banner,
      question: {
        key: 'yesno',
        kind: 'bool',
        prompt: offer.prompt,
        options: YESNO_ANSWERS.map((answer) => ({ ...answer })),
      },
      item: {
        id: sealItem(feedSecret(), locals.user.id, { kind: 'yesno', id: offer.itemId }),
        src: imageUrl(offer.imageKey),
        width: offer.width,
        height: offer.height,
      },
    };
  }
  if (!feed) return { ...page, question: null, item: null };

  const secret = feedSecret();
  const [item] = feed.items;
  return {
    ...page,
    question: feed.question,
    item: {
      id: sealItem(secret, locals.user.id, { kind: 'queue', id: item.id }),
      src: imageUrl(item.imageKey),
      width: item.width,
      height: item.height,
    },
  };
};

export const actions: Actions = {
  vote: async ({ request, locals }) => {
    const form = await request.formData();
    const token = form.get('item');
    const answer = form.get('answer');
    if (typeof token !== 'string' || typeof answer !== 'string') {
      return fail(400, { message: 'Pick an answer.' });
    }
    let ref: ReturnType<typeof openItem>;
    try {
      ref = openItem(feedSecret(), locals.user.id, token);
    } catch (error) {
      console.error('knights: the feed cannot be served', { error });
      return fail(500, { message: 'Your judgment could not be recorded. Try again in a moment.' });
    }
    if (!ref) return fail(400, { message: 'Pick an answer.' });
    const itemId = ref.id;

    try {
      const result =
        ref.kind === 'hidden'
          ? await answerHiddenCheck(
              db,
              {
                userId: locals.user.id,
                referenceId: itemId,
                answer,
                isModerator: locals.user.isModerator,
              },
              queueDeps
            )
          : ref.kind === 'yesno'
          ? await castYesNoVote(
              db,
              { userId: locals.user.id, itemId, answer, isModerator: locals.user.isModerator },
              queueDeps
            )
          : await castVote(
              db,
              { userId: locals.user.id, itemId, answer, isModerator: locals.user.isModerator },
              queueDeps
            );
      if (result.status === 'limited') {
        return fail(429, {
          message: 'You are judging too quickly. Rest a little.',
          lockoutSeconds: Math.max(
            1,
            Math.ceil((result.until.getTime() - queueDeps.now().getTime()) / 1000)
          ),
        });
      }
      if (result.status === 'rejected') {
        return fail(409, { message: REJECTION_TEXT[result.reason] });
      }
      return { success: true };
    } catch (error) {
      console.error('knights: vote failed', { itemId, error });
      return fail(500, { message: 'Your judgment could not be recorded. Try again in a moment.' });
    }
  },

  // Moves a player past an item without judging it: no vote, pay, accuracy or Watch credit, and it is not served to them
  // again. Every kind of item is handled and answered alike, so a skip does not show what the item was.
  skip: async ({ request, locals }) => {
    const token = (await request.formData()).get('item');
    let ref: ReturnType<typeof openItem> = null;
    try {
      if (typeof token === 'string') ref = openItem(feedSecret(), locals.user.id, token);
    } catch (error) {
      console.error('knights: the feed cannot be served', { error });
    }
    if (!ref) return fail(400, { message: 'That one cannot be skipped.' });
    await recordSkip(skipStore, locals.user.id, ref, queueDeps.now());
    return { success: true };
  },

  dismissRecap: async ({ locals }) => {
    try {
      await dismissRecap(db, { playerId: locals.user.id, now: queueDeps.now() });
    } catch (error) {
      console.error('knights: could not store the recap dismissal', { error });
      return fail(500, { message: 'Could not dismiss the recap. Try again.', recapFailed: true });
    }
  },

  dismissNotices: async ({ locals }) => {
    try {
      await dismissHiddenNotices(db, locals.user.id, queueDeps.now());
    } catch (error) {
      console.error('knights: could not store the notice dismissal', { error });
      return fail(500, { message: 'Could not dismiss the notice. Try again.', noticeFailed: true });
    }
  },

  dismissResetNotice: async ({ locals }) => {
    try {
      await dismissResetNotice(db, locals.user.id, queueDeps.now());
    } catch (error) {
      console.error('knights: could not store the reset notice dismissal', { error });
      return fail(500, {
        message: 'Could not dismiss the notice. Try again.',
        resetNoticeFailed: true,
      });
    }
  },

  dismissGuide: async ({ locals }) => {
    const status = await requireMember(db, locals.user.id);
    if (!(await dismissGuide(seenStore, locals.user.id, status))) {
      return fail(500, { message: 'Could not dismiss the guide. Try again.', guideFailed: true });
    }
  },

  dismissProgress: async ({ locals }) => {
    const status = await requireMember(db, locals.user.id);
    if (!(await dismissProgress(seenStore, locals.user.id, status))) {
      return fail(500, {
        message: 'Could not dismiss the notice. Try again.',
        progressFailed: true,
      });
    }
  },

  apprentice: async ({ request, locals }) => {
    const form = await request.formData();
    const kind = form.get('kind');
    const referenceId = Number(form.get('referenceId'));
    const answer = form.get('answer');
    if (
      (kind !== 'rating' && kind !== 'yesno') ||
      !Number.isInteger(referenceId) ||
      typeof answer !== 'string'
    ) {
      return fail(400, { message: 'Pick an answer.' });
    }

    try {
      const result = await answerApprentice(
        db,
        { userId: locals.user.id, kind, referenceId, answer },
        apprenticeDeps
      );
      if (result.status === 'rejected') {
        return fail(409, { message: APPRENTICE_REJECTION_TEXT[result.reason] });
      }
      // Only whether the pick was right: the page plays a sound and shows no verdict.
      return { success: true, correct: result.correct, promoted: result.promoted };
    } catch (error) {
      console.error('knights: apprenticeship answer failed', { referenceId, error });
      return fail(500, { message: 'Your answer could not be recorded. Try again in a moment.' });
    }
  },

  continueCheckpoint: async ({ locals }) => {
    try {
      await acknowledgeCheckpoint(db, locals.user.id, apprenticeDeps.now());
    } catch (error) {
      console.error('knights: could not move past the checkpoint', { error });
      return fail(500, { message: 'Could not continue. Try again.' });
    }
    return { success: true };
  },
};
