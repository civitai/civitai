import { dbRead } from '~/server/db/client';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { isNumber } from '~/utils/type-guards';
import { ModelVersionWizard } from '~/components/Resource/Wizard/ModelVersionWizard';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  resolver: async ({ session, ssg, ctx }) => {
    const { id } = ctx.params as { id: string };
    if (!session)
      return {
        redirect: {
          destination: `/models/v2/${id}`,
          permanent: false,
        },
      };

    const modelId = Number(id);
    if (!isNumber(modelId)) return { notFound: true };

    const model = await dbRead.model.findUnique({
      where: { id: modelId },
      select: { userId: true },
    });
    if (!model) return { notFound: true };

    const isOwner = model.userId === session.user?.id;
    const isModerator = session.user?.isModerator ?? false;

    if (!isOwner && !isModerator)
      return {
        redirect: {
          destination: `/models/v2/${id}`,
          permanent: false,
        },
      };

    await ssg?.model.getById.prefetch({ id: modelId });

    return { props: { modelId } };
  },
});

export default function NewModelVersion() {
  return <ModelVersionWizard />;
}
