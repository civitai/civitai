<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import AnswerPill from '$lib/AnswerPill.svelte';
  import '$lib/answer-row.css';
  import type { ActionData, PageData } from './$types';
  import ImageStage from './ImageStage.svelte';
  import { answerForKeyPress } from './keys';
  import { KNIGHTS_STAGE_RANKS } from '@civitai/shared/new-order';

  type InquisitorData = Extract<PageData, { mode: 'inquisitor' }>;
  let { data, form }: { data: InquisitorData; form: ActionData } = $props();

  let failed = $state(false);
  let submitting = $state(false);
  // The level being sent, held pressed until the next review arrives.
  let picked = $state<string | null>(null);
  // "Send to the Inquisitors" asks once before it fires.
  let confirmingSend = $state(false);
  let promptOpen = $state(false);
  let answers = $state<HTMLFormElement>();

  const message = $derived(form && 'message' in form ? (form.message as string) : null);
  const review = $derived(data.review);
  const percent = (rate: number | null) => (rate === null ? '—' : `${Math.round(rate * 100)}%`);
  /** The stage a vote came at is the rank the item waited for (Knight, Templar, Paladin). */
  const rankName = (stage: string) =>
    (KNIGHTS_STAGE_RANKS as readonly string[]).includes(stage) ? `${stage}s` : stage;
  const votes = (n: number) => `${n} ${n === 1 ? 'vote' : 'votes'}`;

  const submit: SubmitFunction = ({ submitter }) => {
    submitting = true;
    picked = submitter?.getAttribute('value') ?? null;
    return async ({ update }) => {
      await update();
      failed = false;
      submitting = false;
      picked = null;
      confirmingSend = false;
      promptOpen = false;
    };
  };

  // The number keys vote the levels in order, as in the player game. Typing in a field, holding a modifier, a pending
  // vote or the send confirmation leaves the key alone; nothing here is bound to Space.
  function onkeydown(event: KeyboardEvent) {
    if (!review || submitting || confirmingSend) return;
    if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
    const value = answerForKeyPress(data.levels, event.key, false);
    if (!value) return;
    const button = answers?.querySelector<HTMLButtonElement>(`button[value="${value}"]`);
    if (!button || button.disabled) return;
    event.preventDefault();
    answers?.requestSubmit(button);
  }
</script>

<svelte:window {onkeydown} />

