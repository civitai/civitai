<script lang="ts">
  import { invalidate } from '$app/navigation';
  import { formatClock, formatWait } from '$lib/format';
  import { revalidateUntilStopped } from '$lib/revalidate';

  /** `seconds` is the server's remaining time, so the browser clock cannot skew it. */
  let { seconds, label, clock = false }: { seconds: number; label: string; clock?: boolean } = $props();
  // Null until the effect runs, so the server render and first paint show `seconds`, not 0.
  let remaining = $state<number | null>(null);

  // At zero, ask the server again, one request at a time, until it stops rendering this component.
  $effect(() => {
    const endsAt = performance.now() + seconds * 1000;
    remaining = seconds;
    let asking: AbortController | undefined;
    const timer = setInterval(() => {
      remaining = (endsAt - performance.now()) / 1000;
      if (remaining > 0 || asking) return;
      asking = new AbortController();
      void revalidateUntilStopped(() => invalidate('app:play'), { signal: asking.signal });
    }, 1000);
    return () => {
      clearInterval(timer);
      asking?.abort();
    };
  });
</script>

<p class="countdown" class:clock role="timer" aria-label={label}>
  {clock ? formatClock(remaining ?? seconds) : formatWait(remaining ?? seconds)}
</p>

<style>
  .countdown {
    margin: 0.5rem 0;
    color: var(--gold);
    font-size: 1.75rem;
    font-variant-numeric: tabular-nums;
    text-align: center;
  }
  .countdown.clock {
    color: var(--io-parchment);
    font: 700 56px/1.1 var(--io-font-display);
    letter-spacing: 0.02em;
  }
  @media (max-width: 40rem) {
    .countdown.clock {
      font-size: 44px;
    }
  }
</style>
