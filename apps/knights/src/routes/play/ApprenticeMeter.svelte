<script lang="ts">
  import HeartsRow from '$lib/HeartsRow.svelte';

  let {
    level,
    levelFraction,
    accuracy,
    bar,
    knightLevel,
    answerWindow,
    hearts = null,
    maxHearts = 0,
  }: {
    level: number;
    /** How far through the current level the player is, 0 to 1. */
    levelFraction: number;
    /** Over the player's latest `answerWindow` answers (all of them when there are fewer); null before the first answer. */
    accuracy: number | null;
    bar: number;
    knightLevel: number;
    answerWindow: number;
    /** Lives left; wrong answers cost them. Null hides the row. */
    hearts?: number | null;
    maxHearts?: number;
  } = $props();

  let accuracyPercent = $derived(accuracy === null ? null : Math.floor(accuracy * 100));
  let barPercent = $derived(Math.round(bar * 100));
  let onBar = $derived(accuracy !== null && accuracy >= bar);
  let filled = $derived(Math.min(1, (level - 1 + levelFraction) / Math.max(1, knightLevel - 1)));
</script>

<!-- Standing only: a meter never shows whether the last answer was right. -->
<section class="meter" aria-label="Apprenticeship progress">
  <div class="box">
  <div class="row">
    <span class="cell label">Level {level} of {knightLevel}<span class="long">&nbsp;·&nbsp;Acolyte</span></span>
    {#if hearts !== null}<span class="cell"><HeartsRow {hearts} {maxHearts} /></span>{/if}
    <span
      class="cell accuracy"
      class:good={onBar}
      class:low={accuracy !== null && !onBar}
      title={`Your last ${answerWindow} answers`}
    >
      Accuracy {accuracyPercent === null ? '–' : `${accuracyPercent}%`}&nbsp;·&nbsp;bar {barPercent}%
    </span>
  </div>
  <div
    class="track"
    role="progressbar"
    aria-label="Level {level} of {knightLevel}"
    aria-valuemin="1"
    aria-valuemax={knightLevel}
    aria-valuenow={Math.min(level, knightLevel)}
  >
    <span class="fill" style:width="{filled * 100}%"></span>
  </div>
  </div>
</section>

<style>
  .meter {
    flex: none;
    padding: 8px 28px;
    font: 400 13px/1.2 var(--io-font-ui);
  }
  /* One grouped strip, like the Watch bar Knights get: equal cells split by hairlines, the level track on its bottom edge. */
  .box {
    width: 100%;
    max-width: 1056px;
    margin: 0 auto;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--panel);
    overflow: hidden;
  }
  .row {
    display: flex;
  }
  .cell {
    display: flex;
    flex: 1 1 auto;
    white-space: nowrap;
    align-items: center;
    justify-content: center;
    min-width: 0;
    padding: 7px 8px;
    text-align: center;
  }
  .cell + .cell {
    border-left: 1px solid var(--border);
  }
  .label {
    color: var(--io-parchment);
    font-weight: 500;
  }
  .accuracy {
    color: var(--io-parchment-muted);
    font-weight: 600;
  }
  .accuracy.good {
    color: #7dc4a0;
  }
  .accuracy.low {
    color: #e0a94a;
  }
  .track {
    height: 3px;
    background: var(--io-bg);
  }
  .fill {
    display: block;
    height: 100%;
    background: var(--io-gold);
    transition: width var(--motion-base) var(--ease-out-quart);
  }
  @media (max-width: 40rem) {
    .meter {
      padding: 12px 16px 8px;
      font-size: 12px;
    }
    .long {
      display: none;
    }
  }
</style>
