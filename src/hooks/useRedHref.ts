import { useRouter } from 'next/router';
import { useCallback } from 'react';
import { useSyncAccount } from '~/hooks/useSyncAccount';
import { useServerDomains } from '~/providers/AppProvider';

/** The same page (or `path`) on civitai.red, for content this domain will not show. */
export function useRedHref() {
  const { asPath } = useRouter();
  const red = useServerDomains().red;
  const syncAccount = useSyncAccount();
  return useCallback(
    (path: string = asPath) => syncAccount(`//${red}${path}`),
    [asPath, red, syncAccount]
  );
}
