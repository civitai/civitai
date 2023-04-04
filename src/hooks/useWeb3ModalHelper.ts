import { useWeb3Modal } from '@web3modal/react';
import { useCallback, useMemo } from 'react';
import { getDefaultChain } from '~/utils/chain';

export function useWeb3ModalHelper() {
  const { isOpen, open, setDefaultChain } = useWeb3Modal();

  const connectWallet = useCallback(async () => {
    const chain = getDefaultChain();
    setDefaultChain(chain);
    if (isOpen) return;
    await open({ route: 'ConnectWallet' });
  }, [isOpen, open, setDefaultChain]);

  return useMemo(() => ({ connectWallet }), [connectWallet]);
}
