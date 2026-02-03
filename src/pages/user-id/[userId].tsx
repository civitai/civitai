import { dbRead } from '~/server/db/client';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { PageLoader } from '~/components/PageLoader/PageLoader';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  useSession: true,
  resolver: async ({ session, ctx }) => {
    if (!session?.user?.isModerator) return { redirect: { destination: '/', permanent: false } };

    const { userId } = ctx.params as { userId: string };
    const isEmail = userId.includes('@');

    const user = await dbRead.user.findFirst({
      where: isEmail ? { email: userId } : { id: Number(userId) },
      select: {
        username: true,
      },
    });

    if (!user?.username) return { notFound: true };

    return {
      redirect: {
        destination: `/user/${user.username}`,
        permanent: false,
      },
    };
  },
});

export default function EntriesPage() {
  return <PageLoader text="Redirecting to user profile..." />;
}
