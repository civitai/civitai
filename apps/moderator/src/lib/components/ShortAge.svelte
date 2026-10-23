<script lang="ts">
  import { dateTime, shortAge } from '$lib/format';

  // `now` is for a caller that ticks: the age is computed once per render, so it only moves when the
  // caller re-renders it with a new `now`.
  let {
    at,
    now,
    title,
    class: className = '',
  }: { at: Date | string; now?: number; title?: string; class?: string } = $props();
</script>

<time datetime={new Date(at).toISOString()} title={title ?? dateTime(at)} class={className}>
  {shortAge(at, now)}
</time>
