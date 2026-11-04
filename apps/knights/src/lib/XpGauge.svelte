<script lang="ts">
  let {
    level,
    fraction,
    size = 30,
    intro = false,
  }: {
    level: number;
    /** 0..1, the share of the current level earned. */
    fraction: number;
    size?: number;
    /** Fills from empty once when it first shows. */
    intro?: boolean;
  } = $props();

  // The ring is drawn with `pathLength` 100, so the dash offset is the empty share of the ring in percent.
  const offset = $derived(100 - Math.min(1, Math.max(0, fraction)) * 100);
</script>

<span class="gauge" style:--gauge-size="{size}px">
  <svg viewBox="0 0 36 36" aria-hidden="true" focusable="false">
    <circle class="track" cx="18" cy="18" r="15.5" />
    <circle
      class="fill"
      class:intro
      cx="18"
      cy="18"
      r="15.5"
      pathLength="100"
      stroke-dasharray="100"
      stroke-dashoffset={offset}
    />
  </svg>
  <span class="level">{level}</span>
</span>

<style>
  .gauge {
    position: relative;
    display: inline-grid;
    flex: none;
    place-items: center;
    width: var(--gauge-size);
    height: var(--gauge-size);
  }
  svg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    transform: rotate(-90deg);
  }
  circle {
    fill: none;
    stroke-width: 3;
  }
  .track {
    stroke: var(--io-gold-muted);
    opacity: 0.55;
  }
  .fill {
    stroke: var(--io-gold);
    transition: stroke-dashoffset 600ms var(--ease-in-out);
  }
  .fill.intro {
    animation: mo-gauge-fill 900ms var(--ease-out-quart) both;
  }
  .level {
    position: relative;
    color: var(--io-parchment);
    font: 700 calc(var(--gauge-size) * 0.38) / 1 var(--io-font-ui);
  }
  @media (prefers-reduced-motion: reduce) {
    .fill {
      transition: none;
    }
    .fill.intro {
      animation: none;
    }
  }
</style>
