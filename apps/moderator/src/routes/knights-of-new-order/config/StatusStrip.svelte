<script lang="ts">
  import * as Card from '@civitai/ui/components/ui/card/index.js';
  import type { SourcesContext } from '$lib/server/knights/sources-config.service';

  let { context }: { context: SourcesContext } = $props();

  const number = new Intl.NumberFormat('en-US');
  const total = $derived(context.last24h.reduce((sum, row) => sum + row.count, 0));
</script>

<section aria-label="The queue right now" class="grid gap-3 sm:grid-cols-3">
  <Card.Root size="sm" class="px-4">
    <p class="text-xs text-dark-2">Open at the Knight stage</p>
    <p class="text-2xl font-semibold text-dark-0">{number.format(context.openKnightItems)}</p>
  </Card.Root>
  <Card.Root size="sm" class="px-4">
    <p class="text-xs text-dark-2">Waiting on Inquisitors</p>
    <p class="text-2xl font-semibold text-dark-0">{number.format(context.inquisitorQueue)}</p>
  </Card.Root>
  <Card.Root size="sm" class="px-4">
    <p class="text-xs text-dark-2">Enqueued in the last 24 hours</p>
    {#if context.last24h.length === 0}
      <p class="text-sm text-dark-2">Nothing was enqueued.</p>
    {:else}
      <p class="text-2xl font-semibold text-dark-0">{number.format(total)}</p>
      <p class="truncate text-xs text-dark-2" title={context.last24h.map((row) => `${row.source} ${number.format(row.count)}`).join(' · ')}>
        {context.last24h.map((row) => `${row.source} ${number.format(row.count)}`).join(' · ')}
      </p>
    {/if}
  </Card.Root>
</section>
