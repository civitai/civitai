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
import Link from 'next/link';

import { Files } from '~/components/Resource/Files';
import { ModelVersionUpsertForm } from '~/components/Resource/Forms/ModelVersionUpsertForm';
import { dbRead } from '~/server/db/client';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { ModelById } from '~/types/router';
import { showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
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

export default function ModelVersionEdit({ modelId, versionId }: Props) {
  const { data, isLoading } = trpc.model.getById.useQuery({ id: modelId });
  // Take out tagsOnModels to avoid type errors since we don't need it anyway
  const { tagsOnModels, ...model } = data as ModelById;
  const modelVersion = model.modelVersions.find((v) => v.id === versionId);

  return (
    <Container size="sm">
      {isLoading && !model ? (
        <Center>
          <Loader />
        </Center>
      ) : (
        <Stack spacing="xl">
          <Link href={`/models/v2/${modelId}`} passHref>
            <Anchor size="xs">
              <Group spacing={4}>
                <IconArrowLeft size={12} />
                <Text inherit>Back to {model.name} page</Text>
              </Group>
            </Anchor>
          </Link>
          <Stack spacing="xs">
            <Title>Editing version</Title>
            <ModelVersionUpsertForm
              model={model}
              version={modelVersion}
              onSubmit={() => {
                showSuccessNotification({
                  title: 'Success',
                  message: 'The version was saved successfully.',
                });
              }}
            >
              {({ loading }) => (
                <Group mt="xl" position="right">
                  <Button type="submit" loading={loading}>
                    Save
                  </Button>
                </Group>
              )}
            </ModelVersionUpsertForm>
          </Stack>
          <Stack spacing="xs">
            <Title order={2}>Add files</Title>
            <Files model={model} version={modelVersion} />
          </Stack>
        </Stack>
      )}
    </Container>
  );
}

type Props = { modelId: number; versionId: number };
