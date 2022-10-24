import { createProxySSGHelpers } from '@trpc/react-query/ssg';
import { GetStaticPaths, GetStaticPropsContext, InferGetStaticPropsType } from 'next';
import { useRouter } from 'next/router';
import superjson from 'superjson';
import { appRouter } from '~/server/trpc/router';
import { prisma } from '~/server/db/client';
import { createContextInner } from '~/server/trpc/context';
import { trpc } from '~/utils/trpc';
import { Container, Grid, Group, Paper, Stack, Text, Title } from '@mantine/core';

export async function getStaticProps(context: GetStaticPropsContext<{ id: string }>) {
  const ssg = createProxySSGHelpers({
    router: appRouter,
    ctx: await createContextInner({ session: null }),
    transformer: superjson, // optional - adds superjson serialization
  });
  const id = Number(context.params?.id);
  // prefetch `model.byId`
  await ssg.model.getById.prefetch({ id });

  return {
    props: {
      trpcState: ssg.dehydrate(),
      id,
    },
    revalidate: 1,
  };
}

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

  return (
    <Container size="xl">
      <Grid gutter="xl">
        <Grid.Col sm={12} lg={8}>
          <Grid>
            <Grid.Col span={12}>
              <Stack>
                <Title order={1}>{model?.name}</Title>
              </Stack>
            </Grid.Col>
            <Grid.Col span={12}>
              <Text>{model?.description}</Text>
            </Grid.Col>
          </Grid>
        </Grid.Col>
        <Grid.Col sm={12} lg={4}>
          <Paper p="xs" radius="md" withBorder>
            <Grid>
              <Grid.Col span={12}>
                <Group>
                  <Text weight="bold">Latest Version</Text>
                  <Text>{model?.modelVersions[0]?.name}</Text>
                </Group>
              </Grid.Col>
            </Grid>
          </Paper>
        </Grid.Col>
      </Grid>
    </Container>
  );
}
