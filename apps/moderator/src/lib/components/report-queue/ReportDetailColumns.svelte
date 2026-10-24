<script lang="ts">
  import type { Snippet } from 'svelte';
  import { cn } from '@civitai/ui/utils.js';

  /**
   * The open item: what is being judged in the middle, under the item's header, and a right sidebar
   * with the report and what to do about it, each scrolling on its own so the actions never leave the
   * screen.
   *
   * The header heads the middle column, not the pane: on a 1080p screen the sidebar is the column
   * that runs out of height.
   *
   * 🔴 Both columns are `relative`. A scrolling box that is not positioned does not contain its
   * absolutely positioned descendants — a form control's hidden input, a badge — so they are laid out
   * against the page instead, and the page scrolls into empty space below the fold.
   */
  let {
    header,
    evidence,
    actions,
    footer,
  }: {
    /** Who or what is open, and anything that applies to the whole item (a read-only notice). */
    header?: Snippet;
    /** Omitted when there is nothing to show — the sidebar then takes the width, under the header. */
    evidence?: Snippet;
    actions: Snippet;
    /** Pinned under the sidebar's scroll, e.g. a decision bar that must stay on screen. */
    footer?: Snippet;
  } = $props();
</script>

{#snippet headerBar()}
  <div class="flex shrink-0 flex-col gap-3 border-b border-dark-4 px-5 py-3">
    {@render header?.()}
  </div>
{/snippet}

{#if header && !evidence}{@render headerBar()}{/if}
<div class="flex flex-col xl:min-h-0 xl:flex-1 xl:flex-row">
  {#if evidence}
    <div class="flex min-w-0 flex-1 flex-col xl:min-h-0">
      {#if header}{@render headerBar()}{/if}
      <div class="relative min-h-0 flex-1 p-5 xl:overflow-y-auto">
        {@render evidence()}
      </div>
    </div>
  {/if}
  <aside
    class={cn(
      'flex min-w-0 flex-col border-t border-dark-4 bg-dark-7 xl:min-h-0 xl:border-t-0',
      evidence ? 'xl:w-[26rem] xl:shrink-0 xl:border-l' : 'xl:flex-1'
    )}
  >
    <div class="relative flex min-h-0 flex-1 flex-col gap-5 p-4 xl:overflow-y-auto">
      {@render actions()}
    </div>
    {#if footer}
      <div class="shrink-0 border-t border-dark-4 bg-dark-6 px-4 py-3">
        {@render footer()}
      </div>
    {/if}
  </aside>
</div>
