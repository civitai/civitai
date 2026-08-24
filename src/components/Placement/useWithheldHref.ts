import { useServerDomains } from '~/providers/AppProvider';
import { syncAccount } from '~/utils/sync-account';

/**
 * Where to send someone whose domain will not serve an image.
 *
 * Both review queues keep a row whose asset was withheld — the escrow behind it
 * expires either way — and this is the only route left to the picture itself,
 * since no asset was sent to reveal. Shared because the two pages had it
 * character-for-character twice, and the copy that gets fixed when the domain or
 * the route moves would be whichever one the fixer had open.
 */
export function useWithheldHref() {
  const domains = useServerDomains();
  /**
   * `search` is opt-in and empty by default: the remix queue has nothing to add,
   * and a param baked in here would ride onto its links too. It goes on before
   * `syncAccount`, whose `stringifyUrl` merges rather than replaces the query,
   * so both params survive the cross-domain hop.
   */
  return (image: { id: number }, search = '') =>
    syncAccount(`//${domains.red}/images/${image.id}${search}`);
}
