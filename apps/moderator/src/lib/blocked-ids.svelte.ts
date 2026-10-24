import { SvelteSet } from 'svelte/reactivity';

/**
 * The image ids known to be blocked, folded in one page at a time so a selection that spans pages
 * can still be warned about its unblocked ids. An id's latest page wins.
 */
export class BlockedIds extends SvelteSet<string | number> {
  absorb(items: { id: string | number; ingestion?: string | null }[]) {
    for (const i of items) {
      if (i.ingestion === 'Blocked') this.add(i.id);
      else this.delete(i.id);
    }
  }
}
