import {
  Button,
  Container,
  Stack,
  Switch,
  TextInput,
  Title,
  Text,
  Table,
  Group,
  LoadingOverlay,
  Alert,
} from '@mantine/core';
import { GetServerSideProps } from 'next';
import { Session } from 'next-auth';
import { getServerAuthSession } from '~/server/common/get-server-auth-session';
import { useForm } from '@mantine/form';
import { getProviders, signIn } from 'next-auth/react';
import { trpc } from '~/utils/trpc';
import { prisma } from '~/server/db/client';
import React from 'react';

import { SocialLabel } from '~/components/Social/SocialLabel';
import { BuiltInProviderType } from 'next-auth/providers';
import { reloadSession } from './../../utils/next-auth-helpers';

export default function Account({ user, providers, accounts: initialAccounts }: Props) {
  const utils = trpc.useContext();
  const {
    mutateAsync: updateUserAsync,
    isLoading: updatingUser,
    error: updateUserError,
  } = trpc.user.update.useMutation();
  const { mutate: deleteAccount, isLoading: deletingAccount } = trpc.account.delete.useMutation({
    onSuccess: () => {
      utils.account.invalidate();
    },
  });
  const { data: accounts = [] } = trpc.account.getAll.useQuery(undefined, {
    initialData: initialAccounts,
  });

  const form = useForm({
    initialValues: user,
  });

  return (
    <Container p={0} size="xs">
      <form
        onSubmit={form.onSubmit(async (values) => {
          await updateUserAsync({
            id: user?.id,
            username: values.username,
            showNsfw: values.showNsfw,
            blurNsfw: values.blurNsfw,
          });
          await reloadSession();
        })}
      >
        <Stack>
          <Title order={1}>Manage Account</Title>
          <Text>
            Take a moment to review your account information and preferences to personalize your
            experience on the site
          </Text>
          {updateUserError && (
            <Alert color="red" variant="light">
              {updateUserError.message}
            </Alert>
          )}
          <TextInput label="Username" required {...form.getInputProps('username')} />
          <Switch
            label="I am of legal age to view NSFW content"
            checked={form.values.showNsfw}
            {...form.getInputProps('showNsfw')}
          />
          {form.values.showNsfw && (
            <Switch
              label="Blur NSFW content"
              checked={form.values.blurNsfw}
              {...form.getInputProps('blurNsfw')}
            />
          )}
          <Button type="submit" loading={updatingUser} disabled={!form.isDirty()}>
            Save
          </Button>
        </Stack>
      </form>
      {accounts.length > 0 && providers && (
        <Stack mt="md" spacing="xs">
          <Title order={4}>Accounts</Title>
          <div style={{ position: 'relative' }}>
            <LoadingOverlay visible={deletingAccount} />
            <Table striped withBorder>
              <tbody>
                {Object.values(providers)
                  .filter((provider) => provider.type === 'oauth')
                  .map((provider) => {
                    const account = accounts.find((account) => account.provider === provider.id);
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
    </Container>
  );
}

type Props = {
  user: Session['user'];
  accounts: AsyncReturnType<typeof getUserAccounts>;
  providers: AsyncReturnType<typeof getProviders>;
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

  return { props: { user: session.user, accounts, providers } };
};
