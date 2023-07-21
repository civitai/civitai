import { CollectionsLanding } from '~/components/Collections/CollectionsLanding';
import { CollectionsLayout } from '~/components/Collections/CollectionsLayout';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { CollectionContributorPermission } from '@prisma/client';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  useSession: true,
  resolver: async ({ ssg, session = null, features }) => {
    if (ssg) {
      if (session) {
        ssg.collection.getAllUser.prefetch({ permission: CollectionContributorPermission.VIEW });
      }
      // TODO - prefetch top user collections and popular collections
    }

    if (!features?.collections) return { notFound: true };
  },
});

const CollectionsHome = () => {
  return (
    <CollectionsLayout>
      <CollectionsLanding />
    </CollectionsLayout>
  );
};

export default CollectionsHome;
