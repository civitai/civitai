import { createProxySSGHelpers } from '@trpc/react-query/ssg';
import dayjs from 'dayjs';
import { GetStaticPaths, GetStaticProps, InferGetStaticPropsType } from 'next';
import { useRouter } from 'next/router';
import superjson from 'superjson';
import { appRouter } from '~/server/trpc/router';
import { prisma } from '~/server/db/client';
import { createContextInner } from '~/server/trpc/context';
import { trpc } from '~/utils/trpc';
import { Badge, Button, Container, Grid, Group, Stack, Text, Title } from '@mantine/core';
import {
  DescriptionTable,
  type Props as DescriptionTableProps,
} from '~/components/DescriptionTable/DescriptionTable';
import { IconDownload } from '@tabler/icons';
import { formatBytes } from '~/utils/number-helpers';

export const getStaticProps: GetStaticProps<{ id: number }> = async (context) => {
  const ssg = createProxySSGHelpers({
    router: appRouter,
    ctx: await createContextInner({ session: null }),
    transformer: superjson, // optional - adds superjson serialization
  });
  const id = Number(context.params?.id as string);
  // prefetch `model.byId`
  await ssg.model.getById.prefetch({ id });

  return {
    props: {
      trpcState: ssg.dehydrate(),
      id,
    },
    revalidate: 1,
  };
};

export const getStaticPaths: GetStaticPaths = async () => {
  const models = await prisma.model.findMany({
    select: { id: true },
  });

  return {
    paths: models.map((model) => ({
      params: {
        id: String(model.id),
      },
    })),
    // https://nextjs.org/docs/basic-features/data-fetching#fallback-blocking
    fallback: 'blocking',
  };
};

export default function ModelDetail(props: InferGetStaticPropsType<typeof getStaticProps>) {
  const { edit } = useRouter().query;
  const { id } = props;

  const { data: model, isLoading, isFetching } = trpc.model.getById.useQuery({ id });

  const modelDetails: DescriptionTableProps['items'] = [
    {
      label: 'Type',
      value: <Badge radius="sm">{model?.type}</Badge>,
    },
    {
      label: 'Last Update',
      value: <Text>{dayjs(model?.updatedAt).format('MMM D, YYYY')}</Text>,
    },
    {
      label: 'Versions',
      value: <Text>{model?.modelVersions.length}</Text>,
    },
    {
      label: 'Uploaded By',
      value: <Text>{model?.user.name}</Text>,
    },
  ];
  const [latestVersion] = model?.modelVersions ?? [];

  return (
    <Container size="xl" py="xl">
      <Grid gutter="xl">
        <Grid.Col sm={12} lg={8}>
          <Grid>
            <Grid.Col span={12}>
              <Group>
                <Title order={1}>{model?.name}</Title>
              </Group>
            </Grid.Col>
            <Grid.Col span={12}>
              <Text>{model?.description}</Text>
            </Grid.Col>
          </Grid>
        </Grid.Col>
        <Grid.Col sm={12} lg={4}>
          <Stack>
            <DescriptionTable title="Model Details" items={modelDetails} />
            <Button
              component="a"
              leftIcon={<IconDownload stroke={1.5} />}
              href={latestVersion.url}
              target="_blank"
              download
            >{`Download Latest (${formatBytes(latestVersion.sizeKB)})`}</Button>
          </Stack>
        </Grid.Col>
      </Grid>
    </Container>
  );
}
