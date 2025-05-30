import type { InferGetServerSidePropsType } from 'next';
import { useRouter } from 'next/router';
import { useEffect } from 'react';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { createOneTimePurchaseTransaction } from '~/server/services/paddle.service';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ ctx, session }) => {
    if (!session || !session.user)
      return {
        redirect: {
          destination: `/login?returnUrl=${encodeURIComponent(ctx.resolvedUrl)}`,
          permanent: false,
        },
      };

    const params = (ctx.params ?? {}) as {
      productId: string[];
    };

    console.log(params);

    try {
      const transactionId = await createOneTimePurchaseTransaction({
        productId: params.productId[0],
        userId: session.user.id as number,
      });

      if (transactionId) {
        return {
          redirect: {
            destination: `/payment/paddle?_ptxn=${transactionId}`,
            permanent: false,
          },
        };
      }

      return {
        props: { transactionId },
      };
    } catch (error) {
      console.error(error);
      return {
        notFound: true,
      };
    }
  },
});

export default function PurchaseOneTimeProduct({
  transactionId,
}: InferGetServerSidePropsType<typeof getServerSideProps>) {
  const router = useRouter();

  useEffect(() => {
    if (transactionId) {
      router.push(`/payment/paddle?_ptxn=${transactionId}`);
    }
  }, [transactionId]);

  return <PageLoader />;
}
