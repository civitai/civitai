import { MY_COLLECTIONS_LIST_INPUT } from '~/components/Collections/collection-review-counts';
import { CollectionsLanding } from '~/components/Collections/CollectionsLanding';
import { CollectionsLayout } from '~/components/Collections/CollectionsLayout';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { Center, Loader } from '@mantine/core';
import { trpc } from '~/utils/trpc';
import { Meta } from '~/components/Meta/Meta';

export const CollectionsHome = () => {
  const currentUser = useCurrentUser();
  const { data: collections = [], isLoading } = trpc.collection.getAllUser.useQuery(
    MY_COLLECTIONS_LIST_INPUT,
    { enabled: !!currentUser }
  );
  const ownedCollection = collections.find((c) => c.isOwner);

  return (
    <CollectionsLayout autoOpenDrawer={!!ownedCollection}>
      <Meta title="Collections" description="Browse all collections" canonical="/collections" />

      {isLoading ? (
        <Center mt="lg">
          <Loader />
        </Center>
      ) : (
        <CollectionsLanding signedIn={!!currentUser} hasCollections={collections.length > 0} />
      )}
    </CollectionsLayout>
  );
};
