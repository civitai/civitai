<script lang="ts">
  import { onMount } from 'svelte';
  import Icon from '$lib/Icon.svelte';
  import RatingGuide from '$lib/RatingGuide.svelte';
  import RestartCareerDialog from '$lib/RestartCareerDialog.svelte';
  import { count, formatDate } from '$lib/format';
  import RankLadder from './RankLadder.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  let facts = $derived(data.facts);
  let restarting = $state(false);

  const TABS = [
    { id: 'ranks', label: 'Ranks' },
    { id: 'judging', label: 'How judging works' },
    { id: 'daily', label: 'Daily Watch & streaks' },
    { id: 'gold', label: 'Gold, Buzz & shop' },
    { id: 'fervor', label: 'Fervor & leaderboard' },
    { id: 'rating-guide', label: 'Rating guide' },
    { id: 'career', label: 'Your career' },
  ] as const;

  // The tab for the section being read; the browser handles the jump itself, this only marks where it landed.
  let active = $state<string>('ranks');
  onMount(() => {
    const sections = TABS.map((tab) => document.getElementById(tab.id)).filter(
      (node): node is HTMLElement => node !== null
    );
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((entry) => entry.isIntersecting);
        if (visible.length > 0) active = visible[0].target.id;
      },
      { rootMargin: '-20% 0px -70% 0px' }
    );
    sections.forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  });

  const half = $derived(Math.ceil(facts.ratingGuide.length / 2));
</script>

<svelte:head>
  <title>Codex · Knights of New Order</title>
</svelte:head>

