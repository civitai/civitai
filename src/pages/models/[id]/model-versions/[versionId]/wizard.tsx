import { ModelStatus } from '@prisma/client';
import { ModelVersionWizard } from '~/components/Resource/Wizard/ModelVersionWizard';
import { dbRead } from '~/server/db/client';
import { getDefaultModelVersion } from '~/server/services/model-version.service';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { isNumber } from '~/utils/type-guards';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  useSession: true,
  resolver: async ({ session, ssg, ctx }) => {
    const params = ctx.params as { id: string; versionId: string };
    if (!session)
      return {
        redirect: {
          destination: `/models/${params.id}`,
          permanent: false,
        },
      };

    const id = Number(params.id);
    const versionId = Number(params.versionId);
    if (!isNumber(id) || !isNumber(versionId)) return { notFound: true };

    const model = await dbRead.model.findUnique({
      where: { id },
      select: { userId: true, deletedAt: true, status: true },
    });
    if (!model || model.deletedAt || model.status === ModelStatus.Deleted)
      return { notFound: true };

    const isModerator = session.user?.isModerator ?? false;
    const isOwner = model.userId === session.user?.id || isModerator;
    const unpublished = model.status === ModelStatus.UnpublishedViolation;
    if (!isOwner || unpublished)
      return {
        redirect: {
          destination: `/models/${params.id}?modelVersionId=${versionId}`,
          permanent: false,
        },
      };

    const version = await getDefaultModelVersion({ modelId: id, modelVersionId: versionId }).catch(
      (err) => {
        console.error(err);
        return null;
      }
    );
    if (!version) return { notFound: true };
    if (version.status !== ModelStatus.Draft)
      return {
        redirect: {
          destination: `/models/${params.id}?modelVersionId=${versionId}`,
          permanent: false,
        },
      };

    await ssg?.modelVersion.getById.prefetch({ id: versionId });

    return { props: { modelId: id, versionId } };
  },
});

export default function Wizard() {
  return <ModelVersionWizard />;
}
