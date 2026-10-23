import * as z from 'zod';
import { RESOLUTION_NOTE_MAX_LENGTH } from '@civitai/shared/resolution-reasons';
import { reblockBountyEntryFileCheck } from '~/server/services/bounty-entry-file-check.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

export default defineModeratorEndpoint('bountyEntryFile.reblockCheck', {
  summary: "Undo a moderator's clear of a bounty entry file, restoring the check result it lifted.",
  returns: '{ fileId, entryId }',
  notes: [
    'Refuses a file with no clear, or whose clear changed since it was read.',
    'Leaves any award already made; it only withholds the file again.',
  ],
  rateLimit: { max: 60, windowSeconds: 60 },
  input: z.object({
    fileId: z.coerce.number().int().positive().describe('The bounty entry file to re-block.'),
    reason: z
      .string()
      .trim()
      .min(1, 'A reason is required.')
      .max(RESOLUTION_NOTE_MAX_LENGTH)
      .describe('Why the clear is undone. Moderator-only.'),
  }),
  async handler(input, ctx) {
    const { fileId, entryId } = await reblockBountyEntryFileCheck({
      fileId: input.fileId,
      userId: ctx.actor.id,
      reason: input.reason,
    });
    return { fileId, entryId, affected: { fileIds: [fileId], bountyEntryIds: [entryId] } };
  },
});
