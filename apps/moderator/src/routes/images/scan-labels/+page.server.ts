import { fail } from '@sveltejs/kit';
import { holdsCsamReview } from '$lib/server/held-media';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { parseForm, parseQuery } from '$lib/server/query';
import { blockImage, isModerationBlocked } from '$lib/server/image-moderation.service';
import { getActorMeta } from '$lib/server/request-meta';
import { callModEndpoint } from '$lib/server/user-actions.service';
import {
  applyCsamHolds,
  applyMajorityBlocks,
  castVote,
  itemWithheld,
  claimNext,
  getCounters,
  getOpenFlaggerVersions,
  isControlFlaggerVersion,
  itemForToken,
  getVotedItemOwner,
  skipCard,
  type VoteChoice,
} from '$lib/server/scan-label.service';
import {
  BLOCK_REASON_IDS,
  CSAM_HOLD_REASON,
  pageCard,
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
  const card = await claimNext({ userId, csamReview: holdsCsamReview(locals.user) }, filters);
  const [counters, versions] = await Promise.all([
    getCounters(userId, filters),
    getOpenFlaggerVersions(),
  ]);
  return {
    card: card && pageCard(card),
    counters,
    versions,
    day: query.day ?? '',
    version: query.version ?? '',
  };
};

const voteSchema = z
  .object({
    token: z.string().uuid(),
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

const REFUSAL: Record<'not-open' | 'already-voted' | 'full' | 'released' | 'not-yours', string> = {
  'not-open': 'Someone else finished this one. Here is the next.',
  'not-yours': 'This card is not held by you. Here is the next.',
  full: 'Your hold on this one ran out and the others took its slots. Here is the next.',
  'already-voted': 'You already voted on this one. Here is the next.',
  released: 'This card left your queue. Here is the next.',
};

// A moderator must not take a refused hold as having landed.
const HOLD_REFUSED =
  'Your CSAM hold was not recorded: this card was already decided or left your queue. Tell a lead if the image still needs CSAM review. Here is the next.';

const HOLD_FAILED =
  'Your vote is recorded and the image has left the queue, but holding it for CSAM review failed. It is retried on the next vote; tell a lead if this keeps happening.';

const STALE_PAGE = 'This page is out of date. Reload it to keep voting.';

const skipSchema = z.object({ token: z.string().uuid() });

export const actions: Actions = {
  skip: async ({ request, locals }) => {
    const input = parseForm(skipSchema, await request.formData());
    if (typeof input === 'string') return fail(400, { error: STALE_PAGE });
    if (!(await skipCard(input.token, locals.user.id)))
      return fail(409, { error: REFUSAL['not-yours'] });
    return { skipped: true };
  },
  vote: async (event) => {
    const { request, locals } = event;
    const form = await request.formData();
    // A page rendered before the claim token shipped posts an item id: say how to recover.
    if (!form.has('token')) return fail(400, { error: STALE_PAGE });
    const input = parseForm(voteSchema, form);
    if (typeof input === 'string') return fail(400, { error: input });
    // A refused hold says so, whatever refused it; only a hold that already landed is not "refused".
    const hold = input.choice.block && input.choice.reason === CSAM_HOLD_REASON;
    const refuse = (reason: keyof typeof REFUSAL) =>
      fail(409, { error: hold && reason !== 'already-voted' ? HOLD_REFUSED : REFUSAL[reason] });
    const itemId = await itemForToken(input.token, locals.user.id);
    if (itemId === null) return refuse('not-yours');
    if (await itemWithheld(itemId, holdsCsamReview(locals.user))) return refuse('not-open');
    const result = await castVote({
      itemId,
      userId: locals.user.id,
      choice: input.choice,
      msOnItem: input.ms,
      claimToken: input.token,
    });
    if (!result.ok) return refuse(result.reason);
    // Holds first, and retried here like the blocks below. Must not fail the vote, which has landed.
    const holds = await applyCsamHolds(
      {},
      {
        hold: async (imageId, voterId) => {
          const held = await callModEndpoint(
            'image/report-csam',
            { imageIds: [imageId], ...(voterId && { scanLabelVoterId: voterId }) },
            'Hold for CSAM review'
          );
          if (!held.ok) throw new Error(held.error);
        },
      }
    ).catch((e) => {
      console.error('scan label csam hold sweep failed', e);
      return null;
    });
    // Failed, not "not held here": a concurrent vote's sweep may be the one that held it.
    const holdFailed =
      input.choice.block &&
      input.choice.reason === CSAM_HOLD_REASON &&
      (!holds || holds.failed.some((f) => f.itemId === itemId));
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
    const owner = await getVotedItemOwner(itemId, locals.user.id).catch((e) => {
      console.error('scan label owner read failed', e);
      return null;
    });
    return holdFailed ? { voted: true, owner, error: HOLD_FAILED } : { voted: true, owner };
  },
};
