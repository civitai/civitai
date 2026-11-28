import { SvelteSet } from 'svelte/reactivity';

/** Covers removed from a song card on this page, so every card showing one drops to the placeholder
 *  (`shownCover`) without reading its details again. Cleared by a full page load. */
export const removedCovers = new SvelteSet<number>();
