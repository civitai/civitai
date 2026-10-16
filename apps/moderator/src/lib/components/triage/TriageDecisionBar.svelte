<script lang="ts">
  import type { Snippet } from 'svelte';

  /** The action area of a detail pane: the decision buttons, then the reason line, then a hint. */
  let {
    buttons,
    fields,
    hint,
  }: {
    buttons: Snippet;
    /** The second line, normally the form that carries the reason, the note and the confirm button. */
    fields?: Snippet;
    hint?: string;
  } = $props();
</script>

<div class="grid w-full gap-2.5">
  <div class="flex flex-wrap items-center gap-2.5">{@render buttons()}</div>
  {@render fields?.()}
  {#if hint}<p class="m-0 text-xs text-dark-2">{hint}</p>{/if}
</div>
