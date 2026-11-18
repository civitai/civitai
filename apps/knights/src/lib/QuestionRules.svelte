<script lang="ts">
  import type { KnightsRuleGuide } from '@civitai/shared/new-order';
  import RatingGuide from './RatingGuide.svelte';

  let { rules }: { rules: KnightsRuleGuide } = $props();
</script>

<div class="rules" id="question-rules">
  <h3 class="heading">Question rules</h3>
  {#if rules.intro}<p class="intro">{rules.intro}</p>{/if}
  {#each rules.sets as set, i (i)}
    <section class="set" aria-label={set.title}>
      <h4 class="title">{set.title}</h4>
      <RatingGuide
        guide={set.levels.map((level, index) => ({
          level: index,
          label: level.code,
          description: level.description,
        }))}
      />
      {#if set.notes}<p class="notes">{set.notes}</p>{/if}
    </section>
  {/each}
</div>

<style>
  .rules {
    display: flex;
    flex-direction: column;
    gap: 20px;
  }
  .heading {
    margin: 0;
    color: var(--io-parchment);
    font: 700 22px/1.2 var(--io-font-display);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .intro,
  .notes {
    margin: 0;
    color: var(--io-parchment-muted);
    font: 400 16px/1.5 var(--io-font-body);
  }
  .set {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .title {
    margin: 0;
    color: var(--io-gold);
    font: 700 14px/1.2 var(--io-font-ui);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .notes {
    font-size: 14px;
  }
</style>
