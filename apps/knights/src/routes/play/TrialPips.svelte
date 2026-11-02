<script lang="ts">
  let { position, total, passMark }: { position: number; total: number; passMark: number } = $props();
</script>

<!-- Position only: a pip never shows whether its answer was right. -->
<section class="pips" aria-label="Trials progress">
  <div class="row">
    <span class="label"><span class="long">Acolyte Trials&nbsp;·&nbsp;</span>Trial {position} of {total}</span>
    <span class="note">Pass mark {Math.round(passMark * 100)}%<span class="long">&nbsp;·&nbsp;no XP or gold</span></span>
  </div>
  <div
    class="track"
    role="progressbar"
    aria-label="Trial {position} of {total}"
    aria-valuemin="1"
    aria-valuemax={total}
    aria-valuenow={position}
  >
    {#each { length: total } as _, index (index)}
      <span class="pip" class:done={index < position}></span>
    {/each}
  </div>
</section>

<style>
  .pips {
    display: flex;
    flex: none;
    flex-direction: column;
    gap: 12px;
    padding: 16px 28px 8px;
    font: 400 13px/1.2 var(--io-font-ui);
  }
  .row {
    display: flex;
    justify-content: space-between;
    gap: 12px;
  }
  .label {
    color: var(--io-parchment);
    font-weight: 500;
  }
  .note {
    color: var(--io-parchment-muted);
  }
  .track {
    display: flex;
    gap: 10px;
    width: 100%;
    max-width: 1056px;
    margin: 0 auto;
  }
  .pip {
    flex: 1 1 0;
    height: 4px;
    border-radius: 2px;
    background: var(--io-surface);
    transition: background-color var(--motion-base) var(--ease-out-quart);
  }
  .pip.done {
    background: var(--io-gold);
  }
  @media (max-width: 40rem) {
    .pips {
      padding: 12px 16px 4px;
      font-size: 14px;
    }
    .track {
      gap: 6px;
    }
    .long {
      display: none;
    }
  }
</style>
