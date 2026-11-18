<script lang="ts">
  import * as Collapsible from '@civitai/ui/components/ui/collapsible/index.js';
  import type { SourcesChange } from '$lib/server/knights/sources-config.service';
  import { changeSummary } from './config-draft';

  let { lastChange }: { lastChange: SourcesChange | null } = $props();

  let open = $state(false);
  const who = (change: SourcesChange) =>
    change.moderatorUsername ?? (change.moderatorId ? `#${change.moderatorId}` : 'unknown');
</script>

{#if lastChange}
  <Collapsible.Root bind:open class="text-xs text-dark-2">
    <Collapsible.Trigger class="cursor-pointer text-left hover:text-dark-0" data-touch-target>
      Recent changes: last changed {lastChange.at.toISOString().slice(0, 16).replace('T', ' ')} UTC by
      {who(lastChange)} · <span class="underline">{open ? 'Hide' : 'Show'} details</span>
    </Collapsible.Trigger>
    <Collapsible.Content>
      <p class="mt-1">{changeSummary(lastChange.before, lastChange.after)}.</p>
    </Collapsible.Content>
  </Collapsible.Root>
{:else}
  <p class="text-xs text-dark-2">No change has been recorded yet.</p>
{/if}
