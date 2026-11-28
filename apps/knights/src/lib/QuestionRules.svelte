<script lang="ts">
  import { QUESTION_RULES as rules } from './question-rules';
</script>

<div class="question-rules" id="question-rules">
  <h3 class="heading">Question rules</h3>
  {#if rules.intro}<p class="intro">{rules.intro}</p>{/if}
  {#each rules.sets as set, i (i)}
    <section class="set" aria-label={set.title}>
      <h4 class="title">{set.title}</h4>
      <ul class="points">
        {#each set.points as point, p (p)}<li>{point}</li>{/each}
      </ul>
      {#if set.notes}<p class="notes">{set.notes}</p>{/if}
    </section>
  {/each}
</div>

<style>
  .question-rules {
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
    gap: 10px;
  }
  .title {
    margin: 0;
    color: var(--io-gold);
    font: 700 14px/1.2 var(--io-font-ui);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .points {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 0;
    padding-left: 1.25em;
    color: var(--io-parchment);
    font: 400 18px/1.35 var(--io-font-body);
  }
  .points li::marker {
    color: var(--io-gold);
  }
  .notes {
    font-size: 14px;
  }

  @media (max-width: 40rem) {
    .points {
      font-size: 17px;
      line-height: 1.3;
    }
  }
</style>
