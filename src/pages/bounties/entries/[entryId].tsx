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

    // threadUrlMap builds `/bounties/entries/{id}?highlight=…` for every bountyEntry comment
    // notification, and a destination without the query silently drops it — so the comment the
    // notification is about never gets highlighted.
    const { entryId: _, ...query } = ctx.query;
    const queryString = new URLSearchParams(
      Object.entries(query).flatMap(([key, value]) =>
        value === undefined
          ? []
          : Array.isArray(value)
          ? value.map((v) => [key, v])
          : [[key, value]]
      ) as [string, string][]
    ).toString();

    return {
      redirect: {
        destination: `/bounties/${bountyEntry.bountyId}/entries/${entryId}${
          queryString ? `?${queryString}` : ''
        }`,
        permanent: false,
      },
    };
  },
});

export default function EntriesPage() {
  return <PageLoader text="Redirecting to bounty entry..." />;
}
