import { dbRead } from '~/server/db/client';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { PageLoader } from '~/components/PageLoader/PageLoader';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  useSession: true,
  resolver: async ({ ctx }) => {
    const { id } = ctx.params as { id: string };
    const modelVersion = await dbRead.modelVersion.findUnique({
      where: { id: Number(id) },
      select: {
        id: true,
        modelId: true,
      },
    });

    if (!modelVersion) return { notFound: true };

    return {
      redirect: {
        destination: `/models/${modelVersion.modelId}?modelVersionId=${modelVersion.id}`,
        permanent: true,
      },
    };
  },
});

export default function EntriesPage() {
  return <PageLoader text="Redirecting to model entry..." />;
}
