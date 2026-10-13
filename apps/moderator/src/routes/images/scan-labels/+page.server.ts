import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { parseForm, parseQuery } from '$lib/server/query';
import { blockImage, isModerationBlocked } from '$lib/server/image-moderation.service';
import { getActorMeta } from '$lib/server/request-meta';
import {
  applyMajorityBlocks,
  castVote,
  claimNext,
  getCounters,
  getOpenFlaggerVersions,
} from '$lib/server/scan-label.service';
import { scanLabelFiltersSchema, toFilters } from '$lib/scan-labels';

export const load: PageServerLoad = async ({ url, locals }) => {
  const query = parseQuery(url, scanLabelFiltersSchema);
  const filters = toFilters(query);
  const userId = locals.user.id;
  const card = await claimNext(userId, filters);
  const [counters, versions] = await Promise.all([
    getCounters(userId, filters),
    getOpenFlaggerVersions(),
  ]);
  return { card, counters, versions, day: query.day ?? '', version: query.version ?? '' };
};

const voteSchema = z.object({
  itemId: z.coerce.number().int().positive().max(2_147_483_647),
  block: z.enum(['1', '0'], { message: 'Choose Block or Don’t block.' }),
  ms: z.coerce.number().int().min(0).max(2_147_483_647).nullable().catch(null),
});

const REFUSAL: Record<'not-open' | 'already-voted' | 'full', string> = {
  'not-open': 'Someone else finished this one. Here is the next.',
  full: 'Your hold on this one ran out and the others took its slots. Here is the next.',
  'already-voted': 'You already voted on this one. Here is the next.',
};

export const actions: Actions = {
  vote: async (event) => {
    const { request, locals } = event;
    const input = parseForm(voteSchema, await request.formData());
    if (typeof input === 'string') return fail(400, { error: input });
    const result = await castVote({
      itemId: input.itemId,
      userId: locals.user.id,
      block: input.block === '1',
      msOnItem: input.ms,
    });
    if (!result.ok) return fail(409, { error: REFUSAL[result.reason] });
    // Retry pending majority blocks so a failed one is not stranded. Must not fail the vote, which
    // has already landed.
    await applyMajorityBlocks(
      { requester: locals.user.id, ...getActorMeta(event) },
      { block: blockImage, isModerationBlocked }
    ).catch((e) => console.error('scan label block sweep failed', e));
    return { voted: true };
  },
};
