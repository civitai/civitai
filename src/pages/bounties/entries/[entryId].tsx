import { dbRead } from '~/server/db/client';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { PageLoader } from '~/components/PageLoader/PageLoader';

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

    return {
      redirect: {
        destination: `/bounties/${bountyEntry.bountyId}/entries/${entryId}`,
        permanent: false,
      },
    };
  },
});

export default function EntriesPage() {
  return <PageLoader text="Redirecting to bounty entry..." />;
}
