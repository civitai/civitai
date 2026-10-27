import * as z from 'zod';
import {
  getServiceDealFileDownloadUrl,
  resolveServiceDealFileDownload,
} from '~/server/services/creator-service-deal-file.service';
import { throwNotFoundError } from '~/server/utils/errorHandling';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';
import { SERVICE_FILE_DOWNLOAD_EXPIRY_SECONDS } from '~/shared/constants/creator-services.constants';

export default defineModeratorEndpoint('creatorServices.dealFileUrl', {
  method: 'GET',
  summary: 'A short-lived signed download URL for one Creator Services delivery file.',
  returns: '{ url, expiresAt }',
  notes: [
    'The original file, whatever its status or scan result: this is for dispute review. With delivered=true, the file as the buyer receives it.',
    'The URL is an attachment download and stops working after about five minutes. Do not store it; ask again.',
    "Each call is recorded as a moderator fetch (kind ModeratorFetch, never Download), under the caller's own role on the deal.",
  ],
  input: z.object({
    fileId: z.coerce.number().int().positive().describe('The delivery file id.'),
    delivered: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => value === 'true')
      .describe('Ask for the file as the buyer receives it instead of the original.'),
  }),
  async handler({ fileId, delivered }, { actor }) {
    const target = await resolveServiceDealFileDownload({
      fileId,
      userId: actor.id,
      isModerator: true,
      delivered,
      moderatorFetch: true,
    });
    if (!target) throw throwNotFoundError('File not found');
    const url = await getServiceDealFileDownloadUrl(target);
    return {
      url,
      expiresAt: new Date(Date.now() + SERVICE_FILE_DOWNLOAD_EXPIRY_SECONDS * 1000).toISOString(),
    };
  },
});
