<script lang="ts">
  import { enhance } from '$app/forms';
  import type { ActionData, PageData } from './$types';
  import ImageStage from './ImageStage.svelte';

  type InquisitorData = Extract<PageData, { mode: 'inquisitor' }>;
  let { data, form }: { data: InquisitorData; form: ActionData } = $props();

  let failed = $state(false);
  let submitting = $state(false);
  const message = $derived(form && 'message' in form ? (form.message as string) : null);
  const review = $derived(data.review);
  const percent = (rate: number | null) => (rate === null ? '—' : `${Math.round(rate * 100)}%`);

  const submit = () => {
    submitting = true;
    return async ({ update }: { update: () => Promise<void> }) => {
      await update();
      failed = false;
      submitting = false;
    };
  };
</script>

<div class="inq">
  <header class="inq-head">
    <h1>Inquisitor queue</h1>
    <p class="inq-sub">
      Settled ratings from the Order. Two moderators giving the same level make the image a skill check.
    </p>
    <dl class="inq-stats">
      <div><dt>Your votes this week</dt><dd>{data.stats.votesThisWeek}</dd></div>
      <div><dt>Waiting for you</dt><dd>{data.stats.waiting}</dd></div>
      <div><dt>Agreed with the other moderator</dt><dd>{percent(data.stats.agreementRate)}</dd></div>
    </dl>
  </header>

  {#if review}
    <div class="inq-body">
      <div class="inq-main">
        {#key review.token}
          <ImageStage
            src={review.src}
            width={review.width}
            height={review.height}
            alt="The image under review"
            {failed}
            onfail={() => (failed = true)}
          />
        {/key}
        <form class="inq-levels" method="POST" action="?/inquisitorVote" use:enhance={submit}>
          <input type="hidden" name="token" value={review.token} />
          {#each data.levels as level (level.value)}
            <button type="submit" name="answer" value={level.value} disabled={submitting}>
              {level.label}
            </button>
          {/each}
        </form>
        <form method="POST" action="?/sendToInquisitor" use:enhance={submit}>
          <input type="hidden" name="token" value={review.token} />
          <button type="submit" class="quiet inq-send" disabled={submitting}>
            Should be Blocked: send to the Inquisitors
          </button>
        </form>
        {#if message}
          <p class="notice flat" role="alert">{message}</p>
        {/if}
      </div>

      <aside class="inq-side" aria-label="About this image">
        <dl>
          <div><dt>Knights' consensus</dt><dd>{review.sidebar.consensus}</dd></div>
          <div><dt>Level on the image now</dt><dd>{review.sidebar.current}</dd></div>
          <div><dt>Moderator votes so far</dt><dd>{review.votes} of 2</dd></div>
        </dl>
        <h2>How the Order voted</h2>
        {#if review.sidebar.votes.length === 0}
          <p class="inq-muted">No counted votes.</p>
        {:else}
          <ul class="inq-tally">
            {#each review.sidebar.votes as vote (vote.answer)}
              <li>
                <span class="inq-answer">{vote.label}</span>
                <span>{vote.votes} {vote.votes === 1 ? 'vote' : 'votes'}</span>
                <span class="inq-muted">
                  {vote.stages.map((s) => `${s.stage} ${s.votes}`).join(' · ')}
                </span>
              </li>
            {/each}
          </ul>
        {/if}
        {#if review.sidebar.prompt}
          <h2>Prompt</h2>
          <p class="inq-prompt">{review.sidebar.prompt}</p>
        {/if}
        <h2>On Civitai</h2>
        <ul class="inq-links">
          <li><a href={review.sidebar.imageUrl} target="_blank" rel="noopener noreferrer">Image page (tags, resources)</a></li>
          {#if review.sidebar.postUrl}
            <li><a href={review.sidebar.postUrl} target="_blank" rel="noopener noreferrer">Post</a></li>
          {/if}
          {#if review.sidebar.creator}
            <li>
              <a href={review.sidebar.creator.url} target="_blank" rel="noopener noreferrer"
                >Creator: {review.sidebar.creator.username}</a
              >
            </li>
          {/if}
        </ul>
      </aside>
    </div>
  {:else}
    <p class="inq-empty">Nothing waiting for you. Check back later.</p>
    {#if message}
      <p class="notice flat" role="alert">{message}</p>
    {/if}
  {/if}
</div>

<style>
  .inq {
    display: flex;
    flex-direction: column;
    gap: 16px;
    max-width: 72rem;
    margin: 0 auto;
    padding: 16px;
  }
  .inq-head h1 {
    margin: 0;
    font: 600 24px/1.2 var(--io-font-display, inherit);
  }
  .inq-sub,
  .inq-muted {
    margin: 4px 0 0;
    color: var(--io-parchment-muted);
  }
  .inq-stats {
    display: flex;
    flex-wrap: wrap;
    gap: 24px;
    margin: 12px 0 0;
  }
  .inq-stats dt,
  .inq-side dt {
    color: var(--io-parchment-muted);
    font-size: 13px;
  }
  .inq-stats dd,
  .inq-side dd {
    margin: 0;
    font-weight: 600;
  }
  .inq-body {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 20rem;
    gap: 16px;
  }
  .inq-main {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .inq-levels {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .inq-side {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 16px;
    border: 1px solid var(--io-gold-muted);
    border-radius: 8px;
    background: var(--io-surface);
  }
  .inq-side dl {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 0;
  }
  .inq-side h2 {
    margin: 8px 0 0;
    font-size: 15px;
  }
  .inq-tally,
  .inq-links {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .inq-tally li {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .inq-answer {
    font-weight: 600;
  }
  .inq-prompt {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .inq-empty {
    padding: 32px 0;
    text-align: center;
  }
  @media (max-width: 800px) {
    .inq-body {
      grid-template-columns: 1fr;
    }
  }
</style>
