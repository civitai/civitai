import { CollectionMode, CollectionType } from '~/shared/utils/prisma/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import type { CollectionMetadataSchema } from '~/server/schema/collection.schema';
import type { EnableCollectionYoutubeSupportInput } from '~/server/schema/collection.schema';
import { getCollectionById } from '~/server/services/collection.service';
import { throwAuthorizationError, throwBadRequestError } from '~/server/utils/errorHandling';
import { getYoutubeRefreshToken } from '~/server/youtube/client';

// Split out of `collection.service` because it is the only thing in that file that needs the
// youtube client, which pulls `googleapis` into the graph of everything reaching
// collection.service. (An earlier note put that at ~2.6s to import; nobody has measured it.)
export const enableCollectionYoutubeSupport = async ({
  collectionId,
  userId,
  authenticationCode,
}: EnableCollectionYoutubeSupportInput & { userId: number }) => {
  const user = await dbRead.user.findUnique({ where: { id: userId } });
  if (!user?.isModerator) {
    throw throwAuthorizationError('You do not have permission to enable youtube support');
  }

  const collection = await getCollectionById({ input: { id: collectionId } });

  if (collection.mode !== CollectionMode.Contest) {
    throw throwBadRequestError('Only contest collections can have youtube support enabled');
  }

  if (collection.type !== CollectionType.Image) {
    throw throwBadRequestError('Only image collections can have youtube support enabled');
  }

  const metadata = collection.metadata as CollectionMetadataSchema;

  if (metadata.youtubeSupportEnabled) {
    throw throwBadRequestError('Youtube support is already enabled for this collection');
  }

  // Attempt to save the auth code on the key-value store.
  try {
    const { tokens } = await getYoutubeRefreshToken(
      authenticationCode,
      '/collections/youtube/auth'
    );
    const collectionKey = `collection:${collectionId}:youtube-authentication-code`;

    if (!tokens.refresh_token) {
      throw throwBadRequestError('Failed to get youtube refresh token');
    }
    await dbWrite.$transaction(async (tx) => {
      await tx.keyValue.upsert({
        where: {
          key: collectionKey,
        },
        update: {
          value: tokens.refresh_token as string,
        },
        create: {
          key: collectionKey,
          value: tokens.refresh_token as string,
        },
      });

      await tx.collection.update({
        where: {
          id: collection.id,
        },
        data: {
          metadata: {
            ...metadata,
            youtubeSupportEnabled: true,
          },
        },
      });
    });

    return { collectionId, youtubeSupportEnabled: true };
  } catch {
    throw throwBadRequestError('Failed to save youtube authentication code');
  }
};
