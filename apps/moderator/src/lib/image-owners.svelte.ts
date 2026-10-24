import { SvelteMap } from 'svelte/reactivity';

export type ImageOwner = { id: number; username: string | null; bannedAt: Date | null };

/**
 * Who owns each image seen, folded in page by page, so the strike box can name every account a
 * selection spanning pages reaches.
 */
export class ImageOwners {
  #ownerOf = new SvelteMap<string | number, number>();
  #owners = new SvelteMap<number, Omit<ImageOwner, 'id'>>();

  absorb(items: { id: string | number; userId: number }[], owners: ImageOwner[] = []) {
    for (const i of items) this.#ownerOf.set(i.id, i.userId);
    for (const o of owners) this.#owners.set(o.id, { username: o.username, bannedAt: o.bannedAt });
  }

  clear() {
    this.#ownerOf.clear();
    this.#owners.clear();
  }

  /** The distinct owners of `ids`, named where a page has told us the name. */
  of(ids: Iterable<string | number>): ImageOwner[] {
    const seen = new Set<number>();
    const out: ImageOwner[] = [];
    for (const id of ids) {
      const userId = this.#ownerOf.get(id);
      if (userId == null || seen.has(userId)) continue;
      seen.add(userId);
      out.push({ id: userId, ...(this.#owners.get(userId) ?? { username: null, bannedAt: null }) });
    }
    return out;
  }
}
