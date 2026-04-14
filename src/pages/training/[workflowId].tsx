import { dbRead } from '~/server/db/client';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { PageLoader } from '~/components/PageLoader/PageLoader';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  useSession: true,
  resolver: async ({ ctx, session }) => {
    const { workflowId } = ctx.params as { workflowId: string };

    if (!session?.user) {
      return { notFound: true };
    }

    const modelVersion = await dbRead.modelVersion.findFirst({
      where: {
        meta: {
          path: ['trainingWorkflowId'],
          equals: workflowId,
        },
        model: {
          userId: session.user.isModerator ? undefined : session.user.id,
        },
      },
      select: {
        id: true,
        modelId: true,
      },
    });

    if (!modelVersion) {
      const username = session.user.username;
      const destination = username ? `/user/${username}/models?section=training` : '/';

      return {
        redirect: { destination, permanent: false },
      };
    }

    return {
      redirect: {
        destination: `/models/${modelVersion.modelId}/wizard`,
        permanent: false,
      },
    };
  },
});

export default function TrainingRedirectPage() {
  return <PageLoader text="Redirecting to training..." />;
}
