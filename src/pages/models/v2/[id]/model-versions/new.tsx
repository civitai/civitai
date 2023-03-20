import {
  Anchor,
  Button,
  Center,
  Container,
  Group,
  Loader,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { IconArrowLeft } from '@tabler/icons';

import { ModelVersionUpsertForm } from '~/components/Resource/Forms/ModelVersionUpsertForm';
import { dbRead } from '~/server/db/client';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { trpc } from '~/utils/trpc';
import { isNumber } from '~/utils/type-guards';
import Link from 'next/link';
import { ModelById } from '~/types/router';
import { useRouter } from 'next/router';
import { ModelVersionUpsertInput } from '~/server/schema/model-version.schema';
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

export default function NewModelVersion({ modelId }: Props) {
  // const router = useRouter();
  // const { data, isLoading } = trpc.model.getById.useQuery({ id: modelId });
  // // Take out tagsOnModels to avoid type errors since we don't need it anyway
  // const { tagsOnModels, ...model } = data as ModelById;

  // const handleSubmit = (data?: ModelVersionUpsertInput) => {
  //   if (data) router.replace(`/models/v2/${modelId}/model-versions/${data.id}/edit`);
  // };

  return <ModelVersionWizard />;
}

type Props = { modelId: number };
