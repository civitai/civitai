<script lang="ts">
  import HomeCard from './HomeCard.svelte';

  const STEPS = [
    {
      title: 'A rating settles',
      body: "Knights reach consensus on an image's level and the review opens here.",
    },
    {
      title: 'Two moderators vote',
      body: 'You and one other moderator each pick the level you see.',
    },
    {
      title: 'Agree or split',
      body: 'Two matching levels confirm it: the level is written to the image and it becomes a skill check. Two different levels split it.',
    },
  ];
</script>

<HomeCard id="inquisitor-card-title" eyebrow="How a review closes" title="Two moderators, one level">
  <ol>
    {#each STEPS as step, index (step.title)}
      <li class="home-card-box">
        <span class="number" aria-hidden="true">{index + 1}</span>
        <div>
          <p class="title">{step.title}</p>
          <p class="body">{step.body}</p>
        </div>
      </li>
    {/each}
  </ol>
</HomeCard>

<style>
  ol {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  li {
    display: flex;
    gap: 14px;
    padding: 12px 14px;
  }
  .number {
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border: 1px solid var(--io-gold);
    border-radius: 50%;
    color: var(--io-gold);
    font: 700 14px/1 var(--io-font-display);
  }
  p {
    margin: 0;
  }
  .title {
    color: var(--io-parchment);
    font: 600 13px/1.3 var(--io-font-ui);
  }
  .body {
    margin-top: 2px;
    color: var(--io-parchment-muted);
    font: 400 12px/1.4 var(--io-font-ui);
  }
</style>
