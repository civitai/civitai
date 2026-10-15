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
    'The original file, whatever its status or scan result: this is for dispute review.',
    'The URL is an attachment download and stops working after about five minutes. Do not store it; ask again.',
  ],
  input: z.object({
    fileId: z.coerce.number().int().positive().describe('The delivery file id.'),
  }),
  async handler({ fileId }, { actor }) {
    const target = await resolveServiceDealFileDownload({
      fileId,
      userId: actor.id,
      isModerator: true,
    });
    if (!target) throw throwNotFoundError('File not found');
    const url = await getServiceDealFileDownloadUrl(target);
    return {
      url,
      expiresAt: new Date(Date.now() + SERVICE_FILE_DOWNLOAD_EXPIRY_SECONDS * 1000).toISOString(),
    };
  },
});
