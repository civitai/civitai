import * as z from 'zod/v4';
import { ingestImageById } from '~/server/services/image.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { commaDelimitedNumberArray } from '~/utils/zod-helpers';

const schema = z.object({
  imageIds: commaDelimitedNumberArray(),
});

export default WebhookEndpoint(async (req, res) => {
  const { imageIds } = schema.parse(req.query);

  await Promise.all(imageIds.map((imageId) => ingestImageById({ id: imageId })));

  res.status(200).json({ imageIds });
});

// const images = await dbRead.$queryRaw<
// { id: number }[]
// >`select id from "Image" where "createdAt" > now()::date - interval '4 hours' and "ingestion" = 'Pending'`;

// await Limiter().process(images, async (images) => {
// console.log(`processing ${images.length} images`);
// await dbWrite.image.updateMany({
//   where: { id: { in: images.map((x) => x.id) } },
//   data: {
//     ingestion: ImageIngestionStatus.Pending,
//     scannedAt: null,
//     needsReview: null,
//     minor: false,
//     poi: false,
//     blockedFor: null,
//   },
// });
// });
