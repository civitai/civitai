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
import { useRouter } from 'next/router';
import { useMemo } from 'react';

import { ModelUpsertForm } from '~/components/Resource/Forms/ModelUpsertForm';
import { dbRead } from '~/server/db/client';
import { ModelUpsertInput } from '~/server/schema/model.schema';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { trpc } from '~/utils/trpc';
import { isNumber } from '~/utils/type-guards';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  resolver: async ({ session, ssg, ctx }) => {
    const { id } = ctx.params as { id: string };
    if (!session)
      return {
        redirect: {
          destination: `/models/${id}`,
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

    console.log({ isOwner, isModerator });
    if (!isOwner && !isModerator)
      return {
        redirect: {
          destination: `/models/${id}`,
          permanent: false,
        },
      };

    await ssg?.model.getById.prefetch({ id: modelId });

    return {
      props: { modelId },
    };
  },
});

export default function ModelEditPage({ modelId }: Props) {
  const router = useRouter();
  const { data, isLoading } = trpc.model.getById.useQuery({ id: modelId });
  const model = useMemo(
    () =>
      ({
        ...data,
        tagsOnModels: data?.tagsOnModels.map(({ tag }) => tag) ?? [],
      } as ModelUpsertInput),
    [data]
  );

  const handleSubmit = () => {
    router.push(`/models/${modelId}`);
  };

  return (
    <Container size="sm">
      {isLoading && !data ? (
        <Center>
          <Loader />
        </Center>
      ) : (
        <Stack spacing="xl">
          <Link href={`/models/${modelId}`} passHref legacyBehavior>
            <Anchor size="xs">
              <Group spacing={4}>
                <IconArrowLeft size={12} />
                <Text inherit>Back to {model.name} page</Text>
              </Group>
            </Anchor>
          </Link>
          <Stack spacing="xs">
            <Title>Editing model</Title>
            <ModelUpsertForm model={model} onSubmit={handleSubmit}>
              {({ loading }) => (
                <Group position="right">
                  <Button type="submit" mt="xl" loading={loading}>
                    Save
                  </Button>
                </Group>
              )}
            </ModelUpsertForm>
          </Stack>
        </Stack>
      )}
    </Container>
  );
}

type Props = { modelId: number };
