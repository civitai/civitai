import * as z from 'zod';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { env } from '~/env/client';
import { getUserByPaddleCustomerId } from '~/server/services/user.service';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

const paramsSchema = z.object({ paddleCustomerId: z.string() });
const querySchema = z.object({
  app: z.enum(['retool']).optional(),
});

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  resolver: async ({ session, ctx }) => {
    if (!session?.user?.isModerator) {
      return { redirect: { destination: '/', permanent: false } };
    }

    const result = paramsSchema.safeParse(ctx.params);
    const queryRes = querySchema.safeParse(ctx.query);
    const query = queryRes.success ? queryRes.data : undefined;

    if (!result.success) return { notFound: true };

    const { paddleCustomerId } = result.data;

    const user = await getUserByPaddleCustomerId({ paddleCustomerId });

    if (!user || !user.username) return { notFound: true };

    if (query?.app === 'retool') {
      return {
        redirect: {
          destination: `${env.NEXT_PUBLIC_USER_LOOKUP_URL}${user.id}`,
          permanent: false,
        },
      };
    }

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
