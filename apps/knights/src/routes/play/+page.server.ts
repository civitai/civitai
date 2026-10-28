import { fail } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { imageUrl } from '$lib/server/image-url';
import { getPlayerStatus } from '$lib/server/player-status';
import { castVote, getFeed, type RejectReason } from '$lib/server/queue/queue.service';
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
  'no-run': 'You have no trial under way.',
  'not-current': 'That is not the image before you now.',
  'bad-answer': 'That answer is not on offer.',
} as const;

export const load: PageServerLoad = async ({ locals }) => {
  const status = await getPlayerStatus(db, locals.user.id);

  if (status?.rank === 'Acolyte') {
    const trial = await getTrial(db, locals.user.id, trialDeps);
    if (trial.kind !== 'not-acolyte') {
      return {
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

  const feed = await getFeed(db, locals.user.id, { limit: 1 });
  if (!feed) return { mode: 'queue' as const, status, question: null, item: null };

  const [item] = feed.items;
  return {
    mode: 'queue' as const,
    status,
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
      const result = await castVote(db, { userId: locals.user.id, itemId, answer }, queueDeps);
      if (result.status === 'rejected') {
        return fail(409, { message: REJECTION_TEXT[result.reason] });
      }
      return { success: true };
    } catch (error) {
      console.error('knights: vote failed', { itemId, error });
      return fail(500, { message: 'Your judgment could not be recorded. Try again in a moment.' });
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
          yourAnswer: answer,
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
