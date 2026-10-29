<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import { formatWait } from '$lib/format';

  let { until }: { until: string } = $props();
  let now = $state(Date.now());
  let remaining = $derived((new Date(until).getTime() - now) / 1000);

  $effect(() => {
    const target = new Date(until).getTime();
    const timer = setInterval(() => {
      now = Date.now();
      if (now >= target) {
        clearInterval(timer);
        invalidateAll();
      }
    }, 1000);
    return () => clearInterval(timer);
  });
</script>

<section class="lockout" role="status" aria-label="Judging paused">
  <h2>A moment of rest</h2>
  <p>You have been judging faster than the Order can trust. Rest a little; the queue will wait.</p>
  <p class="wait">{formatWait(remaining)}</p>
  <p class="muted">Judging resumes by itself.</p>
</section>

<style>
  .lockout {
    padding: 1rem 1.5rem;
    border: 1px solid var(--border);
    background: var(--panel);
    text-align: center;
  }
  .wait {
    margin: 0.5rem 0;
    color: var(--gold);
    font-size: 1.75rem;
    font-variant-numeric: tabular-nums;
  }
</style>
