<script lang="ts">
  import { untrack } from 'svelte';

  let { hearts, maxHearts }: { hearts: number; maxHearts: number } = $props();

  // A smite drains the heart it takes and flashes the row. Ambient, and only for a change seen while the page is open.
  let drained = $state<number | null>(null);
  let seen = untrack(() => hearts);
  let timer: ReturnType<typeof setTimeout> | undefined;

  $effect(() => {
    const now = hearts;
    untrack(() => {
      if (now < seen) {
        drained = now;
        clearTimeout(timer);
        timer = setTimeout(() => (drained = null), 700);
      }
      seen = now;
    });
  });
  $effect(() => () => clearTimeout(timer));
</script>

<span
  class="hearts"
  class:smitten={drained !== null}
  role="img"
  aria-label="{hearts} of {maxHearts} hearts left"
  title="Each smite costs a heart. Lose all {maxHearts} and your career resets."
>
  {#each { length: maxHearts } as _, heart (heart)}
    <span aria-hidden="true" class:lost={heart >= hearts} class:draining={drained === heart}>{heart < hearts ? '♥' : '♡'}</span>
  {/each}
</span>

<style>
  .hearts {
    color: var(--io-crimson-text);
    letter-spacing: 0.15em;
    white-space: nowrap;
  }
  .lost {
    color: var(--io-parchment-muted);
  }
  .hearts span {
    display: inline-block;
  }
  .draining {
    animation: mo-heart-drain var(--motion-milestone-min) var(--ease-in-out) both;
  }
  .smitten {
    animation: mo-smite-flash 400ms var(--ease-out-quart);
  }
</style>
