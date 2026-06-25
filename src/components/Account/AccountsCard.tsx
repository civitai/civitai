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
import { useRouter } from 'next/router';
import {
  IconBrandDiscord,
  IconBrandGithub,
  IconBrandGoogle,
  IconBrandReddit,
} from '@tabler/icons-react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useAppContext } from '~/providers/AppProvider';
import { trpc } from '~/utils/trpc';

// OAuth providers shown in the connected-accounts list (id → display name + brand icon). This is main-app
// account-management presentation; the hub owns the actual login providers (and their OAuth config) separately.
const oauthProviderMeta = {
  discord: { name: 'Discord', Icon: IconBrandDiscord },
  github: { name: 'GitHub', Icon: IconBrandGithub },
  google: { name: 'Google', Icon: IconBrandGoogle },
  reddit: { name: 'Reddit', Icon: IconBrandReddit },
} as const;
type OAuthProviderId = keyof typeof oauthProviderMeta;

// Start the hub's account-LINKING flow via the MAIN SERVER: /api/auth/connect builds the hub link URL with the
// server's AUTH_JWT_ISSUER (no client-side hub env var) and 302s to it. The hub gates on the active session,
// runs the OAuth, attaches the provider to the CURRENT user, and returns to /user/account#accounts (with
// ?error=AccountNotLinked when that identity already belongs to another account).
function connectAccount(providerId: string) {
  if (typeof window === 'undefined') return;
  const returnUrl = '/user/account#accounts';
  window.location.href = `/api/auth/connect?provider=${encodeURIComponent(
    providerId
  )}&returnUrl=${encodeURIComponent(returnUrl)}`;
}

export function AccountsCard() {
  const utils = trpc.useUtils();
  const currentUser = useCurrentUser();
  const { error } = useRouter().query;
  const { availableOAuthProviders } = useAppContext();
  const { data: accounts = [] } = trpc.account.getAll.useQuery();

  const { mutate: deleteAccount, isPending: deletingAccount } = trpc.account.delete.useMutation({
    onSuccess: async () => {
      await utils.account.invalidate();
    },
  });

  const oauthProviders = (Object.keys(oauthProviderMeta) as OAuthProviderId[]).filter((id) =>
    availableOAuthProviders.includes(id)
  );
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
              {oauthProviders.map((id) => {
                const { name, Icon } = oauthProviderMeta[id];
                const account = accounts.find((account) => account.provider === id);
                return (
                  <Table.Tr key={id}>
                    <Table.Td>
                      <Group justify="space-between">
                        <Group gap="xs">
                          <Icon size={16} />
                          {name}
                        </Group>
                        {!account ? (
                          <Button
                            variant="transparent"
                            size="compact-sm"
                            onClick={() => connectAccount(id)}
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
