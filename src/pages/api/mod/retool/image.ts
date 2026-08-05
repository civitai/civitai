/**
 * Retool-callable mod endpoints for Image writes.
 * =============================================================================
 *
 * Auth: Bearer <user API key> (mod role required).
 *
 * POST /api/mod/retool/image
 * Body: { "action": "<action>", ...params }
 *
 * Actions:
 *   tagVote      - { votes: [{ imageId, tagId, vote }] }
 *                  vote = 1 (up), -1 (down), 0 (remove). Moderator weight applied
 *                  via existing addTagVotes / removeTagVotes services.
 *   setNsfwLevel - { items: [{ imageId, nsfwLevel }] }
 *                  Composite write per item: Image update (with nsfwLevelLocked=true)
 *                  + ModActivity insert ('setNsfwLevel'). Replaces the old single-row
 *                  /api/mod/set-image-nsfw-level endpoint with a bulk-friendly path.
 *                  Note: the deprecated `research_ratings` insert from the original
 *                  Retool query is intentionally dropped (Knights of New Order
 *                  replaced that data source).
 */
import * as z from 'zod';
import { NsfwLevel } from '~/server/common/enums';
import { updateImageNsfwLevel } from '~/server/services/image.service';
import { addTagVotes, removeTagVotes } from '~/server/services/tag.service';
import { defineRetoolEndpoint, retoolAction } from '~/server/utils/retool-endpoint';

const imageId = z.coerce.number().int().positive();
const tagId = z.coerce.number().int().positive();
// Restrict to valid NsfwLevel bitflag values rather than any non-negative int —
// passing e.g. `3` or `999` previously silently corrupted the row.
const validNsfwLevels = Object.values(NsfwLevel).filter(
  (v): v is number => typeof v === 'number'
);
const nsfwLevel = z.coerce
  .number()
  .int()
  .refine((v) => validNsfwLevels.includes(v), {
    message: `nsfwLevel must be one of [${validNsfwLevels.join(', ')}]`,
  });

export default defineRetoolEndpoint('image', {
  tagVote: retoolAction({
    input: z.object({
      votes: z
        .array(
          z.object({
            imageId,
            tagId,
            vote: z.coerce.number().int().min(-1).max(1),
          })
        )
        .min(1)
        .max(500)
        .refine(
          (votes) =>
            new Set(votes.map((v) => `${v.imageId}:${v.tagId}`)).size === votes.length,
          { message: 'Duplicate (imageId, tagId) pairs not allowed' }
        ),
    }),
    rateLimit: { max: 30, windowSeconds: 60 },
    async handler(input, ctx) {
      // Group by (imageId, vote) so we can pass tagId arrays in one call per group.
      const removals = new Map<number, number[]>();
      const additions = new Map<string, { imageId: number; vote: number; tagIds: number[] }>();
      for (const v of input.votes) {
        if (v.vote === 0) {
          const arr = removals.get(v.imageId) ?? [];
          arr.push(v.tagId);
          removals.set(v.imageId, arr);
        } else {
          const key = `${v.imageId}:${v.vote}`;
          const cur = additions.get(key) ?? {
            imageId: v.imageId,
            vote: v.vote,
            tagIds: [],
          };
          cur.tagIds.push(v.tagId);
          additions.set(key, cur);
        }
      }

      await Promise.all([
        ...Array.from(removals.entries()).map(([id, tagIds]) =>
          removeTagVotes({
            userId: ctx.actor.id,
            type: 'image',
            id,
            tags: tagIds,
          })
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
        affected: {
          imageIds: Array.from(new Set(input.votes.map((v) => v.imageId))),
        },
      };
    },
  }),
  setNsfwLevel: retoolAction({
    input: z.object({
      items: z
        .array(z.object({ imageId, nsfwLevel }))
        .min(1)
        .max(500),
    }),
    rateLimit: { max: 30, windowSeconds: 60 },
    async handler(input, ctx) {
      const imageIds: number[] = [];
      for (const item of input.items) {
        await updateImageNsfwLevel({
          id: item.imageId,
          nsfwLevel: item.nsfwLevel,
          userId: ctx.actor.id,
          isModerator: true,
        });
        imageIds.push(item.imageId);
      }
      return { count: imageIds.length, affected: { imageIds } };
    },
  }),
});
