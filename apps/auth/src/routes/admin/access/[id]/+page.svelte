<script lang="ts">
  import { enhance } from '$app/forms';
  import { IconArrowLeft, IconCheck, IconAlertTriangle } from '@tabler/icons-svelte';
  import type { PageData, ActionData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();
  const c = $derived(data.client);
</script>

<svelte:head><title>{c.name} · OAuth Apps</title></svelte:head>

<header class="head">
  <a class="back" href="/admin/access"><IconArrowLeft size={15} /> OAuth Apps</a>
  <h1>{c.name}</h1>
  <p class="cid">{c.id} · {c.isConfidential ? 'confidential' : 'public'}{c.skipConsent ? ' · skips consent' : ''}</p>
</header>

<section class="panel">
  <!-- Keep what was typed after a refused save; a successful one reloads the saved values. -->
  <form method="POST" use:enhance={() => async ({ update }) => update({ reset: false })} class="edit-form">
    <label>
      <span>Name</span>
      <input name="name" required maxlength="100" autocomplete="off" value={c.name} />
    </label>
    <label>
      <span>Description <small>(optional)</small></span>
      <input name="description" maxlength="500" autocomplete="off" value={c.description} />
    </label>
    <label>
      <span>Redirect URIs <small>(one per line; https, or http on localhost)</small></span>
      <textarea name="redirectUris" rows="4" required value={c.redirectUris.join('\n')}></textarea>
    </label>
    <p class="note">
      Allowed origins (where the app's browser requests and invite return URLs may come from) follow the
      redirect URIs; any other allowed origin is kept. Now: {c.allowedOrigins.join(', ') || 'none'}.
      {#if c.skipConsent}This app skips consent, so every URI must be https and not localhost.{/if}
    </p>
    <div class="actions">
      <button type="submit" class="btn primary">Save</button>
      {#if form?.success}
        <span class="msg ok" role="status"><IconCheck size={15} /> Saved</span>
      {:else if form?.error}
        <span class="msg error" role="alert"><IconAlertTriangle size={15} /> {form.error}</span>
      {/if}
    </div>
  </form>
</section>

<style>
  .head {
    margin-bottom: 1.25rem;
  }
  .back {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    color: #9aa0a6;
    font-size: 0.85rem;
    text-decoration: none;
  }
  .back:hover {
    color: #e8eaed;
  }
  .head h1 {
    margin: 0.4rem 0 0.2rem;
    font-size: 1.5rem;
  }
  .cid {
    margin: 0;
    font-size: 0.75rem;
    color: #6b7177;
    font-family: ui-monospace, monospace;
  }
  .panel {
    background: #16181d;
    border: 1px solid #2a2d34;
    border-radius: 12px;
    padding: 1.1rem 1.25rem;
  }
  .edit-form {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    max-width: 640px;
  }
  .edit-form label {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    font-size: 0.85rem;
    color: #c8ccd0;
  }
  small {
    color: #6b7177;
  }
  input,
  textarea {
    background: #0f1115;
    border: 1px solid #2a2d34;
    border-radius: 8px;
    color: #e8eaed;
    padding: 0.5rem 0.7rem;
    font-size: 0.9rem;
    font-family: inherit;
  }
  input:focus,
  textarea:focus {
    outline: none;
    border-color: #4285f4;
  }
  .note {
    margin: 0;
    color: #9aa0a6;
    font-size: 0.8rem;
    line-height: 1.5;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
  }
  .btn {
    border: 0;
    border-radius: 8px;
    font-weight: 600;
    font-size: 0.9rem;
    cursor: pointer;
  }
  .btn.primary {
    background: #4285f4;
    color: #fff;
    padding: 0.55rem 0.9rem;
  }
  .btn.primary:hover {
    background: color-mix(in srgb, #4285f4, white 8%);
  }
  .msg {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.85rem;
  }
  .msg.error {
    color: #ffa8a8;
  }
  .msg.ok {
    color: #69db7c;
  }
</style>
