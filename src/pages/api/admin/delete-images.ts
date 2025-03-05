import { z } from 'zod';
import { deleteImageById } from '~/server/services/image.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { commaDelimitedNumberArray } from '~/utils/zod-helpers';

const schema = z.object({
  imageIds: commaDelimitedNumberArray(),
});

export default WebhookEndpoint(async (req, res) => {
  const { imageIds } = schema.parse(req.query);

  await Promise.all(imageIds.map((imageId) => deleteImageById({ id: imageId })));

  res.status(200).json({ imageIds });
});
