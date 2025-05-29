import { Center, Container, Loader } from '@mantine/core';
import { useCollectionsForPostCreation } from '~/components/Collections/collection.utils';
import { MediaUploadSettingsProvider } from '~/components/MediaUploadSettings/MediaUploadSettingsProvider';
import type { CollectionMetadataSchema } from '~/server/schema/collection.schema';

export const CollectionUploadSettingsWrapper = ({
  collectionIds,
  children,
}: {
  collectionIds: number[];
  children: React.ReactNode;
}) => {
  const { collections = [], isLoading: isLoadingCollections } = useCollectionsForPostCreation({
    collectionIds,
  });

  const targetCollection = collections.length === 1 ? collections[0] : undefined;

  if (isLoadingCollections && collectionIds.length > 0) {
    // If we're targetting a specific collection, we'll be loading the settings to upload to it.
    return (
      <Container size="xs">
        <Center>
          <Loader />
        </Center>
      </Container>
    );
  }

  const targetCollectionMetadata = (targetCollection?.metadata ?? {}) as CollectionMetadataSchema;
  const mediaUploadSettings = targetCollectionMetadata?.uploadSettings ?? undefined;

  return (
    <MediaUploadSettingsProvider settings={mediaUploadSettings}>
      {children}
    </MediaUploadSettingsProvider>
  );
};
