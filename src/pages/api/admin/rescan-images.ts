import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import { ingestImageById } from '~/server/services/image.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { commaDelimitedNumberArray } from '~/utils/zod-helpers';

const schema = z.object({
  imageIds: commaDelimitedNumberArray(),
});

export default WebhookEndpoint(async (req, res) => {
  const { imageIds } = schema.parse(req.query);

  const results = await Promise.allSettled(imageIds.map((id) => ingestImageById({ id })));

  const submitted: number[] = [];
  const notFound: number[] = [];
  const failed: { id: number; reason: string }[] = [];
  results.forEach((result, i) => {
    const id = imageIds[i];
    if (result.status === 'fulfilled') {
      // false: ingestImage already stamped the rejection on the image row.
      if (result.value) submitted.push(id);
      else failed.push({ id, reason: 'submit-rejected' });
    } else if (result.reason instanceof TRPCError && result.reason.code === 'NOT_FOUND') {
      notFound.push(id);
    } else {
      const message =
        result.reason instanceof Error ? result.reason.message : String(result.reason);
      failed.push({ id, reason: message.slice(0, 200) });
    }
  });

  res.status(200).json({ imageIds, submitted, notFound, failed });
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
