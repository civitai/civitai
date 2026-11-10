import { countTicketViews } from '$lib/tickets/counts';
import type { Snapshot } from '$lib/tickets/snapshot';

/**
 * Live tickets per view from the stored snapshot. `peek` only reads: this never asks Freshdesk, so a
 * badge cannot cost a build. Without a snapshot, or when the cache cannot be read, there is no count.
 */
export async function peekTicketCounts(
  peek: () => Promise<Snapshot | null>
): Promise<Record<string, number>> {
  try {
    return countTicketViews(await peek());
  } catch (e) {
    console.error('[tickets] sidebar counts could not read the snapshot', e);
    return {};
  }
}
