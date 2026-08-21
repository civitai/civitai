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
  return (image: { id: number }) => syncAccount(`//${domains.red}/images/${image.id}`);
}
