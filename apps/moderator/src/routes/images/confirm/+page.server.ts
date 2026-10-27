import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { parseForm } from '$lib/server/query';
import { answerConfirm, claimNext } from '$lib/server/knights-confirm/confirm.service';
import { pageCard } from '$lib/server/knights-confirm/card';

export const load: PageServerLoad = async ({ locals }) => {
  const card = await claimNext(locals.user.id);
  return { card: card && pageCard(card) };
};

const answerSchema = z.object({
  token: z.string().uuid(),
  level: z.coerce.number().int(),
});

const REFUSAL = {
  'not-yours': 'This card is not held by you. Here is the next.',
  expired: 'This item timed out. Here is the next.',
  'not-open': 'Someone else finished this one. Here is the next.',
  'own-rating': 'You set this rating yourself. Here is the next.',
  'invalid-level': 'Pick one of the rating levels.',
} as const;

export const actions: Actions = {
  answer: async ({ request, locals }) => {
    const input = parseForm(answerSchema, await request.formData());
    if (typeof input === 'string') return fail(400, { error: input });
    const result = await answerConfirm({ ...input, userId: locals.user.id });
    if (!result.ok) return fail(409, { error: REFUSAL[result.reason] });
    return { answered: true };
  },
};
