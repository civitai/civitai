<script lang="ts">
  import { buildWordmarkSvg, buildBadgeSvg, getHoliday } from '@civitai/brand';
  import { IconMailOpened, IconX } from '@tabler/icons-svelte';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const badgeSvg = buildBadgeSvg({ holiday: getHoliday() });
  const wordmarkSvg = buildWordmarkSvg({ base: '#e8eaed' });

  let submitting = $state(false);
</script>

<svelte:head><title>Accept invite · Civitai</title></svelte:head>

<!-- Restored from the back/forward cache: re-enable the button. A spent link just shows the expired notice. -->
<svelte:window
  onpageshow={(e) => {
    if (e.persisted) submitting = false;
  }}
/>

<main>
  <div class="card">
    <div class="brand">
      <span class="badge">{@html badgeSvg}</span>
      <span class="wordmark">{@html wordmarkSvg}</span>
    </div>

    {#if form?.error === 'refused'}
      <div class="notice" role="alert">
        <IconX size={40} color="#f03e3e" />
        <h1>Can't accept this invite</h1>
        <p>This email address can't be used to sign in to Civitai.</p>
      </div>
    {:else if form?.error === 'expired' || !data.invite}
      <div class="notice" role="alert">
        <IconX size={40} color="#f03e3e" />
        <h1>This invite has expired</h1>
        <p>The link has already been used or is no longer valid. Ask whoever invited you to send a new one.</p>
      </div>
    {:else}
      <div class="notice">
        <IconMailOpened size={40} color="#4285f4" />
        <h1>You're invited to {data.invite.appName}</h1>
        <p>Accept to sign in as <strong>{data.invite.email}</strong>. If you don't have a Civitai account yet, one is created for you.</p>
      </div>
      <!-- A native submit so the browser follows the redirect to the app on another origin. -->
      <form
        method="POST"
        onsubmit={(e) => {
          if (submitting) e.preventDefault();
          else submitting = true;
        }}
      >
        <input type="hidden" name="token" value={data.invite.token} />
        <button type="submit" class="btn primary" disabled={submitting}>
          {submitting ? 'Signing in…' : 'Accept invite'}
        </button>
      </form>
    {/if}
  </div>
</main>

<style>
  main {
    height: 100%;
    width: 100%;
    display: grid;
    place-items: center;
    background: #0b0c10;
    color: #e8eaed;
    font-family: system-ui, sans-serif;
  }
  .card {
    width: 100%;
    max-width: 380px;
    padding: 1.25rem;
    border-radius: 12px;
    background: #16181d;
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.4);
  }
  .brand {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.6rem;
    margin-bottom: 1.25rem;
  }
  .badge {
    display: inline-flex;
    width: 34px;
  }
  .wordmark {
    display: inline-flex;
    width: 118px;
  }
  .badge :global(svg),
  .wordmark :global(svg) {
    display: block;
    width: 100%;
    height: auto;
  }
  h1 {
    font-size: 1.2rem;
    font-weight: 700;
    margin: 0;
  }
  .notice {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 0.5rem;
  }
  .notice p {
    margin: 0;
    color: #9aa0a6;
    font-size: 0.9rem;
    overflow-wrap: anywhere;
  }
  .notice strong {
    color: #e8eaed;
  }
  form {
    margin-top: 1.25rem;
  }
  .btn {
    width: 100%;
    padding: 0.65rem 1rem;
    border: 0;
    border-radius: 8px;
    font-weight: 600;
    font-size: 0.95rem;
    cursor: pointer;
  }
  .btn.primary {
    background: #4285f4;
    color: #fff;
  }
  .btn.primary:hover:not(:disabled) {
    background: color-mix(in srgb, #4285f4, white 8%);
  }
  .btn:disabled {
    cursor: progress;
    opacity: 0.7;
  }
</style>
