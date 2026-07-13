import { SvelteMap } from 'svelte/reactivity';

/**
 * Reusable, list-oriented multi-select with Gmail-style shift-click range selection.
 * A Svelte 5 port of the main app's `createSelectionStore`
 * (civitai `src/store/createSelectionStore.ts`, used by the generation Queue).
 *
 * `selected` is a reactive `SvelteMap`, so `count`, `isSelected(item)`, and `values()`
 * read inside components / `$derived` stay live — and because `SvelteMap` tracks reads
 * per-key, toggling one row only invalidates the things that read that row (the
 * targeted-update behavior the React version got from per-slice selector hooks).
 *
 * Shift ranges resolve within a *registered group* (see {@link registerOrder}), so a
 * range never bridges across separate grids.
 *
 * ```svelte
 * <script lang="ts">
 *   import { SelectionStore } from '$lib/selection.svelte';
 *   let { rows }: { rows: Row[] } = $props();
 *   const selection = new SelectionStore<Row>((r) => String(r.id));
 *   // Register the ordered, *selectable* items so shift-ranges resolve. In an $effect so
 *   // it re-registers when the list changes; exclude items the user can't select.
 *   $effect(() => {
 *     selection.registerOrder('grid', rows);
 *     return () => selection.unregisterOrder('grid');
 *   });
 * </script>
 *
 * {#each rows as row (row.id)}
 *   <!-- Capture shiftKey from the MOUSE event (onclick), not onchange — change events
 *        don't carry modifier keys. On click the checkbox has already toggled, so
 *        currentTarget.checked is the new value. -->
 *   <input
 *     type="checkbox"
 *     checked={selection.isSelected(row)}
 *     onclick={(e) => selection.select(row, { shiftKey: e.shiftKey, checked: e.currentTarget.checked })}
 *   />
 * {/each}
 * <p>{selection.count} selected</p>
 * ```
 */
export class SelectionStore<T> {
  readonly #getKey: (item: T) => string;
  /** Reactive map of selected items, keyed by `getKey`. */
  readonly selected = new SvelteMap<string, T>();
  /** Ordered item lists per group; drives shift-range resolution. Not reactive. */
  readonly #orders = new Map<string, T[]>();
  /** Key of the last clicked item (plain or shift) — the anchor for range selection. */
  #anchorKey: string | null = null;

  constructor(getKey: (item: T) => string) {
    this.#getKey = getKey;
  }

  /** Reactive count of selected items. */
  get count(): number {
    return this.selected.size;
  }

  /** Reactive: is anything selected? */
  get isSelecting(): boolean {
    return this.selected.size > 0;
  }

  /** Reactive: is this item currently selected? */
  isSelected(item: T): boolean {
    return this.selected.has(this.#getKey(item));
  }

  /** Snapshot array of the selected items. */
  values(): T[] {
    return [...this.selected.values()];
  }

  /** Snapshot array of the selected keys. */
  keys(): string[] {
    return [...this.selected.keys()];
  }

  /** Toggle one item and make it the range-select anchor. */
  toggle(item: T, value?: boolean): void {
    const key = this.#getKey(item);
    const isSelected = this.selected.has(key);
    const next = value ?? !isSelected;
    if (next !== isSelected) {
      if (next) this.selected.set(key, item);
      else this.selected.delete(key);
    }
    this.#anchorKey = key;
  }

  /**
   * Toggle `item` with shift-click range support (Gmail-style range toggle). On a
   * shift-click the range between the anchor and `item` (inclusive) toggles as a unit:
   * if every item in it is already selected the whole range is deselected, otherwise the
   * whole range is selected. Falls back to {@link toggle} with no shift / no anchor / no
   * common group. `item` becomes the new anchor so consecutive shift-clicks chain.
   */
  select(item: T, { shiftKey, checked }: { shiftKey: boolean; checked: boolean }): void {
    const targetKey = this.#getKey(item);

    if (shiftKey && this.#anchorKey && this.#anchorKey !== targetKey) {
      for (const list of this.#orders.values()) {
        const anchorIndex = list.findIndex((x) => this.#getKey(x) === this.#anchorKey);
        const targetIndex = list.findIndex((x) => this.#getKey(x) === targetKey);
        if (anchorIndex !== -1 && targetIndex !== -1) {
          const [start, end] =
            anchorIndex < targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
          const range = list.slice(start, end + 1);
          const allSelected = range.every((r) => this.selected.has(this.#getKey(r)));
          for (const r of range) {
            const rKey = this.#getKey(r);
            if (allSelected) this.selected.delete(rKey);
            else this.selected.set(rKey, r);
          }
          this.#anchorKey = targetKey;
          return;
        }
      }
    }

    this.toggle(item, checked);
  }

  /** Add or remove many items at once. Programmatic — does not move the anchor. */
  selectMany(items: T[], value: boolean): void {
    for (const item of items) {
      const key = this.#getKey(item);
      if (value) this.selected.set(key, item);
      else this.selected.delete(key);
    }
  }

  /** Replace the entire selection. Clears the anchor. */
  setSelected(items: T[]): void {
    this.selected.clear();
    for (const item of items) this.selected.set(this.#getKey(item), item);
    this.#anchorKey = null;
  }

  /** Clear the selection and anchor. */
  clear(): void {
    this.selected.clear();
    this.#anchorKey = null;
  }

  /** Register a grid's ordered (selectable) items under `groupId` (drives range resolution). */
  registerOrder(groupId: string, items: T[]): void {
    this.#orders.set(groupId, items);
  }

  /** Remove a previously registered group. */
  unregisterOrder(groupId: string): void {
    this.#orders.delete(groupId);
  }
}
