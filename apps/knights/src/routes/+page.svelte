<script lang="ts">
  import { enhance } from '$app/forms';
  import { formatDate } from '$lib/format';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();
  let warning = $state(false);
  let submitting = $state(false);
  let attempted = $state(false);
  let restarting = $state(false);
  let restartSubmitting = $state(false);
  let restartAttempted = $state(false);
</script>

<h1>Knights of New Order</h1>

{#if data.player}
  <p>Welcome back{data.username ? `, ${data.username}` : ''}.</p>
  <dl>
    <dt>Rank</dt>
    <dd>{data.player.rankType}</dd>
    <dt>Experience</dt>
    <dd>{data.player.exp}</dd>
    <dt>Fervor</dt>
    <dd>{data.player.fervor}</dd>
    <dt>Sworn in</dt>
    <dd>{formatDate(data.player.startAt)}</dd>
  </dl>
  <p><a href="/play" data-sveltekit-preload-data="off">Begin judging</a></p>

  <section class="restart" aria-labelledby="restart-title">
    <h2 id="restart-title">Restart career</h2>
    {#if restarting}
      <p>Restarting your career cannot be undone. You will lose:</p>
      <ul>
        <li>your rank: you return to Acolyte and begin again in the Trials</li>
        <li>your level and experience</li>
        <li>all gold you have not yet converted, including gold still pending</li>
      </ul>
      <p class="muted">Gold you have already converted stays with you.</p>
      <form
        method="POST"
        action="?/restart"
        use:enhance={() => {
          restartSubmitting = true;
          restartAttempted = true;
          return async ({ update }) => {
            try {
              await update();
            } finally {
              restartSubmitting = false;
            }
          };
        }}
      >
        <input type="hidden" name="confirmed" value="yes" />
        <button type="submit" class="danger" disabled={restartSubmitting}>
          Yes, restart my career
        </button>
        <button
          type="button"
          onclick={() => {
            restarting = false;
            restartAttempted = false;
          }}
          disabled={restartSubmitting}>Cancel</button
        >
      </form>
      {#if restartAttempted && form?.restartFailed}
        <p class="notice" role="alert">{form.message}</p>
      {/if}
    {:else}
      <p class="muted">Start over as an Acolyte.</p>
      <button type="button" class="danger" onclick={() => (restarting = true)}>
        Restart career
      </button>
    {/if}
  </section>
{:else}
  <p>You have not joined the Order yet.</p>
  <p class="muted">
    Knights judge how mature images should be rated. New members begin as Acolytes and prove
    themselves in the Trials. <a href="/rules">Read the rules</a> first if you like.
  </p>
  {#if warning}
    <section class="warning" aria-labelledby="warning-title">
      <h2 id="warning-title">Sensitive content warning</h2>
      <p>
        This game contains explicit and sensitive imagery, regardless of your on-site browsing level
        settings, that may not be suitable for all players.
      </p>
      <p>
        By continuing, you acknowledge that you are aware of the potential risks and agree to
        proceed at your own discretion.
      </p>
      <form
        method="POST"
        action="?/join"
        use:enhance={() => {
          submitting = true;
          attempted = true;
          return async ({ update }) => {
            try {
              await update();
            } finally {
              submitting = false;
            }
          };
        }}
      >
        <input type="hidden" name="accepted" value="yes" />
        <button type="submit" disabled={submitting}>Agree and continue</button>
        <button type="button" onclick={() => {
            warning = false;
            attempted = false;
          }} disabled={submitting}>Cancel</button>
      </form>
      {#if attempted && form?.message && !form.restartFailed}
        <p class="notice" role="alert">{form.message}</p>
      {/if}
    </section>
  {:else}
    <p><button type="button" onclick={() => (warning = true)}>Join the Order</button></p>
  {/if}
{/if}

<style>
  .warning {
    padding: 1rem 1.5rem;
    border: 1px solid var(--border);
    background: var(--panel);
  }
  .restart {
    margin-top: 2rem;
    padding: 1rem 1.5rem;
    border: 1px solid var(--border);
    background: var(--panel);
  }
  .danger {
    color: #e57a6f;
    border-color: #b3261e;
  }
  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.25rem 1.5rem;
    padding: 1rem 1.5rem;
    border: 1px solid var(--border);
    background: var(--panel);
  }
  dt {
    color: var(--muted);
  }
  dd {
    margin: 0;
  }
</style>
