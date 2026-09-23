import { SvelteSet } from 'svelte/reactivity';

/**
 * A reactive set of selected keys with Gmail's shift-click. A plain toggle flips one key and makes it
 * the anchor. A shift toggle flips the clicked key and gives every key from the anchor to it that
 * same new state, then makes it the anchor.
 */
export class SelectionSet<K> extends SvelteSet<K> {
  #anchor: K | null = null;

  /** `order` is what the user is looking at; an anchor outside it (a previous page) falls back to a
   *  plain toggle rather than selecting rows the user cannot see. */
  toggle(key: K, order: readonly K[], shiftKey: boolean) {
    const selecting = !this.has(key);
    const anchor = this.#anchor;
    if (shiftKey && anchor !== null && anchor !== key) {
      const from = order.indexOf(anchor);
      const to = order.indexOf(key);
      if (from !== -1 && to !== -1) {
        for (const k of order.slice(Math.min(from, to), Math.max(from, to) + 1)) {
          if (selecting) this.add(k);
          else this.delete(k);
        }
        this.#anchor = key;
        return;
      }
    }

    if (selecting) this.add(key);
    else this.delete(key);
    this.#anchor = key;
  }

  clear() {
    super.clear();
    this.#anchor = null;
  }
}

/** For `onmousedown`: a shift-click otherwise also starts a text selection across the list. */
export function suppressShiftSelection(event: MouseEvent) {
  if (event.shiftKey) event.preventDefault();
}
