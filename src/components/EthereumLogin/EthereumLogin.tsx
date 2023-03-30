import { useWeb3Modal } from '@web3modal/react';
import { SocialButton } from '../Social/SocialButton';
import { useCallback, MouseEvent, useMemo } from 'react';
import { useAccount, useNetwork, useSignMessage } from 'wagmi';
import { getCsrfToken, signIn } from 'next-auth/react';
import { SiweMessage } from 'siwe';
import { shortenIfAddress } from '~/utils/address';
import { getDefaultChain } from '~/utils/chain';

type Props = {
  callbackUrl?: string;
};

export const EthereumLogin = ({ callbackUrl }: Props) => {
  const { isOpen, open, setDefaultChain } = useWeb3Modal();
  const { signMessageAsync } = useSignMessage();
  const { chain } = useNetwork();
  const { address, isConnected } = useAccount();
  const additionalText = useMemo(
    () => (address ? shortenIfAddress(address) : undefined),
    [address]
  );

  const handleConnect = useCallback(async () => {
    const chain = getDefaultChain();
    setDefaultChain(chain);
    if (isOpen) return;
    await open({ route: 'ConnectWallet' });
  }, [isOpen, open, setDefaultChain]);

  const handleEthereumLogin = useCallback(async () => {
    const message = new SiweMessage({
      domain: window.location.host,
      address: address,
      statement: 'Sign in with Ethereum to the app.',
      uri: window.location.origin,
      version: '1',
      chainId: chain?.id,
      nonce: await getCsrfToken(),
    });
    const signature = await signMessageAsync({
      message: message.prepareMessage(),
    });
    signIn('credentials', { message: JSON.stringify(message), signature, callbackUrl });
  }, [address, callbackUrl, chain?.id, signMessageAsync]);

  const handleButtonClick = useCallback(
    async (e: MouseEvent<HTMLButtonElement, globalThis.MouseEvent>) => {
      e.preventDefault();
      if (!isConnected) {
        return await handleConnect();
      }
      return await handleEthereumLogin();
    },
    [handleConnect, handleEthereumLogin, isConnected]
  );

  return (
    <SocialButton
      provider="ethereum"
      additionalText={additionalText}
      onClick={(e) => handleButtonClick(e)}
    />
  );
};
