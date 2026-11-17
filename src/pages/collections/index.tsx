import { MY_COLLECTIONS_LIST_INPUT } from '~/components/Collections/collection-review-counts';
import { CollectionsHome } from '~/components/Collections/CollectionsHome';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  useSession: true,
  resolver: async ({ ssg, session = null, features }) => {
    if (ssg) {
      if (session) {
        await ssg.collection.getAllUser.prefetch(MY_COLLECTIONS_LIST_INPUT);
      }
      // TODO - prefetch top user collections and popular collections
    }

    if (!features?.collections) return { notFound: true };
  },
});

export default CollectionsHome;
