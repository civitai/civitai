<script lang="ts">
  import FlagBadge from '$lib/components/minor-flags/FlagBadge.svelte';
  import MetaChip from '$lib/components/minor-flags/MetaChip.svelte';
  import { sourceKey } from '$lib/minor-flags/appeal-filters';

  let { row }: { row: { flagSource: string | null; minor: boolean; poi: boolean } } = $props();

  const SOURCE = {
    'text-scan': { tone: 'violet', label: 'text-scan' },
    hash: { tone: 'blue', label: 'hash' },
    moderator: { tone: 'neutral', label: 'moderator' },
    none: { tone: 'neutral', label: 'no flag record' },
  } as const;

  const source = $derived(SOURCE[sourceKey(row.flagSource)]);
</script>

<!-- Labels first, then where the flag came from. -->
{#if row.minor}
  <FlagBadge label="minor" />
{/if}
{#if row.poi}
  <FlagBadge label="poi" />
{/if}
{#if !row.minor && !row.poi}
  <MetaChip tone="green">no longer flagged</MetaChip>
{/if}
<MetaChip tone={source.tone}>{source.label}</MetaChip>
