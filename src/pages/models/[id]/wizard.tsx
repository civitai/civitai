import { ModelStatus } from '@prisma/client';
import { ModelWizard } from '~/components/Resource/Wizard/ModelWizard';
import { getDbWithoutLag } from '~/server/db/db-helpers';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { isNumber } from '~/utils/type-guards';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  prefetch: 'always',
  useSession: true,
  resolver: async ({ ctx, ssg, session }) => {
    const params = ctx.params as { id?: string };
    if (!session)
      return {
        redirect: {
          destination: `/models/${params.id}?missingSession=true`,
          permanent: false,
        },
      };

    const id = Number(params.id);
    if (!isNumber(id)) return { notFound: true };

    const db = await getDbWithoutLag('model', id);
    const model = await db.model.findFirst({
      where: { id },
      select: { userId: true, status: true, publishedAt: true, deletedAt: true },
    });

    const isModerator = session.user?.isModerator ?? false;
    const isOwner = model?.userId === session.user?.id || isModerator;
    if (!isOwner || model?.status !== ModelStatus.Draft)
      return {
        redirect: {
          destination: `/models/${params.id}?notOwner=true`,
          permanent: false,
        },
      };

    await ssg?.model.getById.prefetch({ id });
  },
});

export default function ModelEdit() {
  return <ModelWizard />;
}
