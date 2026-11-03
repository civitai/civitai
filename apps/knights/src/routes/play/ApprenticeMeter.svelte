<script lang="ts">
  let {
    level,
    levelFraction,
    accuracy,
    bar,
    knightLevel,
  }: {
    level: number;
    /** How far through the current level the player is, 0 to 1. */
    levelFraction: number;
    /** Over the player's last 100 answers (all of them when there are fewer); null before the first answer. */
    accuracy: number | null;
    bar: number;
    knightLevel: number;
  } = $props();

  let accuracyPercent = $derived(accuracy === null ? null : Math.floor(accuracy * 100));
  let barPercent = $derived(Math.round(bar * 100));
  let onBar = $derived(accuracy !== null && accuracy >= bar);
  // The track fills as levels are climbed, and is full at the level that makes a Knight.
  let filled = $derived(Math.min(1, (level - 1 + levelFraction) / Math.max(1, knightLevel - 1)));
</script>

<!-- Standing only: a meter never shows whether the last answer was right. -->
<section class="meter" aria-label="Apprenticeship progress">
  <div class="row">
    <span class="label">Level {level} of {knightLevel}<span class="long">&nbsp;·&nbsp;Apprentice</span></span>
    <span
      class="accuracy"
      class:good={onBar}
      class:low={accuracy !== null && !onBar}
      title="Your last 100 answers"
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
</section>

<style>
  .meter {
    display: flex;
    flex: none;
    flex-direction: column;
    gap: 10px;
    padding: 16px 28px 8px;
    font: 400 13px/1.2 var(--io-font-ui);
  }
  .row {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    width: 100%;
    max-width: 1056px;
    margin: 0 auto;
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
    width: 100%;
    max-width: 1056px;
    height: 4px;
    margin: 0 auto;
    border-radius: 2px;
    background: var(--io-surface);
    overflow: hidden;
  }
  .fill {
    display: block;
    height: 100%;
    background: var(--io-gold);
    transition: width var(--motion-base) var(--ease-out-quart);
  }
  @media (max-width: 40rem) {
    .meter {
      gap: 8px;
      padding: 12px 16px 4px;
      font-size: 14px;
    }
    .long {
      display: none;
    }
  }
</style>
