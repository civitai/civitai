import { Table, Group, Text, LoadingOverlay, Card, Title, Stack } from '@mantine/core';
import { BuiltInProviderType } from 'next-auth/providers';
import { ClientSafeProvider, getProviders, signIn } from 'next-auth/react';
import { Fragment, useCallback, MouseEvent, useMemo } from 'react';
import { useAccount } from 'wagmi';
import { SocialLabel } from '~/components/Social/SocialLabel';
import { useSiweSignMessage } from '~/hooks/useSiweSignMessage';
import { useWeb3ModalHelper } from '~/hooks/useWeb3ModalHelper';
import { shortenIfAddress } from '~/utils/address';
import { trpc } from '~/utils/trpc';

export function AccountsCard({ providers }: { providers: AsyncReturnType<typeof getProviders> }) {
  const utils = trpc.useContext();
  const { data: accounts = [] } = trpc.account.getAll.useQuery();

  const { mutate: deleteAccount, isLoading: deletingAccount } = trpc.account.delete.useMutation({
    onSuccess: async () => {
      await utils.account.invalidate();
    },
  });

  const callbackUrl = useMemo(() => '/user/account', []);
  const { address, isConnected } = useAccount();
  const { connectWallet } = useWeb3ModalHelper();
  const { signMessage } = useSiweSignMessage();

  const handleEthereumConnect = useCallback(async () => {
    if (!address) return;
    const { message, signature } = await signMessage({
      address,
      statement: 'Connect your Ethereum account to the app.',
    });
    await signIn('ethereum', { message: JSON.stringify(message), signature, callbackUrl });
  }, [address, callbackUrl, signMessage]);

  const handleConnect = useCallback(
    async (e: MouseEvent<HTMLDivElement, globalThis.MouseEvent>, provider: ClientSafeProvider) => {
      e.preventDefault();
      if (provider.type === 'oauth') {
        return await signIn(provider.id, { callbackUrl });
      }
      if (provider.type === 'credentials' && provider.id === 'ethereum') {
        if (!isConnected) {
          return await connectWallet();
        }
        return await handleEthereumConnect();
      }
    },
    [callbackUrl, connectWallet, handleEthereumConnect, isConnected]
  );

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
                .filter((provider) => provider.type === 'oauth' || provider.type === 'credentials')
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
                          {account && (
                            <Fragment>
                              <Text size="sm" color="dimmed">
                                {shortenIfAddress(account.providerAccountId)}
                              </Text>
                              {accounts.length > 1 ? (
                                <Text
                                  variant="link"
                                  color="red"
                                  style={{ cursor: 'pointer' }}
                                  onClick={() => deleteAccount({ id: account.id })}
                                >
                                  Remove
                                </Text>
                              ) : (
                                <Text color="dimmed">Connected</Text>
                              )}
                            </Fragment>
                          )}
                          {!account && (
                            <Text
                              variant="link"
                              style={{ cursor: 'pointer' }}
                              onClick={(e) => handleConnect(e, provider)}
                            >
                              Connect
                            </Text>
                          )}
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
