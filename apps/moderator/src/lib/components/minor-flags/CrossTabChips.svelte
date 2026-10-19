<script lang="ts">
  import MetaChip from '$lib/components/minor-flags/MetaChip.svelte';
  import type { CrossTabChip } from '$lib/minor-flags/cross-tab';

  let {
    chips,
    linked = false,
  }: {
    chips: CrossTabChip[];
    /** Link each chip the viewer can open. Off inside a list row, which is itself a link. */
    linked?: boolean;
  } = $props();
</script>

{#each chips as chip (chip.label)}
  {#if linked && chip.href}
    <a href={chip.href} class="inline-flex hover:opacity-80" title="Open this model there">
      <MetaChip tone={chip.tone}>{chip.label}</MetaChip>
    </a>
  {:else}
    <MetaChip tone={chip.tone}>{chip.label}</MetaChip>
  {/if}
{/each}
