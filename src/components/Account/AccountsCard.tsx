import {
  Table,
  Group,
  Text,
  LoadingOverlay,
  Card,
  Title,
  Stack,
  Button,
  Alert,
} from '@mantine/core';
import { BuiltInProviderType } from 'next-auth/providers';
import { getProviders, signIn } from 'next-auth/react';
import { useRouter } from 'next/router';
import { SocialLabel } from '~/components/Social/SocialLabel';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';

export function AccountsCard({ providers }: { providers: AsyncReturnType<typeof getProviders> }) {
  const utils = trpc.useContext();
  const currentUser = useCurrentUser();
  const { error } = useRouter().query;
  const { data: accounts = [] } = trpc.account.getAll.useQuery();

  const { mutate: deleteAccount, isLoading: deletingAccount } = trpc.account.delete.useMutation({
    onSuccess: async () => {
      await utils.account.invalidate();
    },
  });

  if (!providers) return null;
  const canRemoveAccounts = accounts.length > 1 || currentUser?.emailVerified;

  return (
    <Card withBorder id="accounts">
      <Stack>
        <Stack spacing={0}>
          <Title order={2}>Connected Accounts</Title>
          <Text color="dimmed" size="sm">
            Connect multiple accounts to your user and sign in with any of them
          </Text>
        </Stack>
        {error && (
          <Alert color="yellow">
            <Stack spacing={4}>
              <Text color="yellow" weight={500}>
                Account not linked
              </Text>
              <Text size="sm" lh={1.2}>
                {`That account is already connected to another Civitai account. If you want to link it to this account, switch accounts and remove it from the other Civitai account.`}
              </Text>
            </Stack>
          </Alert>
        )}

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
                                signIn(provider.id, {
                                  callbackUrl: '/user/account?connect=true#accounts',
                                })
                              }
                            >
                              Connect
                            </Text>
                          ) : canRemoveAccounts ? (
                            <Text
                              variant="link"
                              color="red"
                              style={{ cursor: 'pointer' }}
                              onClick={() => deleteAccount({ id: account.id })}
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
    </Card>
  );
}
