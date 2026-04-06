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

    if (ssg) {
      await ssg.collection.getById.prefetch({ id: collectionId });
      if (session) {
        await ssg.collection.getAllUser.prefetch({
          permission: CollectionContributorPermission.VIEW,
        });
        await ssg.hiddenPreferences.getHidden.prefetch();
      }
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
      {collectionId && <Collection collectionId={collectionId} />}
    </CollectionsLayout>
  );
}
