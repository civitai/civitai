<script lang="ts">
  import { untrack } from 'svelte';
  import { bump } from './motion';
  import { sound } from './sound';

  let { label, value, max }: { label: string; value: number; max: number } = $props();

  // The 3px line under the header. A full Watch rings the bell once, for a change seen while the page is open and never for
  // the first read.
  let done = $state(false);
  let seen = untrack(() => value);
  let timer: ReturnType<typeof setTimeout> | undefined;

  $effect(() => {
    const now = value;
    untrack(() => {
      if (max > 0 && now >= max && seen < max) {
        sound.play('bell');
        done = true;
        clearTimeout(timer);
        timer = setTimeout(() => (done = false), 900);
      }
      seen = now;
    });
  });
  $effect(() => () => clearTimeout(timer));
</script>

<div
  class="hairline"
  class:done
  role="progressbar"
  aria-label={label}
  aria-valuemin="0"
  aria-valuemax={max}
  aria-valuenow={value}
>
  <div class="fill" use:bump={value} style:width="{max > 0 ? (value / max) * 100 : 0}%"></div>
</div>

<style>
  .hairline {
    flex: none;
    height: 3px;
    background: var(--io-matte);
  }
  .fill {
    height: 100%;
    background: var(--io-gold);
    transition: width 360ms var(--ease-in-out);
  }
  .done .fill {
    box-shadow: 0 0 10px rgb(201 162 74 / 0.8);
  }
  @media (prefers-reduced-motion: no-preference) {
    .fill:global([data-bump]) {
      animation: mo-bump-glow 400ms var(--ease-out-quart);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .fill {
      transition-duration: 150ms;
    }
  }
</style>
