<script lang="ts">
  import { getBrowsingLevelLabel } from '@civitai/shared';
  import MetaChip from '$lib/components/minor-flags/MetaChip.svelte';
  import {
    ESCALATION_REASON_LABELS,
    WRITEBACK_REASON_LABELS,
  } from '$lib/knights/inquisitor-filters';
  import type { InquisitorItem } from '$lib/server/knights/inquisitor.service';

  /** Why an item is here and the state of its image; `detailed` adds what only the open item has room for. */
  let { row, detailed = false }: { row: InquisitorItem; detailed?: boolean } = $props();
</script>

<MetaChip>{detailed ? 'Currently ' : ''}{getBrowsingLevelLabel(row.currentLevel)}</MetaChip>
{#if row.hasBlockMarker}
  <MetaChip tone="red">Blocked{detailed && row.blockedFor ? ` (${row.blockedFor})` : ''}</MetaChip>
{/if}
{#if detailed && row.locked}<MetaChip tone="amber">Rating locked</MetaChip>{/if}
{#if row.escalationReason}
  <MetaChip tone="violet">{ESCALATION_REASON_LABELS[row.escalationReason]}</MetaChip>
{/if}
{#if row.reason}<MetaChip tone="violet">{WRITEBACK_REASON_LABELS[row.reason]}</MetaChip>{/if}
