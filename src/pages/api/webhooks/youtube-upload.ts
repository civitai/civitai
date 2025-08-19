import { env } from 'process';
import sanitize from 'sanitize-html';
import * as z from 'zod';
import { dbRead, dbWrite } from '~/server/db/client';
import type { VideoMetadata } from '~/server/schema/media.schema';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { getYoutubeAuthClient, updateYoutubeVideo } from '~/server/youtube/client';

enum Status {
  Success = 0,
  NotFound = 1, // image not found at url
  Unscannable = 2,
}

const schema = z.object({
  imageId: z.number(),
  youtubeId: z.string().optional(),
  status: z.enum(Status),
  youtubeRefreshToken: z.string(),
});

export default WebhookEndpoint(async function handler(req, res) {
  if (req.method !== 'POST')
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });

  const bodyResults = schema.safeParse(req.body);
  if (!bodyResults.success)
    return res.status(400).json({
      ok: false,
      error: bodyResults.error,
    });

  const data = bodyResults.data;

  try {
    if (data.youtubeId && data.imageId) {
      // We are good to update the image & video with the relevant info:
      const [image] = await dbRead.$queryRaw<
        {
          imageId: number;
          imageUrl: string;
          title: string;
          detail: string;
          mimeType: string;
          metadata: VideoMetadata;
          username: string;
          collectionId?: number;
        }[]
      >`
          SELECT
            i.id as "imageId",
            i.url as "imageUrl",
            p.title,
            p.detail,
            i."mimeType",
            i.metadata,
            u."username",
            c.id as "collectionId"
          FROM "Image" i ON i.id = ${data.imageId}
          JOIN "Post" p ON p.id = i."postId"
          JOIN "User" u ON u.id = p."userId"
          LEFT JOIN "Collection" c ON p."collectionId" = c.id
        `;
      if (!image) {
        return res.status(404).json({ ok: false, error: 'Image not found' });
      }

      const authClient = await getYoutubeAuthClient(data.youtubeRefreshToken as string);
      const userProfile = `${env.NEXT_PUBLIC_BASE_URL}/user/${image.username}`;

      await updateYoutubeVideo({
        videoId: data.youtubeId,
        title: image.title,
        description: `
          ${sanitize(image.detail, {
            allowedTags: [],
            allowedAttributes: {},
          })}

          Created by ${image.username}:
          ${userProfile}

          ${
            image.collectionId
              ? `
          Check out more entries at:
          ${env.NEXT_PUBLIC_BASE_URL}/collections/${image.collectionId}
            `
              : ''
          }
        `,
        client: authClient,
      });

      await dbWrite.image.update({
        where: { id: data.imageId },
        data: {
          metadata: {
            ...image.metadata,
            youtubeVideoId: data.youtubeId,
          },
        },
      });
    }
    return res.status(200).json({ ok: true });
  } catch (e: any) {
    return res.status(400).send({ error: e.message });
  }
});
