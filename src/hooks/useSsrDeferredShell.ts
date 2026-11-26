import { useIsClient } from '~/providers/IsClientProvider';

/**
 * Whether a page in the `ssrSignedInSkipPrefetch*` trials (`~/server/utils/ssr-skip-prefetch`)
 * renders its loading shell: when getServerSideProps gave it `deferredSsr`, on the server and on
 * the hydrating render alike (`useIsClient` is `false` for both), so hydration matches. Once the
 * client has mounted the page renders its content, as it does after a client-side navigation.
 */
export function useSsrDeferredShell(deferredSsr: boolean | undefined) {
  const isClient = useIsClient();
  return !!deferredSsr && !isClient;
}
