<script lang="ts">
  import type { Snippet } from 'svelte';
  import TipButton from './TipButton.svelte';
  import { num } from '$lib/format';

  // The bulk-action bar a selectable list floats at the bottom of the screen. It is fixed, but takes
  // its left, right and bottom edges from its nearest `position: relative` ancestor: the content area
  // beside the sidebar on an ordinary page, the pane in a two-pane layout. A container that should
  // bound the bar is marked `relative`; one with `transform` or `filter` breaks the measurement, since
  // it becomes the bar's containing block. Its buttons are `TipButton`s.
  let {
    count,
    onclear,
    clearDisabled = false,
    summary,
    actions,
    children,
  }: {
    count: number;
    onclear: () => void;
    /** Disable Clear while a submit is in flight when the bar holds that submit's error: clearing
     *  unmounts the bar, and the error with it. */
    clearDisabled?: boolean;
    /** Replaces "N selected". */
    summary?: Snippet;
    /** Inline on the bar's row, after Clear. */
    actions?: Snippet;
    /** Rows under the bar's row — errors, confirmations, help. */
    children?: Snippet;
  } = $props();

  let bar = $state<HTMLElement>();
  let box = $state<{ left: number; right: number; bottom: number }>();

  const relativeAncestor = (el: HTMLElement) => {
    for (let p = el.parentElement; p; p = p.parentElement)
      if (getComputedStyle(p).position === 'relative') return p;
    return document.documentElement;
  };

  // Re-measured on resize (the sidebar opening, the window) and on scroll (a container whose bottom
  // is on screen). While open, the bar also adds its height to the container's bottom padding, so the
  // end of the container scrolls clear of it; the padding is restored when the bar closes.
  $effect(() => {
    const el = bar;
    if (!el) return;
    const anchor = relativeAncestor(el);
    const inlinePadding = anchor.style.paddingBottom;
    const basePadding = parseFloat(getComputedStyle(anchor).paddingBottom) || 0;
    const reserve = () => (anchor.style.paddingBottom = `${basePadding + el.offsetHeight}px`);
    reserve();
    const barObserver = new ResizeObserver(reserve);
    barObserver.observe(el);
    const place = () => {
      const r = anchor.getBoundingClientRect();
      box = {
        left: Math.max(0, r.left),
        right: Math.max(0, document.documentElement.clientWidth - r.right),
        bottom: Math.max(0, window.innerHeight - r.bottom),
      };
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(anchor);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      barObserver.disconnect();
      anchor.style.paddingBottom = inlinePadding;
      observer.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  });
</script>

{#if count > 0}
  <div
    bind:this={bar}
    class="fixed z-20 max-h-[70vh] overflow-y-auto border-t border-dark-4 bg-dark-6/95 px-4 py-3 backdrop-blur"
    class:invisible={!box}
    style:left="{box?.left ?? 0}px"
    style:right="{box?.right ?? 0}px"
    style:bottom="{box?.bottom ?? 0}px"
  >
    <div class="mx-auto flex max-w-6xl flex-col gap-2">
      <div class="flex flex-wrap items-center gap-3">
        {#if summary}
          {@render summary()}
        {:else}
          <span class="text-sm font-semibold text-white">{num(count)} selected</span>
        {/if}
        <TipButton
          tip="Untick everything selected. Nothing is changed."
          type="button"
          variant="ghost"
          size="sm"
          onclick={onclear}
          disabled={clearDisabled}
          class="h-auto px-1 py-0 text-xs text-dark-2 hover:text-white"
        >
          Clear
        </TipButton>
        {@render actions?.()}
      </div>
      {@render children?.()}
    </div>
  </div>
{/if}
