import { ModelStatus } from '@prisma/client';
import { ModelWizard } from '~/components/Resource/Wizard/ModelWizard';
import { dbRead } from '~/server/db/client';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { isNumber } from '~/utils/type-guards';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  prefetch: 'always',
  resolver: async ({ ctx, ssg, session }) => {
    const params = ctx.params as { id?: string };
    if (!session)
      return {
        redirect: {
          destination: `/models/${params.id}`,
          permanent: false,
        },
      };

    const id = Number(params.id);
    if (!isNumber(id)) return { notFound: true };

    const model = await dbRead.model.findUnique({
      where: { id },
      select: { userId: true, status: true, publishedAt: true, deletedAt: true },
    });
    if (!model || model.deletedAt) return { notFound: true };

    const isModerator = session.user?.isModerator ?? false;
    const isOwner = model.userId === session.user?.id || isModerator;
    if (!isOwner || model.status !== ModelStatus.Draft)
      return {
        redirect: {
          destination: `/models/${params.id}`,
          permanent: false,
        },
      };

    await ssg?.model.getById.prefetch({ id });
  },
});

export default function ModelEdit() {
  return <ModelWizard />;
}

ModelEdit.getLayout = (page: React.ReactElement) => <>{page}</>;
