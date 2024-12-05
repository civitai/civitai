import { CollectionContributorPermission } from '~/shared/utils/prisma/enums';
import { Collection } from '~/components/Collections/Collection';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { CollectionsLayout } from '~/components/Collections/CollectionsLayout';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  useSession: true,
  resolver: async ({ ssg, session = null, features, ctx }) => {
    if (ssg) {
      if (session) {
        await ssg.collection.getAllUser.prefetch({
          permission: CollectionContributorPermission.VIEW,
        });
        await ssg.hiddenPreferences.getHidden.prefetch();
      }
      // TODO - prefetch top user collections and popular collections
    }

    if (!features?.collections) return { notFound: true };

    return {
      props: {
        collectionId: Number(ctx.query.collectionId),
      },
    };
  },
});

export default function Collections({ collectionId }: { collectionId: number }) {
  return (
    <CollectionsLayout>
      {collectionId && <Collection collectionId={collectionId} fluid />}
    </CollectionsLayout>
  );
}
