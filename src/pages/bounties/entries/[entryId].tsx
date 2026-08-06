import { dbRead } from '~/server/db/client';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { forwardQuery } from '~/utils/forward-query';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  useSession: true,
  resolver: async ({ ctx }) => {
    const { entryId } = ctx.params as { entryId: string };
    const bountyEntry = await dbRead.bountyEntry.findUnique({
      where: { id: Number(entryId) },
      select: { bountyId: true },
    });

    if (!bountyEntry) {
      return { notFound: true };
    }

    // threadUrlMap builds `/bounties/entries/{id}?highlight=…` for every bountyEntry comment
    // notification, and a destination without the query silently drops it — so the comment the
    // notification is about never gets highlighted.
    return {
      redirect: {
        destination: `/bounties/${bountyEntry.bountyId}/entries/${entryId}${forwardQuery(
          ctx.query,
          ['entryId']
        )}`,
        permanent: false,
      },
    };
  },
});

export default function EntriesPage() {
  return <PageLoader text="Redirecting to bounty entry..." />;
}
