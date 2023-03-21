import React from 'react';
import { ModelWizard } from '~/components/Resource/Wizard/ModelWizard';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { isNumber } from '~/utils/type-guards';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  prefetch: 'always',
  resolver: async ({ ctx, ssg, session }) => {
    const params = ctx.params as { id?: string };

    if (!session) {
      return {
        redirect: {
          destination: `/models/${params.id}`,
          permanent: false,
        },
      };
    }

    const id = Number(params.id);
    if (!isNumber(id)) return { notFound: true };

    await ssg?.model.getById.prefetch({ id });
  },
});

export default function ModelEdit() {
  return <ModelWizard />;
}

ModelEdit.getLayout = (page: React.ReactElement) => <>{page}</>;