<div class="page-wide codex">
  <header class="head">
    <p class="eyebrow">Knights of New Order</p>
    <h1 class="page-title">Codex of the Order</h1>
    <p class="lede">Everything the Order asks of you, and what it gives back, in one place.</p>
  </header>

  <nav class="tabs" aria-label="Codex sections">
    {#each TABS as tab (tab.id)}
      <a href="#{tab.id}" aria-current={active === tab.id ? 'location' : undefined}>{tab.label}</a>
    {/each}
  </nav>

  <section id="ranks" aria-labelledby="ranks-title">
    <p class="kicker">01 · Ranks</p>
    <h2 id="ranks-title">The ladder</h2>
    <p class="lead">
      Climb by judging well. Each rank asks for a level and an accuracy bar; in return your gold
      multiplies. Your accuracy is the share of your last {facts.accuracy.window}
      graded judgments that were right; until {facts.accuracy.minGraded} are graded you are not yet
      rated, and no bar applies. You can skip ranks when you meet both for a higher one.
      The top rank also asks for days played: days on which you judged at least one image as a Knight or
      above since your career began. Practice as an Acolyte does not count.
    </p>
    <p class="lead">
      A rank-up happens when one of your judgments is decided, not when you vote. Reaching a rank earns
      its badge, and the badge of any rank you skipped.
    </p>
    <RankLadder
      ranks={data.ranks}
      status={data.status}
      badges={data.badges}
      apprenticeBarPercent={facts.apprenticeship.accuracyPercent}
      levelGold={facts.apprenticeship.levelGold}
      knightLevel={facts.apprenticeship.knightLevel}
    />
    <p class="muted fine">
      Below the bar of your own rank your gold is cut to {facts.gold.belowBarFactor}×. You keep your rank
      and level, and recover by judging well; you are never demoted.
    </p>
  </section>

  <div class="divider" aria-hidden="true"><span></span></div>

  <section id="judging" aria-labelledby="judging-title">
    <p class="kicker">02 · How judging works</p>
    <h2 id="judging-title">Questions, verdicts and grades</h2>
    <div class="steps">
      <article>
        <span class="ring"><Icon name="users" size={20} /></span>
        <h3>Questions</h3>
        <p>
          Each image asks one question, usually how it should be rated. Judges answer independently, and
          you never see the image's current rating or anyone else's answer.
        </p>
      </article>
      <article>
        <span class="ring"><Icon name="gavel" size={20} /></span>
        <h3>Verdicts</h3>
        <p>
          Every image ends with a final verdict from the Order. Your judgment is graded against it, and
          until the image is decided your judgment is pending.
        </p>
      </article>
      <article>
        <span class="ring"><Icon name="scale" size={20} /></span>
        <h3>Grades</h3>
        <p>
          <strong>Correct</strong> matches the Order's final verdict: it pays gold and the extra XP.
          <strong>Wrong</strong> pays no gold or extra XP and counts against your accuracy.
          <strong>Inconclusive</strong> means the Order could not settle the image: no gold, and it does
          not count against your accuracy.
        </p>
      </article>
    </div>

    <div class="details">
      <div>
        <h3>The Acolyte apprenticeship</h3>
        <ul>
          <li>
            Everyone begins as an Acolyte. You practise on images and questions whose answers are known,
            so every answer is checked, and each right answer earns {facts.apprenticeship.xpPerCorrect} XP.
          </li>
          <li>
            Knighthood needs level {facts.apprenticeship.knightLevel} and {facts.apprenticeship.accuracyPercent}%
            accuracy over at least {facts.apprenticeship.window} practice answers (your latest
            {facts.apprenticeship.window} count). If your accuracy is a little short when you reach the
            level, carry on practising; nothing is lost.
          </li>
          <li>
            After every {facts.apprenticeship.checkpointEvery} answers a short recap shows how you did and
            the ones you missed, with the right answers. An Acolyte earns no judging gold, but each level
            you reach on the way, up to level {facts.apprenticeship.knightLevel}, pays
            {facts.apprenticeship.levelGold} gold, once, even if you later restart your career.
          </li>
        </ul>
      </div>
      <div>
        <h3>Voting, XP and gold</h3>
        <ul>
          <li>
            Some questions are plain yes or no questions about one image, asked in runs on one subject
            (press Y or N). Your answer is graded against the Order's final answer, with the same XP, gold
            and accuracy as a rating.
          </li>
          <li>
            A judgment gives {facts.xp.atVote} XP at once, and {facts.xp.onCorrect} more when it is graded
            correct.
          </li>
          <li>
            A judgment starts at {count(facts.gold.perCorrectVote)} gold for a Knight (more at higher ranks)
            and is <strong>pending</strong> until the image is decided. See
            <a href="#gold">Gold, Buzz and the shop</a>.
          </li>
          <li>
            Every judgment is listed on <a href="/judgments">your judgments</a> page as pending, correct,
            wrong or inconclusive. Judgments from before a career restart show as <strong>forfeited</strong>:
            they never pay out.
          </li>
        </ul>
      </div>
      <div>
        <h3>Hearts and pace</h3>
        <ul>
          <li>
            You have {facts.hearts.max} hearts. Poor judging can cost one. A lost heart comes back after
            {facts.hearts.returnAfterDays} days, or sooner if you judge well, and restarting your career restores
            them all. Lose all {facts.hearts.max} and your career restarts.
          </li>
          <li>Judging very fast pauses you for a short while.</li>
        </ul>
      </div>
    </div>
  </section>

  <div class="divider" aria-hidden="true"><span></span></div>

  <section id="daily" aria-labelledby="daily-title">
    <p class="kicker">03 · Daily Watch &amp; streaks</p>
    <h2 id="daily-title">Judge daily, keep the flame</h2>
    <div class="watch">
      <div class="prose">
        <p>
          Judge {facts.watch.size} images in a UTC day to complete that day's Watch. A completed Watch pays a
          streak bonus of {count(facts.watch.bonusGold)} gold per day of streak, up to {facts.watch.streakCap}
          days. The Watch is a goal, not a limit: keep judging after it and you keep earning, up to your daily gold cap, which grows with your level.
        </p>
        <p>
          The Watch, streaks and days played are for Knights and above.
        </p>
        <p>
          Miss a day and the streak resets. You start with {facts.watch.maxShields} shield and get one more
          each week, holding at most {facts.watch.maxShields}. A shield is used only when you miss exactly one day;
          miss two or more and the streak resets.
        </p>
        <p>
          Reach a streak of {facts.watch.badgeStreaks.join(', ')} days and you earn a Vigil badge for it, once
          each.
        </p>
      </div>
      <ul class="facts">
        <li><Icon name="flame" size={18} /><span><b>Streak bonus</b>Grows with every day, up to {facts.watch.streakCap}</span></li>
        <li><Icon name="shield-check" size={18} /><span><b>Weekly shield</b>Covers one missed day</span></li>
        <li><Icon name="coins" size={18} /><span><b>Daily gold cap</b>Grows with your level; XP still counts past it</span></li>
      </ul>
    </div>
  </section>

  <div class="divider" aria-hidden="true"><span></span></div>

  <section id="gold" aria-labelledby="gold-title">
    <p class="kicker">04 · Gold, Buzz &amp; shop</p>
    <h2 id="gold-title">What your judging earns</h2>
    <div class="details">
      <div>
        <h3>Gold</h3>
        <ul>
          <li>
            Judging gold is <strong>pending</strong> until the image is decided. Once your judgment is
            correct it is yours to spend; a wrong or inconclusive one drops it.
          </li>
          <li>
            The Watch streak bonus and an Acolyte's level gold arrive straight away. The bonus does not
            count against the daily cap.
          </li>
          <li>
            The daily gold cap grows with your level: {count(facts.gold.dailyCap.first)} at level
            {facts.gold.dailyCap.firstLevel}, rising every 10 levels to {count(facts.gold.dailyCap.top)} from level
            {facts.gold.dailyCap.topLevel}. The cap counts gold as you earn it, so gold from a judgment that turns out wrong still
            uses up part of the day. Past the cap, judgments still earn XP and count toward the Watch.
          </li>
        </ul>
      </div>
      <div>
        <h3>Gold to Buzz</h3>
        <ul>
          <li>
            Buzz packs in the shop turn your gold into Buzz. Each pack shows its gold price and the Buzz it
            gives, and bigger packs give more Buzz for your gold.
          </li>
        </ul>
      </div>
      <div>
        <h3>The shop</h3>
        <ul>
          <li>
            The shop sells Buzz packs, memberships and cosmetics. Some items need a minimum rank.
          </li>
          <li>
            Stock changes every day at UTC midnight. Deals are cheaper and can sell out. You can hold one
            membership at a time.
          </li>
        </ul>
      </div>
    </div>
  </section>

  <div class="divider" aria-hidden="true"><span></span></div>

  <section id="fervor" aria-labelledby="fervor-title">
    <p class="kicker">05 · Fervor &amp; leaderboard</p>
    <h2 id="fervor-title" class="with-icon"><Icon name="sparkles" size={26} />Fervor: your week in the Order</h2>
    <div class="formula">
      <p class="small-caps">Fervor =</p>
      <p class="expr">correct judgments × {facts.fervor.scale} × accuracy²</p>
      <p class="muted">counted over the last {facts.fervor.windowDays} days</p>
    </div>
    <div class="steps">
      <article>
        <h3>Accuracy counts twice</h3>
        <p>
          Accuracy is squared, so careful judging beats raw volume. {data.fervorExample.correct} correct at
          {data.fervorExample.accuracyPercent}% accuracy: {data.fervorExample.sum}.
        </p>
      </article>
      <article>
        <h3>A rolling week</h3>
        <p>
          Fervor covers the last {facts.fervor.windowDays} days, so there is no weekly reset cliff: every
          day you judge moves you.
        </p>
      </article>
      <article>
        <h3>The leaderboard</h3>
        <p>
          Knights, Templars and Paladins who graded at least one judgment in the last {facts.fervor.windowDays}
          days are ranked by fervor. Acolytes do not appear. Your place and the gap to the next one show beside the image while
          you play. <a href="/leaderboard">See the leaderboard</a>.
        </p>
      </article>
    </div>
  </section>

  <div class="divider" aria-hidden="true"><span></span></div>

  <section id="rating-guide" aria-labelledby="guide-title">
    <p class="kicker">06 · Rating guide</p>
    <h2 id="guide-title">What each level means</h2>
    <p class="lead">Rate what the image shows, not what you would like to see.</p>
    <div class="guide-cols">
      <RatingGuide guide={facts.ratingGuide.slice(0, half)} />
      <RatingGuide guide={facts.ratingGuide.slice(half)} />
    </div>
  </section>

  {#if data.swornIn}
    <hr class="rule" />
    <section id="career" class="career" aria-labelledby="career-title">
      <div>
        <p class="kicker" id="career-title">Your career</p>
        <p class="muted">
          Sworn in on {formatDate(data.swornIn)}. Starting over returns you to Acolyte and cannot be undone.
          It costs your unconverted and pending gold, your streak, and your older judgments, which are
          forfeited. Your shields and the gold you already spent or converted are kept.
        </p>
      </div>
      <button type="button" class="restart" onclick={() => (restarting = true)}>
        <Icon name="rotate-ccw" size={14} />Restart career
      </button>
    </section>
  {/if}
</div>

{#if restarting}
  <RestartCareerDialog onclose={() => (restarting = false)} />
{/if}

<style>
  p {
    margin: 0;
  }
  .head .lede {
    margin-bottom: 1rem;
  }
  .tabs {
    position: sticky;
    top: 0;
    z-index: 10;
    display: flex;
    gap: 4px;
    margin: 0 0 2rem;
    padding: 8px 0;
    overflow-x: auto;
    border-bottom: 1px solid var(--io-gold-muted);
    background: var(--io-bg);
    scrollbar-width: none;
  }
  .tabs a {
    flex: none;
    padding: 8px 14px;
    border-radius: 999px;
    color: var(--io-parchment-muted);
    font: 600 13px/1.2 var(--io-font-ui);
    text-decoration: none;
    white-space: nowrap;
  }
  .tabs a:hover {
    color: var(--io-parchment);
  }
  .tabs a[aria-current] {
    background: var(--io-surface);
    color: var(--io-gold);
    box-shadow: inset 0 0 0 1px var(--io-gold-muted);
  }
  section {
    scroll-margin-top: 64px;
  }
  .kicker {
    margin-bottom: 4px;
    color: var(--io-gold);
    font: 600 12px/1.3 var(--io-font-ui);
    letter-spacing: 0.22em;
    text-transform: uppercase;
  }
  h2.with-icon {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  h2 {
    margin: 0 0 12px;
    color: var(--io-parchment);
    font-size: clamp(1.4rem, 3vw, 2rem);
    letter-spacing: 0.04em;
  }
  .lead {
    max-width: 52rem;
    margin-bottom: 1.5rem;
    color: var(--io-parchment-muted);
    font-size: 1.1rem;
    line-height: 1.5;
  }
  .fine {
    max-width: 52rem;
    margin-top: 1.25rem;
    font: 400 0.9rem/1.5 var(--io-font-ui);
  }
  h3 {
    margin: 0 0 8px;
    color: var(--io-gold);
    font: 700 13px/1.3 var(--io-font-display);
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }

  .steps {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 20px;
  }
  .steps article {
    padding: 20px;
    border: 1px solid var(--io-gold-muted);
    border-radius: 12px;
    background: var(--io-surface);
  }
  .steps p {
    color: var(--io-parchment-muted);
    font: 400 14px/1.5 var(--io-font-ui);
  }
  .ring {
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    margin-bottom: 12px;
    border: 1px solid var(--io-gold);
    border-radius: 50%;
    color: var(--io-gold);
  }
  .details {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 2.5rem;
    margin-top: 2rem;
  }
  .details ul {
    margin: 0;
    padding: 0;
    list-style: none;
    color: var(--io-parchment-muted);
    font-size: 1rem;
  }
  .details li {
    margin-bottom: 0.6rem;
  }
  .details strong {
    color: var(--io-parchment);
  }

  .watch {
    display: grid;
    grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr);
    gap: 2.5rem;
    align-items: start;
  }
  .prose {
    display: flex;
    flex-direction: column;
    gap: 0.8rem;
    color: var(--io-parchment-muted);
  }
  .facts {
    display: flex;
    flex-direction: column;
    gap: 14px;
    margin: 0;
    padding: 20px;
    border: 1px solid var(--io-gold-muted);
    border-radius: 12px;
    background: var(--io-surface);
    list-style: none;
  }
  .facts li {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    color: var(--io-parchment-muted);
    font: 400 13px/1.4 var(--io-font-ui);
  }
  .facts li :global(svg) {
    flex: none;
    margin-top: 1px;
    color: var(--io-gold);
  }
  .facts b {
    display: block;
    color: var(--io-parchment);
    font-weight: 600;
  }

  .formula {
    margin-bottom: 20px;
    padding: 20px 24px;
    border: 1px solid var(--io-gold);
    border-radius: 12px;
    background: var(--io-surface);
  }
  .small-caps {
    color: var(--io-gold);
    font: 600 11px/1.2 var(--io-font-ui);
    letter-spacing: 0.2em;
    text-transform: uppercase;
  }
  .expr {
    margin: 6px 0;
    color: var(--io-parchment);
    font: 700 clamp(1.2rem, 3vw, 1.7rem) / 1.3 var(--io-font-display);
  }

  .guide-cols {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 2.5rem;
  }

  .rule {
    margin: 2.5rem 0 1.5rem;
    border: 0;
    border-top: 1px solid var(--io-gold-muted);
  }
  .career {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1.5rem;
    padding-bottom: 1rem;
  }
  .restart {
    display: inline-flex;
    flex: none;
    align-items: center;
    gap: 8px;
    min-height: 40px;
    border-color: var(--io-crimson);
    background: transparent;
    color: var(--io-crimson-text);
  }

  @media (max-width: 64rem) {
    .steps,
    .details {
      grid-template-columns: minmax(0, 1fr);
      gap: 1rem;
    }
    .details {
      gap: 1.5rem;
    }
    .watch,
    .guide-cols {
      grid-template-columns: minmax(0, 1fr);
      gap: 1.25rem;
    }
  }
  @media (max-width: 40rem) {
    .career {
      flex-direction: column;
      align-items: flex-start;
    }
  }
</style>
