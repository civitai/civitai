import { SocialButton } from '../Social/SocialButton';
import { useCallback, MouseEvent, useMemo } from 'react';
import { useAccount } from 'wagmi';
import { signIn } from 'next-auth/react';
import { shortenIfAddress } from '~/utils/address';
import { useWeb3ModalHelper } from '~/hooks/useWeb3ModalHelper';
import { useSiweSignMessage } from '~/hooks/useSiweSignMessage';

type Props = {
  callbackUrl?: string;
};

export const EthereumLogin = ({ callbackUrl }: Props) => {
  const { address, isConnected } = useAccount();
  const { connectWallet } = useWeb3ModalHelper();
  const { signMessage } = useSiweSignMessage();
  const additionalText = useMemo(
    () => (address ? shortenIfAddress(address) : undefined),
    [address]
  );

  const handleEthereumLogin = useCallback(async () => {
    if (!address) return;
    const { message, signature } = await signMessage({
      address,
      statement: 'Sign in with Ethereum to the app.',
    });
    await signIn('ethereum', { message: JSON.stringify(message), signature, callbackUrl });
  }, [address, callbackUrl, signMessage]);

  const handleButtonClick = useCallback(
    async (e: MouseEvent<HTMLButtonElement, globalThis.MouseEvent>) => {
      e.preventDefault();
      if (!isConnected) {
        return await connectWallet();
      }
      return await handleEthereumLogin();
    },
    [connectWallet, handleEthereumLogin, isConnected]
  );

  return (
    <SocialButton
      provider="ethereum"
      additionalText={additionalText}
      onClick={(e) => handleButtonClick(e)}
    />
  );
};
