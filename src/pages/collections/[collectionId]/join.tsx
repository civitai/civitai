import { useRouter } from 'next/router';
import { useEffect } from 'react';
import { useMutateCollection } from '~/components/Collections/collection.utils';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { getCollectionById } from '~/server/services/collection.service';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { useDebouncer } from '~/utils/debouncer';
import { getLoginLink } from '~/utils/login-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  useSession: true,
  resolver: async ({ features, ctx, session }) => {
    if (!session) {
      return {
        redirect: {
          destination: getLoginLink({ returnUrl: ctx.resolvedUrl }),
          permanent: false,
        },
      };
    }

    const collection = await getCollectionById({ input: { id: Number(ctx.query.collectionId) } });
    if (!features?.collections) return { notFound: true };

    if (!collection) return { notFound: true };

    if (!collection.metadata?.inviteUrlEnabled) {
      return {
        redirect: {
          destination: `/collections/${ctx.query.collectionId}`,
          permanent: false,
        },
      };
    }

    return {
      props: {
        collectionId: Number(ctx.query.collectionId),
      },
    };
  },
});

export default function JoinCollection({ collectionId }: { collectionId: number }) {
  const { joinCollectionAsManager, joinCollectionAsManagerLoading } = useMutateCollection();
  const router = useRouter();
  const debouncer = useDebouncer(1000);

  const handleJoin = async () => {
    try {
      const success = await joinCollectionAsManager({ id: collectionId });
      if (success) {
        showSuccessNotification({
          title: 'You have successfully joined this collection',
          message: 'You can now manage this collection and its resources.',
        });

        router.replace(`/collections/${collectionId}`);
      }
    } catch (error: any) {
      showErrorNotification({
        title: 'Error while trying to join this collection',
        reason: (error?.message ??
          'We were unable to add you to this collection. Please try again later.') as string,
        error,
      });

      router.replace(`/collections/${collectionId}`);
    }
  };

  useEffect(() => {
    if (!joinCollectionAsManagerLoading) {
      debouncer(() => handleJoin());
    }
  }, []);
  return <PageLoader />;
}
