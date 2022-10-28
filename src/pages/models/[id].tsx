import {
  ActionIcon,
  Avatar,
  Badge,
  Button,
  Container,
  CopyButton,
  createStyles,
  Divider,
  Grid,
  Group,
  Menu,
  Rating,
  Stack,
  Text,
  Title,
  useMantineTheme,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { closeAllModals, openConfirmModal } from '@mantine/modals';
import { NextLink } from '@mantine/next';
import { showNotification } from '@mantine/notifications';
import {
  IconCheck,
  IconCopy,
  IconDotsVertical,
  IconDownload,
  IconEdit,
  IconTrash,
  IconX,
} from '@tabler/icons';
import { createProxySSGHelpers } from '@trpc/react-query/ssg';
import dayjs from 'dayjs';
import { GetStaticPaths, GetStaticProps, InferGetStaticPropsType } from 'next';
import { useSession } from 'next-auth/react';
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
import { getInitials } from '~/utils/string-helpers';
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

const useStyles = createStyles((theme) => ({
  actions: {
    [theme.fn.smallerThan('sm')]: {
      width: '100%',
    },
  },

  title: {
    [theme.fn.smallerThan('sm')]: {
      fontSize: theme.fontSizes.xs * 2.4, // 24px
    },
  },
}));

export default function ModelDetail(props: InferGetStaticPropsType<typeof getStaticProps>) {
  const theme = useMantineTheme();
  const router = useRouter();
  const { data: session } = useSession();
  const { classes } = useStyles();
  const isMobile = useMediaQuery(`(max-width: ${theme.breakpoints.sm - 1}px)`, true, {
    getInitialValueInEffect: false,
  });

  const { id } = props;
  const { edit } = router.query;

  const { data: model } = trpc.model.getById.useQuery({ id });
  const deleteMutation = trpc.model.delete.useMutation();

  if (!model)
    return (
      <Container size="xl" p="xl">
        <Stack align="center">
          <Title order={1}>404</Title>
          <Text size="xl">The page you are looking for doesn&apos;t exists</Text>
        </Stack>
      </Container>
    );
  if (!!edit && model) return <ModelForm model={model} />;

  const handleDeleteModel = () => {
    openConfirmModal({
      title: 'Delete Model',
      children: (
        <Text size="sm">
          Are you sure you want to delete this model? This action is destructive and you will have
          to contact support to restore your data.
        </Text>
      ),
      centered: true,
      labels: { confirm: 'Delete Model', cancel: "No, don't delete it" },
      confirmProps: { color: 'red', loading: deleteMutation.isLoading },
      closeOnConfirm: false,
      onConfirm: async () => {
        if (model) {
          deleteMutation.mutate(
            { id: model.id },
            {
              onSuccess() {
                showNotification({
                  title: 'Your model has been deleted',
                  message: 'Successfully deleted the model',
                  color: 'teal',
                  icon: <IconCheck size={18} />,
                });
                closeAllModals();
                router.replace('/'); // Redirect to the models or user page once available
              },
              onError(error) {
                const message = error.message;

                showNotification({
                  title: 'Could not delete model',
                  message: `An error occurred while deleting the model: ${message}`,
                  color: 'red',
                  icon: <IconX size={18} />,
                });
              },
            }
          );
        }
      },
    });
  };

  const modelDetails: DescriptionTableProps['items'] = [
    {
      label: 'Type',
      value: <Badge radius="sm">{model?.type}</Badge>,
    },
    {
      label: 'Downloads',
      value: <Text>{model?.rank?.downloadCountAllTime.toLocaleString() ?? 0}</Text>,
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
      label: 'Trained Words',
      value: (
        <Group spacing={4}>
          {model?.trainedWords.map((word, index) => (
            <CopyButton key={index} value={word}>
              {({ copy }) => (
                <Badge
                  size="sm"
                  color="violet"
                  sx={{ cursor: 'pointer' }}
                  onClick={() => {
                    copy();
                    showNotification({ message: 'Copied trained word!', color: 'teal' });
                  }}
                >
                  <Group spacing={4} align="center">
                    {word}
                    <IconCopy stroke={1.5} size={12} />
                  </Group>
                </Badge>
              )}
            </CopyButton>
          ))}
        </Group>
      ),
    },
    {
      label: 'Uploaded By',
      value: (
        <Group spacing="xs">
          <Avatar
            src={model?.user.image}
            alt={model?.user.name ?? 'User avatar'}
            radius="xl"
            size="sm"
          >
            {getInitials(model?.user.name ?? '')}
          </Avatar>
          <Text>{model?.user.name}</Text>
        </Group>
      ),
    },
  ];

  const latestVersion = model?.modelVersions[model.modelVersions.length - 1];
  console.log({ isMobile });

  return (
    <Container size="xl" py="xl">
      <Stack spacing="xs" mb="xl">
        <Group align="center" sx={{ justifyContent: 'space-between' }}>
          <Title className={classes.title} order={1}>
            {model?.name}
          </Title>
          <Group spacing="xs" className={classes.actions}>
            <Button
              component="a"
              leftIcon={<IconDownload size={16} />}
              href={latestVersion?.url}
              target="_blank"
              size="xs"
              fullWidth={isMobile}
              download
            >
              {`Download (${formatBytes(latestVersion?.sizeKB ?? 0)})`}
            </Button>
            {session && session.user?.id === model?.user.id ? (
              <Menu position="bottom-end" transition="pop-top-right">
                <Menu.Target>
                  <ActionIcon variant="outline">
                    <IconDotsVertical size={16} />
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
                    onClick={handleDeleteModel}
                  >
                    Delete Model
                  </Menu.Item>
                </Menu.Dropdown>
              </Menu>
            ) : null}
          </Group>
        </Group>
        <Group spacing={4}>
          <Rating
            value={model?.rank?.ratingAllTime}
            fractions={isMobile ? 5 : 2}
            count={isMobile ? 1 : undefined}
            readOnly
          />
          <Text size="sm">({model?.rank?.ratingAllTime.toLocaleString() ?? 0})</Text>
        </Group>
      </Stack>
      <Grid gutter="xl">
        <Grid.Col xs={12} sm={5} md={4} orderSm={2}>
          <Stack>
            <DescriptionTable title="Model Details" items={modelDetails} />
          </Stack>
        </Grid.Col>
        <Grid.Col
          xs={12}
          sm={7}
          md={8}
          orderSm={1}
          sx={(theme) => ({
            [theme.fn.largerThan('xs')]: {
              // borderRight: `1px ${
              //   theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[3]
              // } solid`,
              padding: `0 ${theme.spacing.sm}px`,
              margin: `${theme.spacing.sm}px 0`,
            },
          })}
        >
          <Stack>
            <Title className={classes.title} order={2}>
              About this model
            </Title>
            <Text>{model?.description}</Text>
          </Stack>
        </Grid.Col>
        <Grid.Col span={12} orderSm={3}>
          <Title className={classes.title} order={2}>
            Versions
          </Title>
        </Grid.Col>
        <Grid.Col span={12} orderSm={4}>
          <Title className={classes.title} order={2}>
            Reviews
          </Title>
        </Grid.Col>
      </Grid>
    </Container>
  );
}
