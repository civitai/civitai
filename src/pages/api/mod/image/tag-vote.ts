import * as z from 'zod';
import { addTagVotes, removeTagVotes } from '~/server/services/tag.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';
import { imageId } from '~/server/schema/moderator/image';

const tagId = z.coerce.number().int().positive();

export default defineModeratorEndpoint('image.tagVote', {
  summary: 'Vote tags up or down on images, with moderator weight.',
  returns: '{ applied }',
  notes: [
    'Moderator weight is applied by the underlying tag services, so callers pass a plain ±1 and the number that decides whether a tag is disabled stays in one place.',
    'A vote of 0 removes this moderator’s vote for that tag.',
  ],
  rateLimit: { max: 30, windowSeconds: 60 },
  input: z.object({
    votes: z
      .array(
        z.object({
          imageId,
          tagId,
          vote: z.coerce.number().int().min(-1).max(1).describe('1 up, -1 down, 0 to remove.'),
        })
      )
      .min(1)
      .max(500)
      .refine(
        (votes) => new Set(votes.map((v) => `${v.imageId}:${v.tagId}`)).size === votes.length,
        { message: 'Duplicate (imageId, tagId) pairs not allowed' }
      )
      .describe('The votes to record.'),
  }),
  async handler(input, ctx) {
    // Grouped by (imageId, vote) so each group is one service call with an array of tag ids.
    const removals = new Map<number, number[]>();
    const additions = new Map<string, { imageId: number; vote: number; tagIds: number[] }>();
    for (const v of input.votes) {
      if (v.vote === 0) {
        const arr = removals.get(v.imageId) ?? [];
        arr.push(v.tagId);
        removals.set(v.imageId, arr);
      } else {
        const key = `${v.imageId}:${v.vote}`;
        const cur = additions.get(key) ?? { imageId: v.imageId, vote: v.vote, tagIds: [] };
        cur.tagIds.push(v.tagId);
        additions.set(key, cur);
      }
    }

    await Promise.all([
      ...Array.from(removals.entries()).map(([id, tagIds]) =>
        removeTagVotes({ userId: ctx.actor.id, type: 'image', id, tags: tagIds })
      ),
      ...Array.from(additions.values()).map((group) =>
        addTagVotes({
          userId: ctx.actor.id,
          type: 'image',
          id: group.imageId,
          tags: group.tagIds,
          vote: group.vote,
          isModerator: true,
        })
      ),
    ]);

    return {
      applied: input.votes.length,
      affected: { imageIds: Array.from(new Set(input.votes.map((v) => v.imageId))) },
    };
  },
});
