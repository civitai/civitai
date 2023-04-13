import { EthereumClient, w3mConnectors, w3mProvider } from '@web3modal/ethereum';
import { Web3Modal } from '@web3modal/react';
import { Fragment } from 'react';
import { configureChains, createClient, WagmiConfig } from 'wagmi';
import { mainnet, goerli } from 'wagmi/chains';
import { env } from '~/env/client.mjs';
import { infuraProvider } from 'wagmi/providers/infura';

export const chains = [mainnet, goerli];
const projectId = env.NEXT_PUBLIC_WALLET_CONNECT_ID;

const { provider } = configureChains(chains, [
  infuraProvider({ apiKey: env.NEXT_PUBLIC_INFURA_API_KEY }),
  w3mProvider({ projectId }),
]);
const wagmiClient = createClient({
  autoConnect: true,
  connectors: w3mConnectors({ projectId, version: 1, chains }),
  provider,
});
const ethereumClient = new EthereumClient(wagmiClient, chains);

export function Web3ModalProvider({ children }: { children: React.ReactNode }) {
  return (
    <Fragment>
      <WagmiConfig client={wagmiClient}>{children}</WagmiConfig>
      <Web3Modal projectId={projectId} ethereumClient={ethereumClient} />
    </Fragment>
  );
}
