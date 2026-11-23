import { useRouter } from 'next/router';
import { useSyncAccount } from '~/hooks/useSyncAccount';
import { useServerDomains } from '~/providers/AppProvider';

/** The same page (or `path`) on civitai.red, for content this domain will not show. */
export function useRedHref() {
  const router = useRouter();
  const red = useServerDomains().red;
  const syncAccount = useSyncAccount();
  return (path: string = router.asPath) => syncAccount(`//${red}${path}`);
}
