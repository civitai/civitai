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

    let gating: { contentNsfwLevel: number; nsfw?: boolean } | undefined;
    let suppressAds = false;

    if (ssg) {
      const [data] = await Promise.all([
        ssg.collection.getById.fetch({ id: collectionId }).catch(() => null),
        ...(session
          ? [
              ssg.collection.getAllUser.prefetch({
                permission: CollectionContributorPermission.VIEW,
              }),
              ssg.hiddenPreferences.getHidden.prefetch(),
            ]
          : []),
      ]);

      const collection = data?.collection;
      if (collection) {
        gating = {
          contentNsfwLevel: collection.metadata?.forcedBrowsingLevel || collection.nsfwLevel,
          nsfw: collection.nsfw ?? undefined,
        };
        // A non-public collection is contributor-only, so there is no audience to monetize.
        suppressAds = collection.read !== 'Public';
      }
    }

    return {
      props: {
        collectionId: Number(ctx.query.collectionId),
      },
      gating,
      suppressAds,
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
