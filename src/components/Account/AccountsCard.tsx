import {
  Alert,
  Button,
  Card,
  Group,
  LoadingOverlay,
  Stack,
  Table,
  Text,
  Title,
} from '@mantine/core';
import type { BuiltInProviderType } from 'next-auth/providers/index';
import { getProviders } from 'next-auth/react';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { SocialLabel } from '~/components/Social/SocialLabel';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { handleSignIn } from '~/utils/auth-helpers';
import { trpc } from '~/utils/trpc';

type NextAuthProviders = AsyncReturnType<typeof getProviders>;

export function AccountsCard() {
  const utils = trpc.useUtils();
  const currentUser = useCurrentUser();
  const { error } = useRouter().query;
  const { data: accounts = [] } = trpc.account.getAll.useQuery();

  const [providers, setProviders] = useState<NextAuthProviders | null>(null);
  useEffect(() => {
    if (!providers) getProviders().then((providers) => setProviders(providers));
  }, [providers]);

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
        <Stack gap={0}>
          <Title order={2}>Connected Accounts</Title>
          <Text c="dimmed" size="sm">
            Connect multiple accounts to your user and sign in with any of them
          </Text>
        </Stack>
        {error && (
          <Alert color="yellow">
            <Stack gap={4}>
              <Text c="yellow" fw={500}>
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
          <Table striped withTableBorder>
            <Table.Tbody>
              {Object.values(providers)
                .filter((provider) => provider.type === 'oauth')
                .map((provider) => {
                  const account = accounts.find((account) => account.provider === provider.id);
                  return (
                    <Table.Tr key={provider.id}>
                      <Table.Td>
                        <Group justify="space-between">
                          <SocialLabel
                            key={provider.id}
                            type={provider.id as BuiltInProviderType}
                          />
                          {!account ? (
                            <Button
                              variant="transparent"
                              size="compact-sm"
                              onClick={() =>
                                handleSignIn(provider.id, '/user/account?connect=true#accounts')
                              }
                            >
                              Connect
                            </Button>
                          ) : canRemoveAccounts ? (
                            <Button
                              variant="transparent"
                              size="compact-sm"
                              color="red"
                              onClick={() => deleteAccount({ id: account.id })}
                            >
                              Remove
                            </Button>
                          ) : null}
                        </Group>
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
            </Table.Tbody>
          </Table>
        </div>
      </Stack>
    </Card>
  );
}
