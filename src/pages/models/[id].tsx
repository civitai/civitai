import {
  ActionIcon,
  Badge,
  Button,
  Container,
  Grid,
  Group,
  Menu,
  Stack,
  Text,
  Title,
  useMantineTheme,
} from '@mantine/core';
import { NextLink } from '@mantine/next';
import { IconDotsVertical, IconDownload, IconEdit, IconTrash } from '@tabler/icons';
import { createProxySSGHelpers } from '@trpc/react-query/ssg';
import dayjs from 'dayjs';
import { GetStaticPaths, GetStaticProps, InferGetStaticPropsType } from 'next';
import { useRouter } from 'next/router';
import superjson from 'superjson';
import {
  DescriptionTable,
  type Props as DescriptionTableProps,
} from '~/components/DescriptionTable/DescriptionTable';
import { ModelForm } from '~/components/Model/ModelForm/ModelForm';
import { prisma } from '~/server/db/client';
import { createContextInner } from '~/server/trpc/context';
import { appRouter } from '~/server/trpc/router';
import { formatBytes } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

export const getStaticProps: GetStaticProps<{ id: number }> = async (context) => {
  const ssg = createProxySSGHelpers({
    router: appRouter,
    ctx: await createContextInner({ session: null }),
    transformer: superjson,
  });
  const id = Number(context.params?.id as string);
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
  const theme = useMantineTheme();
  const router = useRouter();

  const { id } = props;
  const { edit } = router.query;

  const { data: model, isLoading, isFetching } = trpc.model.getById.useQuery({ id });

  if (!!edit && model) return <ModelForm model={model} />;

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
      <Grid gutter="xl" grow>
        <Grid.Col span={12}>
          <Group align="center" sx={{ justifyContent: 'space-between' }}>
            <Title order={1}>{model?.name}</Title>
            <Group spacing="xs">
              <Button
                component="a"
                leftIcon={<IconDownload size={16} />}
                href={latestVersion.url}
                target="_blank"
                size="xs"
                download
              >
                {`Download (${formatBytes(latestVersion.sizeKB)})`}
              </Button>
              <Menu position="bottom-end" transition="pop-top-right">
                <Menu.Target>
                  <ActionIcon variant="outline">
                    <IconDotsVertical color={theme.colors.dark[6]} size={16} />
                  </ActionIcon>
                </Menu.Target>

                <Menu.Dropdown>
                  <Menu.Item
                    component={NextLink}
                    href={`/models/${id}?edit=true`}
                    icon={<IconEdit size={14} stroke={1.5} />}
                    shallow
                  >
                    Edit Model
                  </Menu.Item>
                  <Menu.Item
                    color={theme.colors.red[6]}
                    icon={<IconTrash size={14} stroke={1.5} />}
                  >
                    Delete Model
                  </Menu.Item>
                </Menu.Dropdown>
              </Menu>
            </Group>
          </Group>
        </Grid.Col>
        <Grid.Col sm={12} lg={8}>
          <Text>{model?.description}</Text>
        </Grid.Col>
        <Grid.Col sm={12} lg={4}>
          <Stack>
            <DescriptionTable title="Model Details" items={modelDetails} />
          </Stack>
        </Grid.Col>
      </Grid>
    </Container>
  );
}
