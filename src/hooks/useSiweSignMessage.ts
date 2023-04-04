import { getCsrfToken } from 'next-auth/react';
import { useCallback, useMemo } from 'react';
import { SiweMessage } from 'siwe';
import { useNetwork, useSignMessage } from 'wagmi';

export function useSiweSignMessage() {
  const { chain } = useNetwork();
  const { signMessageAsync } = useSignMessage();

  const signMessage = useCallback(
    async ({ address, statement }: Required<Pick<SiweMessage, 'address' | 'statement'>>) => {
      const nonce = await getCsrfToken();
      const message = new SiweMessage({
        address,
        statement,
        nonce,
        domain: window.location.host,
        uri: window.location.origin,
        version: '1',
        chainId: chain?.id,
      });
      const signature = await signMessageAsync({
        message: message.prepareMessage(),
      });

      return { message, signature };
    },
    [chain?.id, signMessageAsync]
  );

  return useMemo(() => ({ signMessage }), [signMessage]);
}