<div class="inq">
  <header class="inq-head">
    <div class="inq-title">
      <h1>Inquisitor queue</h1>
      <p class="inq-sub">Two moderators giving the same level make the image a skill check.</p>
    </div>
    <dl class="inq-stats">
      <div><dt>Your votes this week</dt><dd>{data.stats.votesThisWeek}</dd></div>
      <div>
        <dt>Waiting for you</dt>
        <dd>{data.stats.waiting}{data.stats.waitingMore ? '+' : ''}</dd>
      </div>
      <div><dt>Agreed with the other moderator</dt><dd>{percent(data.stats.agreementRate)}</dd></div>
    </dl>
  </header>

  {#if review}
    <!-- Keyed on the review, so the image and the sidebar always change together. -->
    {#key review.token}
      <div class="inq-body">
        <div class="inq-main">
          <div class="stagewrap">
            <ImageStage
              src={review.src}
              width={review.width}
              height={review.height}
              alt="The image under review"
              {failed}
              onfail={() => (failed = true)}
            />
          </div>
          {#if message}
            <p class="notice flat" role="alert">{message}</p>
          {/if}
          <form
            class="answers answer-row"
            method="POST"
            action="?/inquisitorVote"
            use:enhance={submit}
            bind:this={answers}
          >
            <input type="hidden" name="token" value={review.token} />
            {#each data.levels as level, index (level.value)}
              <AnswerPill
                option={level}
                {index}
                picked={picked === level.value}
                hint={data.hints[level.value]}
                disabled={submitting || failed}
              />
            {/each}
          </form>
        </div>

        <aside class="inq-side" aria-label="About this image">
          <dl class="inq-facts">
            <div><dt>Knights' consensus</dt><dd>{review.sidebar.consensus}</dd></div>
            <div><dt>Level on the image now</dt><dd>{review.sidebar.current}</dd></div>
            <div><dt>Moderators so far</dt><dd>{review.votes} of 2</dd></div>
          </dl>

          <h2>How the Order voted</h2>
          {#if review.sidebar.votes.length === 0}
            <p class="inq-muted">No counted votes.</p>
          {:else}
            <ul class="inq-tally">
              {#each review.sidebar.votes as vote (vote.answer)}
                <li>
                  <span class="inq-answer">{vote.label}</span>
                  <span>{votes(vote.votes)}</span>
                  <span class="inq-muted">
                    {vote.stages.map((s) => `${rankName(s.stage)}: ${s.votes}`).join(', ')}
                  </span>
                </li>
              {/each}
            </ul>
          {/if}

          <h2>Prompt</h2>
          {#if review.sidebar.prompt}
            <p class="inq-prompt" class:open={promptOpen}>{review.sidebar.prompt}</p>
            <button type="button" class="linkish" onclick={() => (promptOpen = !promptOpen)}>
              {promptOpen ? 'Show less' : 'Show full prompt'}
            </button>
          {:else}
            <p class="inq-muted">No prompt.</p>
          {/if}

          <h2>Tags</h2>
          {#if review.sidebar.tags.length === 0}
            <p class="inq-muted">No tags.</p>
          {:else}
            <ul class="inq-tags">
              {#each review.sidebar.tags as tag (tag)}<li>{tag}</li>{/each}
            </ul>
          {/if}

          <h2>On Civitai</h2>
          <ul class="inq-links">
            <li>
              <a href={review.sidebar.imageUrl} target="_blank" rel="noopener noreferrer"
                >Image page (tags, resources)</a
              >
            </li>
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

          <div class="inq-send">
            {#if confirmingSend}
              <p class="inq-confirm" id="send-confirm">
                Send this image to the Inquisitors as one that should be Blocked? It leaves this queue.
              </p>
              <form method="POST" action="?/sendToInquisitor" use:enhance={submit} class="inq-confirm-row">
                <input type="hidden" name="token" value={review.token} />
                <button type="submit" class="send" disabled={submitting} aria-describedby="send-confirm">
                  Send to the Inquisitors
                </button>
                <button type="button" class="quiet" onclick={() => (confirmingSend = false)}>Cancel</button>
              </form>
            {:else}
              <button type="button" class="send" disabled={submitting} onclick={() => (confirmingSend = true)}>
                Should be Blocked…
              </button>
            {/if}
          </div>
        </aside>
      </div>
    {/key}
  {:else}
    <p class="inq-empty">Nothing waiting for you. Check back later.</p>
    {#if message}
      <p class="notice flat" role="alert">{message}</p>
    {/if}
  {/if}
</div>

<style>
  /* Mirrors the player page: the column fills the space under the site header, and only the sidebar scrolls. */
  .inq {
    position: relative;
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    gap: 12px;
    width: 100%;
    min-height: 0;
    padding: 12px 16px 16px;
  }
  .inq-head {
    display: flex;
    flex: none;
    flex-wrap: wrap;
    align-items: flex-end;
    justify-content: space-between;
    gap: 8px 24px;
  }
  .inq-head h1 {
    margin: 0;
    font: 600 22px/1.2 var(--io-font-display, inherit);
  }
  .inq-sub,
  .inq-muted {
    margin: 2px 0 0;
    color: var(--io-parchment-muted);
  }
  .inq-stats {
    display: flex;
    flex-wrap: wrap;
    gap: 20px;
    margin: 0;
  }
  .inq-stats dt,
  .inq-facts dt {
    color: var(--io-parchment-muted);
    font-size: 13px;
  }
  .inq-stats dd,
  .inq-facts dd {
    margin: 0;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .inq-body {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 20rem;
    flex: 1 1 0;
    gap: 16px;
    min-height: 0;
  }
  .inq-main {
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-width: 0;
    min-height: 0;
  }
  .stagewrap {
    position: relative;
    display: grid;
    grid-template: minmax(0, 1fr) / minmax(0, 1fr);
    flex: 1 1 0;
    min-height: 0;
  }
  .answers {
    flex: none;
  }
  .inq-side {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-height: 0;
    overflow-y: auto;
    padding: 16px;
    border: 1px solid var(--io-gold-muted);
    border-radius: 8px;
    background: var(--io-surface);
  }
  /* Children keep their height: the sidebar scrolls rather than squeezing the clamped prompt to nothing. */
  .inq-side > :global(*) {
    flex: none;
  }
  .inq-facts {
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
  .inq-links,
  .inq-tags {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .inq-tags {
    flex-direction: row;
    flex-wrap: wrap;
  }
  .inq-tags li {
    padding: 2px 8px;
    border: 1px solid var(--io-gold-muted);
    border-radius: 999px;
    font-size: 13px;
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
    display: -webkit-box;
    margin: 0;
    overflow: hidden;
    overflow-wrap: anywhere;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 6;
    line-clamp: 6;
  }
  .inq-prompt.open {
    display: block;
  }
  .linkish {
    align-self: flex-start;
    padding: 0;
    border: none;
    background: none;
    color: var(--io-gold);
    text-decoration: underline;
    cursor: pointer;
  }
  /* Last in the sidebar and styled like the player's Blocked answer, away from the level row. */
  .inq-send {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 16px;
    padding-top: 12px;
    border-top: 1px solid var(--border, var(--io-gold-muted));
  }
  .send {
    height: 40px;
    padding: 0 12px;
    border: 1px solid var(--io-crimson);
    border-radius: 6px;
    background: var(--io-bg);
    color: var(--io-crimson-text);
    font: 700 14px/1 var(--io-font-ui);
  }
  .send:hover:not(:disabled) {
    border-color: var(--io-crimson-text);
  }
  .inq-confirm {
    margin: 0;
  }
  .inq-confirm-row {
    display: flex;
    gap: 8px;
  }
  .inq-empty {
    padding: 32px 0;
    text-align: center;
  }
  /* Narrow: the image and the answer row fill the screen; the sidebar follows below and the body scrolls to it. */
  @media (max-width: 800px) {
    .inq {
      padding: 8px 12px 12px;
    }
    .inq-body {
      display: flex;
      flex-direction: column;
      overflow-y: auto;
    }
    .inq-main {
      flex: none;
      height: 100%;
    }
    .inq-side {
      flex: none;
      overflow-y: visible;
    }
  }
</style>
