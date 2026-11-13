<script lang="ts">
  import { dateTime, shortAge } from '$lib/format';

  // `now` lets a ticking caller (minuteClock) re-age the label; without it the age is fixed at render.
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
