<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import type { ChangesState } from './changes';

  let { changes }: { changes: ChangesState } = $props();
</script>

{#if changes.conflict}
  <p class="flex flex-wrap items-center gap-2 text-sm text-red-300">
    Your changes were changed in another tab — reload to see the latest. Edits made here since then are
    not saved.
    <Button size="xs" variant="outline" onclick={() => invalidateAll()}>Reload</Button>
  </p>
{:else if changes.error}
  <p class="text-sm text-red-300">{changes.error}</p>
{:else if changes.saving || changes.dirty}
  <p class="text-xs text-dark-2">Saving…</p>
{:else if changes.keys.length}
  <p class="text-xs text-dark-2">Saved</p>
{/if}
