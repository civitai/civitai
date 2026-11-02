<script lang="ts">
  import { untrack } from 'svelte';

  let {
    label,
    value,
    max,
    note,
    fervor,
    hearts,
    maxHearts,
  }: {
    label: string;
    value: number;
    max: number;
    note?: string;
    fervor?: number;
    hearts: number;
    maxHearts: number;
  } = $props();

  // A smite drains the heart it takes (M5) and a full Watch bursts gold flecks off the bar's end (M6). Both are ambient
  // and only react to a change seen while the page is open, never to the first read.
  const FLECKS = Array.from({ length: 8 }, (_, index) => {
    const angle = (index / 8) * Math.PI * 2;
    const radius = 14 + (index % 2) * 8;
    return { dx: Math.round(Math.cos(angle) * radius), dy: Math.round(Math.sin(angle) * radius) };
  });
  let drained = $state<number | null>(null);
  let burst = $state(0);
  let seenHearts = untrack(() => hearts);
  let seenValue = untrack(() => value);
  let burstId = 0;
  let timers: ReturnType<typeof setTimeout>[] = [];

  $effect(() => {
    const nowHearts = hearts;
    const nowValue = value;
    untrack(() => {
      if (nowHearts < seenHearts) {
        drained = nowHearts;
        timers.push(setTimeout(() => (drained = null), 700));
      }
      if (max > 0 && nowValue >= max && seenValue < max) {
        burst = ++burstId;
        timers.push(setTimeout(() => (burst = 0), 700));
      }
      seenHearts = nowHearts;
      seenValue = nowValue;
    });
  });
  $effect(() => () => timers.forEach(clearTimeout));
</script>

<section class="watch" class:smitten={drained !== null} aria-label="Progress">
  <div class="row">
    <span class="label">{label}</span>
    <span class="right">
      <span class="note">{#if fervor !== undefined}<span class="fervor">Fervor {fervor}&nbsp;·&nbsp;</span>{/if}{#key note}<span class="text">{note ?? ''}</span>{/key}</span>
      <span
        class="hearts"
        role="img"
        aria-label="{hearts} of {maxHearts} hearts left"
        title="Each smite costs a heart. Lose all {maxHearts} and your career resets."
      >
        {#each { length: maxHearts } as _, heart (heart)}
          <span aria-hidden="true" class:lost={heart >= hearts} class:draining={drained === heart}>{heart < hearts ? '♥' : '♡'}</span>
        {/each}
      </span>
    </span>
  </div>
  <div class="trackwrap">
    <div
      class="track"
      role="progressbar"
      aria-label={label}
      aria-valuemin="0"
      aria-valuemax={max}
      aria-valuenow={value}
    >
      <div class="fill" style:width="{max > 0 ? (value / max) * 100 : 0}%"></div>
    </div>
    {#if burst}
      {#key burst}
        <span class="flecks" aria-hidden="true">
          {#each FLECKS as fleck, index (index)}<i style:--dx="{fleck.dx}px" style:--dy="{fleck.dy}px"></i>{/each}
        </span>
      {/key}
    {/if}
  </div>
</section>

<style>
  .watch {
    display: flex;
    flex: none;
    flex-direction: column;
    gap: 8px;
    padding: 16px 28px;
    font-family: var(--io-font-ui);
    font-size: 13px;
  }
  .row {
    display: flex;
    justify-content: space-between;
    gap: 12px;
  }
  .label {
    color: var(--io-parchment);
    font-weight: 600;
  }
  .right {
    display: flex;
    align-items: center;
    gap: 14px;
    color: var(--io-parchment-muted);
  }
  .hearts {
    color: var(--io-crimson-text);
    letter-spacing: 0.15em;
    white-space: nowrap;
  }
  .hearts .lost {
    color: var(--io-parchment-muted);
  }
  .hearts span {
    display: inline-block;
  }
  .hearts .draining {
    animation: mo-heart-drain var(--motion-milestone-min) var(--ease-in-out) both;
  }
  .watch.smitten {
    animation: mo-smite-flash 400ms var(--ease-out-quart);
  }
  .note .text {
    display: inline-block;
    animation: mo-rise-in var(--motion-base) var(--ease-out-quart);
  }
  .trackwrap {
    position: relative;
  }
  .flecks {
    position: absolute;
    top: 50%;
    right: 0;
    width: 0;
    height: 0;
    pointer-events: none;
  }
  .flecks i {
    position: absolute;
    width: 4px;
    height: 4px;
    margin: -2px 0 0 -2px;
    border-radius: 50%;
    background: var(--io-gold);
    animation: mo-fleck var(--motion-milestone-min) var(--ease-out-quart) both;
  }
  .track {
    height: 6px;
    border-radius: 3px;
    background: var(--io-bg);
    overflow: hidden;
  }
  .fill {
    height: 100%;
    border-radius: 3px;
    background: var(--io-gold);
    transition: width 360ms var(--ease-in-out);
  }
  @media (prefers-reduced-motion: reduce) {
    .fill {
      transition-duration: 150ms;
    }
  }
  @media (max-width: 40rem) {
    .watch {
      padding: 10px 16px;
    }
    .fervor {
      display: none;
    }
  }
</style>
