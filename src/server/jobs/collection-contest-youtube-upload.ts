import { CollectionMode, CollectionType } from '@prisma/client';
import { createJob, getJobDate } from './job';
import { dbRead, dbWrite } from '~/server/db/client';
import { getYoutubeAuthClient, uploadYoutubeVideo } from '~/server/youtube/client';
import { VideoMetadata } from '~/server/schema/media.schema';
import { logToAxiom } from '~/server/logging/client';

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
            title: string;
            detail: string;
            mimeType: string;
            metadata: VideoMetadata;
          }[]
        >`
          SELECT i.id as "imageId", i.url as "imageUrl", p.title, p.detail, i."mimeType", i.metadata
          FROM "CollectionItem" ci
          JOIN "Image" i ON i.id = ci."imageId"
          JOIN "Post" p ON p.id = i."postId"
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

        const authClient = await getYoutubeAuthClient(authKey.value as string);

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

            const uploadedVideo = await uploadYoutubeVideo({
              url: item.imageUrl,
              title: item.title,
              description: item.detail,
              mimeType: item.mimeType,
              client: authClient,
            });

            await dbWrite.image.update({
              where: { id: item.imageId },
              data: {
                metadata: {
                  ...item.metadata,
                  youtubeVideoId: uploadedVideo?.id,
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
          }
        }
      } catch (error) {
        console.error(`Error processing collection ${collection.id}: ${(error as Error).message}`);
        logWebhook({ error });
      }
    }

    await setLastRun();
  }
);
