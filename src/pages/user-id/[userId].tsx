import { dbRead } from '~/server/db/client';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { PageLoader } from '~/components/PageLoader/PageLoader';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  useSession: true,
  resolver: async ({ ctx }) => {
    const { userId } = ctx.params as { userId: string };
    const user = await dbRead.user.findUnique({
      where: { id: Number(userId) },
      select: {
        username: true,
      },
    });

    if (!user?.username) return { notFound: true };

    return {
      redirect: {
        destination: `/user/${user.username}`,
        permanent: true,
      },
    };
  },
});

export default function EntriesPage() {
  return <PageLoader text="Redirecting to user profile..." />;
}
