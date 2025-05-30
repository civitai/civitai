import { Center, Container, Group, Loader, Stack, Title } from '@mantine/core';
import type { InferGetServerSidePropsType } from 'next';
import { CustomMarkdown } from '~/components/Markdown/CustomMarkdown';
import rehypeRaw from 'rehype-raw';
import { z } from 'zod';
import { NotFound } from '~/components/AppLayout/NotFound';
import { BackButton } from '~/components/BackButton/BackButton';
import { Meta } from '~/components/Meta/Meta';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { trpc } from '~/utils/trpc';
import { numericString } from '~/utils/zod-helpers';

const querySchema = z.object({ versionId: numericString() });

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  resolver: async ({ ssg, ctx }) => {
    const result = querySchema.safeParse(ctx.params);
    if (!result.success) return { notFound: true };
    if (ssg) await ssg.modelVersion.getLicense.prefetch({ id: result.data.versionId });

    return { props: { versionId: result.data.versionId } };
  },
});

export default function ModelLicensePage({
  versionId,
}: InferGetServerSidePropsType<typeof getServerSideProps>) {
  const { data, isLoading } = trpc.modelVersion.getLicense.useQuery({ id: versionId });

  if (isLoading)
    return (
      <Center p="xl">
        <Loader />
      </Center>
    );
  if (!data) return <NotFound />;

  return (
    <>
      <Meta title={`${data.model.name} License`} deIndex />
      <Container size="md" p="xl">
        <Stack>
          <Group>
            <BackButton url={`/models/${data.model.id}?modelVersionId=${data.id}`} />
            <Title>{data.model.name} License</Title>
          </Group>
          {data.license.content && (
            <CustomMarkdown rehypePlugins={[rehypeRaw]}>{data.license.content}</CustomMarkdown>
          )}
        </Stack>
      </Container>
    </>
  );
}
