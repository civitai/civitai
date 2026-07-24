import { dbRead } from '~/server/db/client';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { isNumber } from '~/utils/type-guards';
import { ModelVersionWizard } from '~/components/Resource/Wizard/ModelVersionWizard';
import type { InferGetServerSidePropsType } from 'next';
import { ModelStatus } from '~/shared/utils/prisma/enums';
import { getModelUrl } from '~/utils/string-helpers';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session, ctx }) => {
    const { id } = ctx.params as { id: string };
    if (!session)
      return {
        redirect: {
          destination: getModelUrl({ modelId: Number(id) }),
          permanent: false,
        },
      };

    const modelId = Number(id);
    if (!isNumber(modelId)) return { notFound: true };

    const model = await dbRead.model.findUnique({
      where: { id: modelId },
      select: { id: true, name: true, type: true, userId: true, status: true, deletedAt: true },
    });
    if (!model || model.deletedAt || model.status === ModelStatus.Deleted)
      return { notFound: true };

    const isModerator = session.user?.isModerator ?? false;
    const isOwner = model.userId === session.user?.id || isModerator;
    const unpublished = model.status === ModelStatus.UnpublishedViolation;
    if (!isOwner || unpublished)
      return {
        redirect: {
          destination: getModelUrl({ modelId: model.id, modelName: model.name }),
          permanent: false,
        },
      };

    const latestVersion = await dbRead.modelVersion.findFirst({
      where: { modelId },
      orderBy: { index: 'desc' },
      select: { baseModel: true },
    });

    return { props: { modelId, model, previousBaseModel: latestVersion?.baseModel ?? null } };
  },
});

export default function NewModelVersion({
  model,
  previousBaseModel,
}: InferGetServerSidePropsType<typeof getServerSideProps>) {
  return <ModelVersionWizard data={model as any} previousBaseModel={previousBaseModel} />;
}
