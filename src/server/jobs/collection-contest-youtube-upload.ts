import { CollectionMode, CollectionType } from '@prisma/client';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { env } from '~/env/server';
import { dbRead, dbWrite } from '~/server/db/client';
import { createJob, getJobDate } from '~/server/jobs/job';
import { logToAxiom } from '~/server/logging/client';
import type { VideoMetadata } from '~/server/schema/media.schema';

const logWebhook = (data: MixedObject) => {
  logToAxiom(
    {
      name: 'collection-contest-youtube-upload-cron',
      type: 'error',
      ...data,
    },
    'webhooks'
  ).catch();
};

const ATTEMPT_LIMIT = 3;

export const contestCollectionYoutubeUpload = createJob(
  'collection-contest-youtube-upload',
  '0 * * * *',
  async () => {
    if (!env.YOUTUBE_VIDEO_UPLOAD_URL) {
      logWebhook({ error: 'Youtube video upload URL not set' });
      return;
    }

    const [lastRun, setLastRun] = await getJobDate('collection-contest-youtube-upload');

    const contestColletionsWithYoutube = await dbRead.collection.findMany({
      where: {
        mode: CollectionMode.Contest,
        type: CollectionType.Image,
        metadata: {
          path: ['youtubeSupportEnabled'],
          equals: true,
        },
      },
    });

    for (const collection of contestColletionsWithYoutube) {
      try {
        console.log(`Processing collection ${collection.id}`);
        const collectionKey = `collection:${collection.id}:youtube-authentication-code`;
        const authKey = await dbRead.keyValue.findFirst({
          where: {
            key: collectionKey,
          },
        });

        if (!authKey || !authKey?.value) {
          console.log(`No auth key found for collection ${collection.id}`);
          continue;
        }

        const collectionItems = await dbRead.$queryRaw<
          {
            imageId: number;
            imageUrl: string;
            metadata: VideoMetadata;
          }[]
        >`
          SELECT
            i.id as "imageId",
            i.url as "imageUrl",
            i."mimeType",
            i.metadata
          FROM "CollectionItem" ci
          JOIN "Image" i ON i.id = ci."imageId"
          WHERE ci."collectionId" = ${collection.id}
            AND ci."status" = 'ACCEPTED'
            AND i.type = 'video'
            AND i."ingestion" = 'Scanned'
            -- We only want to upload videos that are longer than 30 seconds
            AND (i.metadata->'duration')::int > 30
            AND (i.metadata->'youtubeVideoId') IS NULL
            AND ci."updatedAt" > ${lastRun}
          -- Ensures that we try to upload smaller videos first as a safeguard.
          ORDER BY i.metadata->'size' ASC
        `;

        for (const item of collectionItems) {
          try {
            if (item.metadata.youtubeVideoId) {
              console.log(`Video already uploaded ${item.imageId}`);
              continue;
            }

            if ((item.metadata.youtubeUploadAttempt ?? 0) > ATTEMPT_LIMIT) {
              console.log(`Video upload attempts exceeded ${item.imageId}`);
              continue;
            }

            if (!!item.metadata.youtubeUploadEnqueuedAt) {
              continue;
            }

            const callbackUrl = `${env.NEXT_PUBLIC_BASE_URL}/api/webhooks/youtube-upload?token=${env.WEBHOOK_TOKEN}`;

            const res = await fetch(env.YOUTUBE_VIDEO_UPLOAD_URL, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                imageId: item.imageId,
                sourceUrl: getEdgeUrl(item.imageUrl, {
                  original: true,
                }),
                callbackUrl,
                youtubeRefreshToken: authKey.value,
              }),
            });

            if (!res.ok) {
              throw new Error(`Failed to upload video ${item.imageId}`);
            }

            await dbWrite.image.update({
              where: { id: item.imageId },
              data: {
                metadata: {
                  ...item.metadata,
                  youtubeUploadEnqueuedAt: new Date().toISOString(),
                },
              },
            });
          } catch (error) {
            console.error(`Error uploading video ${item.imageId}: ${(error as Error).message}`);
            logWebhook({ error, imageId: item.imageId });

            await dbWrite.image.update({
              where: { id: item.imageId },
              data: {
                metadata: {
                  ...item.metadata,
                  youtubeUploadAttempt: (item.metadata.youtubeUploadAttempt ?? 0) + 1,
                },
              },
            });

            await dbWrite.collectionItem.updateMany({
              where: {
                imageId: item.imageId,
                collectionId: collection.id,
              },
              data: {
                updatedAt: new Date(),
              },
            });
          }
        }
      } catch (error) {
        console.error(`Error processing collection ${collection.id}: ${(error as Error).message}`);
        logWebhook({ error });
      }
    }

    // await setLastRun();
  }
);
