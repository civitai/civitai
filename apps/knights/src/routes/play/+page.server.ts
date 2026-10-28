import { fail } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { imageUrl } from '$lib/server/image-url';
import { castVote, getFeed, type RejectReason } from '$lib/server/queue/queue.service';
import { queueDeps } from '$lib/server/queue/runtime';
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

export const load: PageServerLoad = async ({ locals }) => {
  const feed = await getFeed(db, locals.user.id);
  if (!feed) return { question: null, item: null, remaining: 0 };

  const [item] = feed.items;
  return {
    question: feed.question,
    item: { id: item.id, src: imageUrl(item.imageKey) },
    remaining: feed.items.length,
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
      return { voted: itemId };
    } catch (error) {
      console.error('knights: vote failed', { itemId, error });
      return fail(500, { message: 'Your judgment could not be recorded. Try again in a moment.' });
    }
  },
};
