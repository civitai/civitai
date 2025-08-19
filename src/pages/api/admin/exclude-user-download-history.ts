import * as z from 'zod';
import { excludeUserDownloadHistory } from '~/server/services/download.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { commaDelimitedNumberArray } from '~/utils/zod-helpers';

const schema = z.object({
  userIds: commaDelimitedNumberArray(),
});

export default WebhookEndpoint(async (req, res) => {
  const { userIds } = schema.parse(req.query);

  await excludeUserDownloadHistory(userIds);

  res.status(200).json({ userIds });
});
