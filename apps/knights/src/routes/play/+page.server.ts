import { fail } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { dismissRecap, getDailyStatus, getRecap } from '$lib/server/daily/daily.service';
import { imageUrl } from '$lib/server/image-url';
import { requireMember } from '$lib/server/membership';
import { conversionEnabled } from '$lib/server/conversion/runtime';
import { castVote, getFeed, type RejectReason } from '$lib/server/queue/queue.service';
import { voteLockUntil } from '$lib/server/queue/vote-rate';
import { queueDeps } from '$lib/server/queue/runtime';
import { trialDeps } from '$lib/server/trials/runtime';
import { answerTrial, getTrial } from '$lib/server/trials/trials.service';
import type { Actions, PageServerLoad } from './$types';

const REJECTION_TEXT: Record<RejectReason, string> = {
  'no-player': 'You have not joined the Order yet.',
  'not-eligible': 'You cannot judge this one yet.',
  'bad-answer': 'That answer is not on offer.',
  'already-voted': 'You have already judged this one.',
  'not-open': 'This one has already been settled.',
  unavailable: 'This one is not open for judging.',
  'no-weight': 'Your standing is too low for your judgment to count yet.',
};

const TRIAL_REJECTION_TEXT = {
  'no-player': 'You have not joined the Order yet.',
  'no-run': 'You have no trial under way.',
  'not-current': 'That is not the image before you now.',
  'bad-answer': 'That answer is not on offer.',
} as const;

export const load: PageServerLoad = async ({ locals, depends }) => {
  depends('app:play');
  const status = await requireMember(db, locals.user.id);

  if (status.rank === 'Acolyte') {
    const trial = await getTrial(db, locals.user.id, trialDeps);
    if (trial.kind !== 'not-acolyte') {
      return {
        conversionOpen: conversionEnabled(),
        mode: 'trials' as const,
        status,
        trial:
          trial.kind === 'question'
            ? {
                kind: 'question' as const,
                questionKey: trial.questionKey,
                prompt: trial.prompt,
                options: trial.options,
                run: trial.run,
                item: {
                  referenceId: trial.item.referenceId,
                  src: imageUrl(trial.item.imageKey),
                  width: trial.item.width,
                  height: trial.item.height,
                },
              }
            : trial.kind === 'cooldown'
            ? { kind: 'cooldown' as const, until: trial.until.toISOString() }
            : { kind: 'unavailable' as const },
      };
    }
  }

  const now = queueDeps.now();
  const lockedUntil =
    queueDeps.voteLimits && !locals.user.isModerator
      ? await voteLockUntil(db, locals.user.id, now, queueDeps.voteLimits)
      : null;
  const [feed, daily, recap] = await Promise.all([
    lockedUntil ? null : getFeed(db, locals.user.id, { limit: 1 }),
    getDailyStatus(db, { playerId: locals.user.id, rank: status.rank, now }),
    getRecap(db, { playerId: locals.user.id, now }),
  ]);
  const conversionOpen = conversionEnabled();
  const lockoutSeconds = lockedUntil
    ? Math.max(1, Math.ceil((lockedUntil.getTime() - now.getTime()) / 1000))
    : null;
  if (!feed) {
    return {
      conversionOpen,
      mode: 'queue' as const,
      status,
      daily,
      recap,
      question: null,
      item: null,
      lockoutSeconds,
    };
  }

  const [item] = feed.items;
  return {
    conversionOpen,
    mode: 'queue' as const,
    status,
    daily,
    recap,
    lockoutSeconds,
    question: feed.question,
    item: {
      id: item.id,
      src: imageUrl(item.imageKey),
      width: item.width,
      height: item.height,
    },
  };
};

export const actions: Actions = {
  vote: async ({ request, locals }) => {
    const form = await request.formData();
    const itemId = Number(form.get('itemId'));
    const answer = form.get('answer');
    if (!Number.isInteger(itemId) || typeof answer !== 'string') {
      return fail(400, { message: 'Pick an answer.' });
    }

    try {
      const result = await castVote(
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

  dismissRecap: async ({ locals }) => {
    try {
      await dismissRecap(db, { playerId: locals.user.id, now: queueDeps.now() });
    } catch (error) {
      console.error('knights: could not store the recap dismissal', { error });
      return fail(500, { message: 'Could not dismiss the recap. Try again.', recapFailed: true });
    }
  },

  trial: async ({ request, locals }) => {
    const form = await request.formData();
    const referenceId = Number(form.get('referenceId'));
    const questionKey = form.get('questionKey');
    const answer = form.get('answer');
    if (
      !Number.isInteger(referenceId) ||
      typeof questionKey !== 'string' ||
      typeof answer !== 'string'
    ) {
      return fail(400, { message: 'Pick an answer.' });
    }

    try {
      const result = await answerTrial(
        db,
        { userId: locals.user.id, questionKey, referenceId, answer },
        trialDeps
      );
      if (result.status === 'rejected') {
        return fail(409, { message: TRIAL_REJECTION_TEXT[result.reason] });
      }
      return {
        success: true,
        reveal: {
          correct: result.correct,
          correctLabel: result.correctLabel,
          explanation: result.explanation,
          src: imageUrl(result.imageKey),
          finished: result.finished,
        },
      };
    } catch (error) {
      console.error('knights: trial answer failed', { referenceId, error });
      return fail(500, { message: 'Your answer could not be recorded. Try again in a moment.' });
    }
  },
};
