import { Table, Group, Text, LoadingOverlay, Card, Title, Stack } from '@mantine/core';
import { BuiltInProviderType } from 'next-auth/providers';
import { getProviders, signIn } from 'next-auth/react';
import { SocialLabel } from '~/components/Social/SocialLabel';
import { trpc } from '~/utils/trpc';

export function AccountsCard({ providers }: { providers: AsyncReturnType<typeof getProviders> }) {
  const utils = trpc.useContext();
  const { data: accounts = [] } = trpc.account.getAll.useQuery();

  const { mutate: deleteAccount, isLoading: deletingAccount } = trpc.account.delete.useMutation({
    onSuccess: async () => {
      await utils.account.invalidate();
    },
  });

  if (!providers) return null;

  return (
    <Card withBorder>
      <Stack>
        <Stack spacing={0}>
          <Title order={2}>Connected Accounts</Title>
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
                              onClick={() => signIn(provider.id, { callbackUrl: '/user/account' })}
                            >
                              Connect
                            </Text>
                          ) : accounts.length > 1 ? (
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
