import { z } from 'zod';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { getUserByPaddleCustomerId } from '~/server/services/user.service';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

const querySchema = z.object({ paddleCustomerId: z.string() });

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  resolver: async ({ session, ctx }) => {
    if (!session?.user?.isModerator) {
      return { redirect: { destination: '/', permanent: false } };
    }

    const result = querySchema.safeParse(ctx.params);
    if (!result.success) return { notFound: true };

    const { paddleCustomerId } = result.data;

    const user = await getUserByPaddleCustomerId({ paddleCustomerId });

    if (!user || !user.username) return { notFound: true };

    return {
      redirect: {
        destination: `/user/${user.username}`,
        permanent: false,
      },
    };
  },
});

export default function PaddleCustomer() {
  return <PageLoader />;
}
