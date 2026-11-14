<script lang="ts">
  import type { SourcesContext } from '$lib/server/knights/sources-config.service';

  let { context }: { context: SourcesContext } = $props();

  const total = $derived(context.last24h.reduce((sum, row) => sum + row.count, 0));
  const number = new Intl.NumberFormat('en-US');
</script>

<section class="rounded-xl border border-dark-4 bg-dark-6 p-5" aria-labelledby="queue-now">
  <h2 id="queue-now" class="mb-3 text-base font-semibold text-white">The queue right now</h2>
  <dl class="grid grid-cols-2 gap-4">
    <div>
      <dt class="text-xs text-dark-2">Open at the Knight stage</dt>
      <dd class="text-2xl font-semibold text-dark-0">{number.format(context.openKnightItems)}</dd>
    </div>
    <div>
      <dt class="text-xs text-dark-2">Waiting on Inquisitors</dt>
      <dd class="text-2xl font-semibold text-dark-0">{number.format(context.inquisitorQueue)}</dd>
    </div>
  </dl>

  <h3 class="mt-5 mb-2 text-sm font-medium text-white">Enqueued in the last 24 hours</h3>
  {#if context.last24h.length === 0}
    <p class="text-sm text-dark-2">Nothing was enqueued.</p>
  {:else}
    <ul class="flex flex-col gap-1 text-sm">
      {#each context.last24h as row (row.source)}
        <li class="flex justify-between gap-4">
          <span class="text-dark-2">{row.source}</span>
          <span class="text-dark-0">{number.format(row.count)}</span>
        </li>
      {/each}
      <li class="flex justify-between gap-4 border-t border-dark-4 pt-1">
        <span class="text-dark-2">Total</span>
        <span class="text-dark-0">{number.format(total)}</span>
      </li>
    </ul>
  {/if}
</section>
