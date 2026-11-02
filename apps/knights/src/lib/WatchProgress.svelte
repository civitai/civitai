<script lang="ts">
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
</script>

<section class="watch" aria-label="Progress">
  <div class="row">
    <span class="label">{label}</span>
    <span class="right">
      <span class="note">{#if fervor !== undefined}<span class="fervor">Fervor {fervor}&nbsp;·&nbsp;</span>{/if}{note ?? ''}</span>
      <span
        class="hearts"
        role="img"
        aria-label="{hearts} of {maxHearts} hearts left"
        title="Each smite costs a heart. Lose all {maxHearts} and your career resets."
      >
        {#each { length: maxHearts } as _, heart (heart)}
          <span aria-hidden="true" class:lost={heart >= hearts}>{heart < hearts ? '♥' : '♡'}</span>
        {/each}
      </span>
    </span>
  </div>
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
    transition: width var(--motion-base) var(--ease-out-quart);
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
