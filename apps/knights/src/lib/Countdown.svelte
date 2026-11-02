<script lang="ts">
  import { invalidate } from '$app/navigation';
  import { formatWait } from '$lib/format';
  import { revalidateUntilStopped } from '$lib/revalidate';

  /** `seconds` is the server's remaining time, so the browser clock cannot skew it. */
  let { seconds, label }: { seconds: number; label: string } = $props();
  let remaining = $state(0);

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

<p class="countdown" role="timer" aria-label={label}>{formatWait(remaining)}</p>

<style>
  .countdown {
    margin: 0.5rem 0;
    color: var(--gold);
    font-size: 1.75rem;
    font-variant-numeric: tabular-nums;
    text-align: center;
  }
</style>
