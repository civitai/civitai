import {
  Button,
  Container,
  Stack,
  Title,
  Text,
  Table,
  Group,
  LoadingOverlay,
  Alert,
  Grid,
  Paper,
  ActionIcon,
  CopyButton,
  Tooltip,
  Center,
  Box,
} from '@mantine/core';
import { GetServerSideProps } from 'next';
import { getProviders, signIn, useSession } from 'next-auth/react';
import { BuiltInProviderType } from 'next-auth/providers';
import React from 'react';

import { SocialLabel } from '~/components/Social/SocialLabel';
import { getServerAuthSession } from '~/server/utils/get-server-auth-session';
import { prisma } from '~/server/db/client';
import { reloadSession } from '~/utils/next-auth-helpers';
import { showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { Form, InputProfileImageUpload, InputSwitch, InputText, useForm } from '~/libs/form';
import { z } from 'zod';
import { IconCopy, IconPlus, IconTrash } from '@tabler/icons';
import { Meta } from '~/components/Meta/Meta';
import { useDisclosure } from '@mantine/hooks';
import { formatDate } from '~/utils/date-helpers';
import { ApiKeyModal } from '~/components/ApiKeyModal/ApiKeyModal';
import { ApiKey } from '@prisma/client';
import { openConfirmModal } from '@mantine/modals';
import { env } from '~/env/server.mjs';

const schema = z.object({
  username: z.string(),
  showNsfw: z.boolean().optional(),
  blurNsfw: z.boolean().optional(),
  image: z.string().nullable(),
});

export default function Account({ providers, accounts: initialAccounts, isDev = false }: Props) {
  const { data: session } = useSession();
  const utils = trpc.useContext();

  const [opened, { toggle }] = useDisclosure(false);

  const {
    mutateAsync: updateUserAsync,
    isLoading: updatingUser,
    error: updateUserError,
  } = trpc.user.update.useMutation({
    async onSuccess() {
      showSuccessNotification({ message: 'Your settings have been saved' });
      await utils.model.getAll.invalidate();
      await utils.review.getAll.invalidate();
    },
  });
  const { mutate: deleteAccount, isLoading: deletingAccount } = trpc.account.delete.useMutation({
    onSuccess: async () => {
      await utils.account.invalidate();
    },
  });
  const { data: accounts = [] } = trpc.account.getAll.useQuery(undefined, {
    initialData: initialAccounts,
  });
  const { data: apiKeys = [], isLoading } = trpc.apiKey.getAllUserKeys.useQuery({});

  const deleteApiKeyMutation = trpc.apiKey.delete.useMutation({
    async onSuccess() {
      await utils.apiKey.getAllUserKeys.invalidate();
    },
  });

  const handleDeleteApiKey = (apiKey: ApiKey) => {
    openConfirmModal({
      title: 'Delete API Key',
      children: (
        <Text size="sm">
          Are you sure you want to delete this API Key? This action is destructive.
        </Text>
      ),
      centered: true,
      labels: { confirm: 'Delete API Key', cancel: "No, don't delete it" },
      confirmProps: { color: 'red' },
      onConfirm: () => deleteApiKeyMutation.mutateAsync({ key: apiKey.key }),
    });
  };

  const form = useForm({
    schema,
    mode: 'onChange',
    defaultValues: session?.user,
  });

  return (
    <>
      <Meta title="Manage your Account - Civitai" />

      <Container p={0} size="xs">
        <Grid gutter="xl">
          <Grid.Col span={12}>
            <Stack mb="md">
              <Stack spacing={0}>
                <Title order={1}>Manage Account</Title>
                <Text color="dimmed" size="sm">
                  Take a moment to review your account information and preferences to personalize
                  your experience on the site
                </Text>
              </Stack>
              {updateUserError && (
                <Alert color="red" variant="light">
                  {updateUserError.message}
                </Alert>
              )}
            </Stack>
            <Form
              form={form}
              onSubmit={async (data) => {
                const user = await updateUserAsync({
                  id: session?.user?.id,
                  ...data,
                });
                await reloadSession();
                if (user)
                  form.reset({
                    ...user,
                    username: user.username ?? undefined,
                    showNsfw: user.showNsfw ?? undefined,
                    blurNsfw: user.blurNsfw ?? undefined,
                  });
              }}
            >
              <Stack>
                <InputText name="username" label="Username" required />
                <InputProfileImageUpload name="image" label="Profile image" />
                <InputSwitch
                  name="showNsfw"
                  label="Show me NSFW content"
                  description="If you are not of legal age to view NSFW content, please do not enable this option"
                />
                <InputSwitch
                  name="blurNsfw"
                  label="Blur NSFW content"
                  visible={({ showNsfw }) => !!showNsfw}
                />
                <Button type="submit" loading={updatingUser} disabled={!form.formState.isDirty}>
                  Save
                </Button>
              </Stack>
            </Form>
            {accounts.length > 0 && providers && (
              <Stack mt="xl" spacing="md">
                <Stack spacing={0}>
                  <Title order={2}>Accounts</Title>
                  <Text color="dimmed" size="sm">
                    Connect multiple accounts to your user and sign in with any of them
                  </Text>
                </Stack>
                <div style={{ position: 'relative' }}>
                  <LoadingOverlay visible={deletingAccount} />
                  <Table striped withBorder>
                    <tbody>
                      {Object.values(providers)
                        .filter((provider) => provider.type === 'oauth')
                        .map((provider) => {
                          const account = accounts.find(
                            (account) => account.provider === provider.id
                          );
                          return (
                            <tr key={provider.id}>
                              <td>
                                <Group position="apart">
                                  <SocialLabel
                                    key={provider.id}
                                    type={provider.id as BuiltInProviderType}
                                  />
                                  {!account ? (
                                    <Text
                                      variant="link"
                                      style={{ cursor: 'pointer' }}
                                      onClick={() =>
                                        signIn(provider.id, { callbackUrl: '/user/account' })
                                      }
                                    >
                                      Connect
                                    </Text>
                                  ) : accounts.length > 1 ? (
                                    <Text
                                      variant="link"
                                      color="red"
                                      style={{ cursor: 'pointer' }}
                                      onClick={() => deleteAccount({ accountId: account.id })}
                                    >
                                      Remove
                                    </Text>
                                  ) : null}
                                </Group>
                              </td>
                            </tr>
                          );
                        })}
                    </tbody>
                  </Table>
                </div>
              </Stack>
            )}
          </Grid.Col>
          {isDev ? (
            <Grid.Col span={12} mt="xl">
              <Stack spacing={0}>
                <Group align="start" position="apart">
                  <Title order={2}>API Keys</Title>
                  <Button
                    variant="outline"
                    leftIcon={<IconPlus size={14} stroke={1.5} />}
                    onClick={() => toggle()}
                    compact
                  >
                    Add API key
                  </Button>
                </Group>
                <Text color="dimmed" size="sm">
                  You can use API keys to create apps that interact with our services
                </Text>
              </Stack>
              <Box mt="md" sx={{ position: 'relative' }}>
                <LoadingOverlay visible={isLoading} />
                {apiKeys.length > 0 ? (
                  <Table highlightOnHover withBorder>
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Created at</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {apiKeys.map((apiKey, index) => (
                        <tr key={index}>
                          <td>
                            <Group spacing={4}>
                              <Text>{apiKey.name}</Text>
                              <CopyButton value={apiKey.key}>
                                {({ copied, copy }) => (
                                  <Tooltip
                                    label="Copied token to clipboard"
                                    opened={copied}
                                    position="right"
                                  >
                                    <ActionIcon onClick={() => copy()}>
                                      <IconCopy size={14} stroke={1.5} />
                                    </ActionIcon>
                                  </Tooltip>
                                )}
                              </CopyButton>
                            </Group>
                          </td>
                          <td>{formatDate(apiKey.createdAt)}</td>
                          <td>
                            <Group position="right">
                              <ActionIcon color="red" onClick={() => handleDeleteApiKey(apiKey)}>
                                <IconTrash size="16" stroke={1.5} />
                              </ActionIcon>
                            </Group>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                ) : (
                  <Paper radius="md" mt="lg" p="lg" sx={{ position: 'relative' }} withBorder>
                    <Center>
                      <Stack spacing={2}>
                        <Text weight="bold">There are no API keys in your account</Text>
                        <Text size="sm" color="dimmed">
                          Start by creating your first API Key to connect your apps.
                        </Text>
                      </Stack>
                    </Center>
                  </Paper>
                )}
              </Box>
            </Grid.Col>
          ) : null}
        </Grid>
      </Container>
      {isDev ? <ApiKeyModal title="Create API Key" opened={opened} onClose={toggle} /> : null}
    </>
  );
}

type Props = {
  accounts: AsyncReturnType<typeof getUserAccounts>;
  providers: AsyncReturnType<typeof getProviders>;
  isDev: boolean;
};

const getUserAccounts = async (userId: number) =>
  await prisma.account.findMany({ where: { userId }, select: { id: true, provider: true } });

export const getServerSideProps: GetServerSideProps<Props> = async (context) => {
  const session = await getServerAuthSession(context);

  if (!session?.user)
    return {
      redirect: {
        destination: '/',
        permanent: false,
      },
    };

  const accounts = await getUserAccounts(session.user.id);
  const providers = await getProviders();

  return {
    props: {
      accounts,
      providers,
      isDev: env.NODE_ENV === 'development', // TODO: Remove this once API Keys feature is complete
    },
  };
};
