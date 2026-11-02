<script lang="ts">
  import { count } from '$lib/format';
  import RankCards from '$lib/RankCards.svelte';
  import RatingGuide from '$lib/RatingGuide.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  let facts = $derived(data.facts);
</script>

<div class="page-wide rules">
  <header class="head">
    <div>
      <p class="eyebrow">Knights of New Order</p>
      <h1 class="page-title">Rules of the Order</h1>
    </div>
    <p class="lede">
      Knights of New Order judge how mature images should be rated, so the site can show each image
      to the right people. <a href="/play" data-sveltekit-preload-data="off">Back to judging</a>
    </p>
  </header>

  <h2 class="section-title">The ranks</h2>
  <RankCards
    ranks={facts.ranks.map((r) => ({ ...r, accuracyBar: r.accuracyPercent / 100 }))}
  />
  <p class="muted ranks-note">
    Vote weights, gold rates and daily caps per rank are on the <a href="/ranks">Ranks</a> page.
  </p>

  <div class="divider" aria-hidden="true"><span></span></div>

  <div class="columns">
    <div class="col">
<section>
<h2>Acolyte Trials</h2>
<ul>
  <li>
    Everyone begins as an Acolyte. A Trial is a run of up to {facts.trials.length} images with known
    answers; the first ones come with an explanation of why.
  </li>
  <li>
    Score {facts.trials.passPercent}% or more on the fresh images to become a Knight. If you fall
    short you may try again after {facts.trials.cooldownHours} hours.
  </li>
  <li>An Acolyte's answers never decide anything, and earn no XP or gold.</li>
</ul>
</section>
<section>
<h2>Voting and verdicts</h2>
<ul>
  <li>
    Each image asks one question, usually how it should be rated. Several judges answer it
    independently; you never see the image's current rating or anyone else's answer.
  </li>
  <li>
    When enough judges agree, the image is rated that way. A split goes up to higher ranks, and
    finally to a moderator, so every judgment is eventually decided.
  </li>
  <li>
    Your judgment is graded against the final verdict: correct, wrong, or inconclusive. Higher ranks
    carry more weight in a vote.
  </li>
  <li>
    Some questions are plain yes or no questions about one image, asked in runs on one subject
    (press Y or N). They are judged like any other: once at least {facts.yesNo.judgesNeeded} judges have
    answered, an answer with the majority is correct and any other is wrong, with the same XP, gold and accuracy as a rating.
  </li>
  <li>
    Judging is paced. Go too fast and you will be asked to rest for a short while before the next
    image. Moderators are not paced.
  </li>
</ul>
</section>
<section>
<h2>XP and ranks</h2>
<ul>
  <li>
    A judgment gives {facts.xp.atVote} XP at once, and {facts.xp.onCorrect} more when it is graded
    correct.
  </li>
  <li>
    Your accuracy is the share of your last {facts.accuracy.window} graded judgments that were right.
    Until {facts.accuracy.minGraded} are graded you are not yet rated.
  </li>
  <li>
    You rise to a rank by reaching its level and meeting its accuracy bar. Below the bar of your own
    rank your vote weight and gold are cut to {facts.gold.belowBarFactor}x, but you are never
    demoted.
  </li>
</ul>

</section>
    </div>
    <div class="col">
<section>
<h2>The daily Watch and streaks</h2>
<ul>
  <li>
    Judge {facts.watch.size} images in a UTC day to complete that day's Watch. A completed Watch
    pays a streak bonus of {count(facts.watch.bonusGold)} gold per day of streak, up to {facts.watch
      .streakCap} days.
  </li>
  <li>
    Miss a day and the streak resets. You hold up to {facts.watch.maxShields} free shield, granted
    each week, which covers exactly one missed day.
  </li>
  <li>Each rank has a daily cap on gold from judging. Past it, judgments still earn XP and count toward the Watch.</li>
</ul>
</section>
<section>
<h2>Gold</h2>
<ul>
  <li>
    A judgment starts at {count(facts.gold.perCorrectVote)} gold for a Knight (more at higher ranks)
    and is <strong>pending</strong> until the image is decided.
  </li>
  <li>
    A correct verdict makes it <strong>earned</strong>. A wrong or inconclusive one drops it.
  </li>
  <li>
    Pending and earned gold are shown on your status line. Converting earned gold to Buzz is coming
    later; it is not open yet.
  </li>
</ul>
</section>
<section>
<h2>Smites and hearts</h2>
<ul>
  <li>
    Judging in bad faith earns smites. Each smite lowers the weight of your votes, and right judgments wear smites away.
  </li>
  <li>
    You have {facts.hearts} hearts. Lose them all and your career resets: you start again from the
    beginning.
  </li>
</ul>
</section>
    </div>
    <div class="col">
<section>
<h2>Rating guide</h2>
<p class="muted">What each level means. Rate what the image shows, not what you would like to see.</p>
<RatingGuide guide={facts.ratingGuide} />
</section>
    </div>
  </div>
</div>

<style>
  p {
    margin: 0;
  }
  .head {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 2rem;
    align-items: end;
    margin-bottom: 1.5rem;
  }
  .head :global(.page-title),
  .head .lede {
    margin-bottom: 0;
  }
  .section-title,
  .rules section :global(h2) {
    margin: 0 0 0.75rem;
    font-size: 1.05rem;
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }
  .section-title {
    margin-bottom: 1.25rem;
  }
  .ranks-note {
    margin-top: 1.25rem;
    text-align: center;
  }
  .columns {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 2.5rem;
    align-items: start;
  }
  .col {
    display: flex;
    flex-direction: column;
    gap: 1.75rem;
  }
  .rules section :global(ul) {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .rules section :global(li) {
    margin-bottom: 0.6rem;
  }
  .rules section :global(strong) {
    color: var(--io-parchment);
  }
  @media (max-width: 47.99rem) {
    .head,
    .columns {
      grid-template-columns: minmax(0, 1fr);
      gap: 1rem;
    }
    .columns {
      gap: 1.75rem;
    }
    .col:last-child {
      order: -1;
    }
  }
</style>
