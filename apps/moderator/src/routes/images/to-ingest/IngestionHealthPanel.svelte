<script lang="ts">
  import { num, shortAge } from '$lib/format';
  import { queueSeverityClass } from '$lib/queue-thresholds';
  import type { PageData } from './$types';

  let { health, stuckMinutes }: { health: PageData['health']; stuckMinutes: number } = $props();

  const breakdown = $derived.by(() => {
    if (!health) return '';
    const parts = [`${num(health.stuckImages)} images`, `${num(health.stuckVideos)} videos`];
    if (health.stuckAudio) parts.push(`${num(health.stuckAudio)} audio`);
    return parts.join(' · ');
  });
</script>

{#snippet tile(value: number, label: string, caption: string, valueClass: string)}
  <div>
    <div class="text-xl font-semibold tabular-nums {valueClass}">{num(value)}</div>
    <div class="text-xs text-dark-2">{label}</div>
    <div class="mt-1 text-xs text-dark-2">{caption}</div>
  </div>
{/snippet}

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h3 class="mb-3 text-sm font-semibold text-white">Scan pipeline</h3>
  {#if !health}
    <p class="text-sm text-red-300">Could not load scan pipeline health.</p>
  {:else}
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
      {@render tile(
        health.stuck,
        `Stuck past ${stuckMinutes} min`,
        breakdown,
        queueSeverityClass('stuckIngestion', health.stuck) ?? 'text-white'
      )}
      {@render tile(
        health.stuckOffQueue,
        'Stuck and off the scan queue',
        'No automatic retry reaches these',
        'text-white'
      )}
      {@render tile(
        health.queueDepth,
        'In the scan queue',
        health.queueOldestAt
          ? `Oldest ${shortAge(health.queueOldestAt)} · retries wait here for hours`
          : 'Empty',
        'text-white'
      )}
    </div>
  {/if}
</section>
