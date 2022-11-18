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

const schema = z.object({
  username: z.string(),
  showNsfw: z.boolean().optional(),
  blurNsfw: z.boolean().optional(),
  image: z.string().nullable(),
});

export default function Account({ providers, accounts: initialAccounts }: Props) {
  const { data: session } = useSession();
  const utils = trpc.useContext();
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

  const form = useForm({
    schema,
    mode: 'onChange',
    defaultValues: session?.user,
  });

  return (
    <Container p={0} size="xs">
      <Stack mb="md">
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

  return { props: { accounts, providers } };
};
