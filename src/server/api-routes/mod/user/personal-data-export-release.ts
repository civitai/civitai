import * as z from 'zod';
import { releaseForModerator } from '~/server/services/personal-data-export/release-endpoint';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

export default defineModeratorEndpoint('user.personalDataExportRelease', {
  summary: 'Send a built personal-data export to the account owner.',
  returns: '{ exportId, released, linkExpiresAt }',
  notes: [
    'Requires the moderator app permission `user.personalDataExport.release`.',
    "Checks the account's holds again and reads its registered email at the moment of sending; refused when any hold applies or when it cannot be read.",
    'Sends only the archive. The internal notes file is never sent from here.',
  ],
  rateLimit: { max: 20, windowSeconds: 60 },
  input: z.object({ exportId: z.coerce.number().int().positive().max(2147483647) }),
  handler: (input, ctx) => releaseForModerator(ctx.actor, input.exportId),
});
