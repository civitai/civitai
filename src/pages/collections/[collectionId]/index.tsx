import { CollectionContributorPermission } from '~/shared/utils/prisma/enums';
import { Collection } from '~/components/Collections/Collection';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { CollectionsLayout } from '~/components/Collections/CollectionsLayout';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  useSession: true,
  resolver: async ({ ssg, session = null, features, ctx }) => {
    const raw = String(ctx.query.collectionId);
    const match = raw.match(/^(\d+)/);
    if (!match) return { notFound: true };

    const collectionId = Number(match[1]);
    if (!collectionId || collectionId < 1) return { notFound: true };

    // Redirect malformed URLs (e.g. "10195=") to the clean canonical path
    if (match[1] !== raw) {
      return {
        redirect: { destination: `/collections/${collectionId}`, permanent: true },
      };
    }

    if (!features?.collections) return { notFound: true };

    if (ssg) {
      await Promise.all([
        ssg.collection.getById.prefetch({ id: collectionId }),
        ...(session
          ? [
              ssg.collection.getAllUser.prefetch({
                permission: CollectionContributorPermission.VIEW,
              }),
              ssg.hiddenPreferences.getHidden.prefetch(),
            ]
          : []),
      ]);
    }

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
      {collectionId && <Collection collectionId={collectionId} />}
    </CollectionsLayout>
  );
}
