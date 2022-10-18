import { useEffect, useState } from 'react';

/**
 * @see https://usehooks-ts.com/react-hook/use-is-client
 */
function useIsClient() {
  const [isClient, setClient] = useState(false);

  useEffect(() => {
    setClient(true);
  }, []);

  return isClient;
}

export default useIsClient;
