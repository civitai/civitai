import { useEffect, useState, useTransition } from 'react';

/**
 * @see https://usehooks-ts.com/react-hook/use-is-client
 */
function useIsClient() {
  const [isClient, setClient] = useState(false);
  const [, startTransition] = useTransition();

  useEffect(() => {
    startTransition(() => {
      setClient(true);
    });
  }, []);

  return isClient;
}

export default useIsClient;
