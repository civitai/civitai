<script lang="ts">
  import { IconCircleDashed } from '@tabler/icons-svelte';
  import MetaChip from '$lib/components/minor-flags/MetaChip.svelte';

  /** Whether the flag is enforced now: what separates Auto-flagged from Needs review. */
  let { applied }: { applied: boolean } = $props();
</script>

{#if applied}
  <MetaChip tone="red" solid>flag applied</MetaChip>
{:else}
  <MetaChip>
    <span class="inline-flex items-center gap-1">
      <IconCircleDashed class="size-3" aria-hidden="true" /> not applied
    </span>
  </MetaChip>
{/if}
