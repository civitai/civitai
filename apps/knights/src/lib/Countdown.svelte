<script lang="ts">
  import { invalidate } from '$app/navigation';
  import { formatWait } from '$lib/format';

  /** `seconds` is the server's remaining time, so the browser clock cannot skew it. */
  let { seconds, label }: { seconds: number; label: string } = $props();
  let remaining = $state(0);

  // Past zero the server may still say wait; keep asking until the parent stops rendering this.
  $effect(() => {
    const endsAt = performance.now() + seconds * 1000;
    remaining = seconds;
    const timer = setInterval(() => {
      remaining = (endsAt - performance.now()) / 1000;
      if (remaining <= 0) invalidate('app:play');
    }, 1000);
    return () => clearInterval(timer);
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
