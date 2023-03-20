import { ModelVersionWizard } from '~/components/Resource/Wizard/ModelVersionWizard';
import { dbRead } from '~/server/db/client';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { isNumber } from '~/utils/type-guards';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  resolver: async ({ session, ssg, ctx }) => {
    const params = ctx.params as { id: string; versionId: string };
    if (!session)
      return {
        redirect: {
          destination: `/models/v2/${params.id}`,
          permanent: false,
        },
      };

    const id = Number(params.id);
    const versionId = Number(params.versionId);
    if (!isNumber(id) || !isNumber(versionId)) return { notFound: true };

    const model = await dbRead.model.findUnique({ where: { id }, select: { userId: true } });
    if (!model) return { notFound: true };

    const isOwner = model.userId === session.user?.id;
    const isModerator = session.user?.isModerator ?? false;
    if (!isOwner && !isModerator)
      return {
        redirect: {
          destination: `/models/v2/${params.id}`,
          permanent: false,
        },
      };

    await ssg?.model.getById.prefetch({ id });

    return { props: { modelId: id, versionId } };
  },
});

export default function Wizard() {
  return <ModelVersionWizard />;
}
