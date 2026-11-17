import * as z from 'zod';
import { RESOLUTION_NOTE_MAX_LENGTH } from '@civitai/shared/resolution-reasons';
import { clearBountyEntryFileCheck } from '~/server/services/bounty-entry-file-check.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

export default defineModeratorEndpoint('bountyEntryFile.clearCheck', {
  summary: "Clear a bounty entry file's check result so the entry can be awarded and downloaded.",
  returns: '{ fileId, entryId }',
  notes: [
    'Refuses a file that is not currently blocked, or that changed since it was read.',
    'Applies to the file as uploaded: a re-upload is checked again.',
  ],
  rateLimit: { max: 60, windowSeconds: 60 },
  input: z.object({
    fileId: z.coerce.number().int().positive().describe('The bounty entry file to clear.'),
    reason: z
      .string()
      .trim()
      .min(1, 'A reason is required.')
      .max(RESOLUTION_NOTE_MAX_LENGTH)
      .describe('Why the file is fine. Moderator-only.'),
  }),
  async handler(input, ctx) {
    const { fileId, entryId } = await clearBountyEntryFileCheck({
      fileId: input.fileId,
      userId: ctx.actor.id,
      reason: input.reason,
    });
    return { fileId, entryId, affected: { fileIds: [fileId], bountyEntryIds: [entryId] } };
  },
});
