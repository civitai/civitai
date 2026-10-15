<script lang="ts">
  import type { Snippet } from 'svelte';

  /**
   * The open item's two columns, under its header: what is being judged on the left, the report and
   * what to do about it on the right, each scrolling on its own so the actions never leave the screen.
   *
   * 🔴 Both columns are `relative`. A scrolling box that is not positioned does not contain its
   * absolutely positioned descendants — a form control's hidden input, a badge — so they are laid out
   * against the page instead, and the page scrolls into empty space below the fold.
   */
  let {
    evidence,
    actions,
  }: {
    /** Omitted when there is nothing to show — the actions column then takes the width. */
    evidence?: Snippet;
    actions: Snippet;
  } = $props();
</script>

<div class="flex flex-col gap-4 xl:min-h-0 xl:flex-1 xl:flex-row">
  {#if evidence}
    <div class="relative min-w-0 flex-1 rounded-xl border p-4 xl:overflow-y-auto">
      {@render evidence()}
    </div>
  {/if}
  <div
    class="relative flex min-w-0 flex-col gap-5 rounded-xl border p-4 xl:w-[26rem] xl:shrink-0 xl:overflow-y-auto"
  >
    {@render actions()}
  </div>
</div>
