<script lang="ts">
  import MetaChip from '$lib/components/minor-flags/MetaChip.svelte';
  import type { CrossTabChip } from '$lib/minor-flags/cross-tab';

  let {
    chips,
    linked = false,
    tone,
  }: {
    chips: CrossTabChip[];
    /** One tone for every chip, in place of each tab's own: a detail header marks them all amber, as
     *  a ruling there also settles the model in those tabs. */
    tone?: CrossTabChip['tone'];
    /** Link each chip the viewer can open. Off inside a list row, which is itself a link. */
    linked?: boolean;
  } = $props();
</script>

{#each chips as chip (chip.label)}
  {#if linked && chip.href}
    <a href={chip.href} class="inline-flex hover:opacity-80" title="Open this model there">
      <MetaChip tone={tone ?? chip.tone}>{chip.label}</MetaChip>
    </a>
  {:else}
    <MetaChip tone={tone ?? chip.tone}>{chip.label}</MetaChip>
  {/if}
{/each}
