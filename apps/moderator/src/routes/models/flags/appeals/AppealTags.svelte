<script lang="ts">
  import FlagBadge from '$lib/components/minor-flags/FlagBadge.svelte';
  import MetaChip from '$lib/components/minor-flags/MetaChip.svelte';
  import { sourceKey } from '$lib/minor-flags/appeal-filters';

  let {
    row,
    size = 'sm',
  }: {
    row: { flagSource: string | null; minor: boolean; poi: boolean };
    size?: 'sm' | 'md';
  } = $props();

  const SOURCE = {
    'text-scan': { tone: 'violet', label: 'text-scan' },
    hash: { tone: 'blue', label: 'hash' },
    moderator: { tone: 'neutral', label: 'moderator' },
    none: { tone: 'neutral', label: 'no flag record' },
  } as const;

  const source = $derived(SOURCE[sourceKey(row.flagSource)]);
</script>

<MetaChip {size} tone={source.tone}>{source.label}</MetaChip>
{#if row.minor}
  <FlagBadge label="minor" {size} />
{/if}
{#if row.poi}
  <FlagBadge label="poi" {size} />
{/if}
{#if !row.minor && !row.poi}
  <MetaChip {size} tone="green">no longer flagged</MetaChip>
{/if}
