import { google } from 'googleapis';
import { CollectionMode } from '@prisma/client';
import { createJob } from './job';
import { dbRead, dbWrite } from '~/server/db/client';
import { getYoutubeAuthClient, getYoutubeVideos } from '~/server/youtube/client';

export const contestCollectionYoutubeUpload = createJob(
  'collection-contest-youtube-upload',
  '0 * * * *',
  async () => {
    const contestColletionsWithYoutube = await dbRead.collection.findMany({
      where: {
        mode: CollectionMode.Contest,
        metadata: {
          path: ['youtubeSupportEnabled'],
          equals: true,
        },
      },
    });

    console.log(contestColletionsWithYoutube);

    for (const collection of contestColletionsWithYoutube) {
      console.log(`Processing collection ${collection.id}`);
      const collectionKey = `collection:${collection.id}:youtube-authentication-code`;
      const authKey = await dbRead.keyValue.findFirst({
        where: {
          key: collectionKey,
        },
      });

      console.log(authKey);

      if (!authKey || !authKey?.value) {
        console.log(`No auth key found for collection ${collection.id}`);
        continue;
      }

      const authClient = await getYoutubeAuthClient(authKey.value as string);
      // console.log(authClient);
      const res = await getYoutubeVideos(authClient);
    }
  }
);
