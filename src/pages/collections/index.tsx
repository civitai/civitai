import { CollectionsLanding } from '~/components/Collections/CollectionsLanding';
import { CollectionsLayout } from '~/components/Collections/CollectionsLayout';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { CollectionContributorPermission } from '@prisma/client';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useEffect } from 'react';
import { Center, Loader } from '@mantine/core';
import { trpc } from '~/utils/trpc';
import { useRouter } from 'next/router';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  useSession: true,
  resolver: async ({ ssg, session = null, features }) => {
    if (ssg) {
      if (session) {
        await ssg.collection.getAllUser.prefetch({
          permission: CollectionContributorPermission.VIEW,
        });
      }
      // TODO - prefetch top user collections and popular collections
    }

    if (!features?.collections) return { notFound: true };
  },
});

const CollectionsHome = () => {
  const currentUser = useCurrentUser();
  const { data: collections = [], isLoading } = trpc.collection.getAllUser.useQuery(
    { permission: CollectionContributorPermission.VIEW },
    { enabled: !!currentUser }
  );
  const router = useRouter();
  const ownedCollection = collections.find((c) => c.isOwner);

  useEffect(() => {
    if (!isLoading && ownedCollection) {
      router.push(`/collections/${ownedCollection.id}`);
    }
  }, [ownedCollection, isLoading]);

  return (
    <CollectionsLayout>
      {isLoading || ownedCollection ? (
        <Center mt="lg">
          <Loader />
        </Center>
      ) : (
        <CollectionsLanding />
      )}
    </CollectionsLayout>
  );
};

export default CollectionsHome;
