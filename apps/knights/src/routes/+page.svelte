<script lang="ts">
  import { enhance } from '$app/forms';
  import { formatDate } from '$lib/format';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();
  let warning = $state(false);
  let submitting = $state(false);
  let attempted = $state(false);
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
      {#if attempted && form?.message}
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
