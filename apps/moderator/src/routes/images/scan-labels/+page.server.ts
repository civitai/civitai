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
  isControlFlaggerVersion,
  getVotedItemOwner,
  type VoteChoice,
} from '$lib/server/scan-label.service';
import {
  BLOCK_REASON_IDS,
  REASON_COMMENT_MAX,
  REASON_NEEDING_COMMENT,
  scanLabelFiltersSchema,
  toFilters,
} from '$lib/scan-labels';

export const load: PageServerLoad = async ({ url, locals }) => {
  const parsed = parseQuery(url, scanLabelFiltersSchema);
  const query =
    parsed.version && (await isControlFlaggerVersion(parsed.version))
      ? { ...parsed, version: undefined }
      : parsed;
  const filters = toFilters(query);
  const userId = locals.user.id;
  const card = await claimNext(userId, filters);
  const [counters, versions] = await Promise.all([
    getCounters(userId, filters),
    getOpenFlaggerVersions(),
  ]);
  return { card, counters, versions, day: query.day ?? '', version: query.version ?? '' };
};

const voteSchema = z
  .object({
    itemId: z.coerce.number().int().positive().max(2_147_483_647),
    block: z.enum(['1', '0'], { message: 'Choose Block or Don’t block.' }),
    reason: z.enum(BLOCK_REASON_IDS).optional().catch(undefined),
    reasonComment: z
      .string()
      .trim()
      .max(REASON_COMMENT_MAX)
      .optional()
      .transform((v) => v || null),
    ms: z.coerce.number().int().min(0).max(2_147_483_647).nullable().catch(null),
  })
  .transform(({ block, reason, reasonComment, ...rest }, ctx) => {
    if (block === '0') return { ...rest, choice: { block: false } as VoteChoice };
    if (!reason) {
      ctx.addIssue({ code: 'custom', message: 'Pick a reason for the block.' });
      return z.NEVER;
    }
    if (reason === REASON_NEEDING_COMMENT && !reasonComment) {
      ctx.addIssue({ code: 'custom', message: 'Add a short comment for “Other ToS violation”.' });
      return z.NEVER;
    }
    const comment = reason === REASON_NEEDING_COMMENT ? reasonComment : null;
    return { ...rest, choice: { block: true, reason, reasonComment: comment } as VoteChoice };
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
      choice: input.choice,
      msOnItem: input.ms,
    });
    if (!result.ok) return fail(409, { error: REFUSAL[result.reason] });
    // Retry pending majority blocks so a failed one is not stranded. Must not fail the vote, which
    // has already landed.
    await applyMajorityBlocks(
      { requester: locals.user.id, ...getActorMeta(event) },
      {
        // A majority of voting moderators already agreed, which is the second opinion a re-removal
        // of an image approved on appeal is held for.
        block: async (args) => void (await blockImage({ ...args, skipAppealCheck: true })),
        isModerationBlocked,
      }
    ).catch((e) => console.error('scan label block sweep failed', e));
    const owner = await getVotedItemOwner(input.itemId, locals.user.id).catch((e) => {
      console.error('scan label owner read failed', e);
      return null;
    });
    return { voted: true, owner };
  },
};
