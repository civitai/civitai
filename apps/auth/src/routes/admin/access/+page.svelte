<script lang="ts">
  import { enhance } from '$app/forms';
  import { IconCheck, IconAlertTriangle, IconSearch } from '@tabler/icons-svelte';
  import type { PageData, ActionData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  type FormResult = {
    action?: 'setMode';
    success?: boolean;
    error?: string;
    id?: string;
    accessMode?: string;
  };
  const f = $derived((form ?? null) as unknown as FormResult | null);

  const MODE_LABEL: Record<string, string> = {
    open: 'Open — anyone',
    testers: 'Testers only',
    disabled: 'Disabled — no one',
  };

  const modeError = (id: string) => (f?.action === 'setMode' && f.id === id ? (f.error ?? null) : null);
</script>

<header class="head">
  <div>
    <h1>OAuth Access</h1>
    <p>
      Gate who can log into each OAuth application. <strong>Open</strong> lets anyone in (default);
      <strong>Testers only</strong> restricts login to the tester allowlist below; <strong>Disabled</strong>
      blocks everyone. First-party sites (civitai.com / civitai.red) are never gated here — only registered
      third-party apps like the Comfy desktop/cloud app.
    </p>
  </div>
</header>

{#snippet clientRow(c: (typeof data.gated)[number])}
  <div class="row">
    <span class="name">
      {c.name}
      {#if c.isVerified}<span class="badge">verified</span>{/if}
      <span class="cid">{c.id}</span>
    </span>
    <form method="POST" action="?/setMode" use:enhance class="mode-form">
      <input type="hidden" name="id" value={c.id} />
      <select name="accessMode" value={c.accessMode} onchange={(e) => e.currentTarget.form?.requestSubmit()}>
        {#each Object.entries(MODE_LABEL) as [value, label] (value)}
          <option {value}>{label}</option>
        {/each}
      </select>
    </form>
    <span class="status">
      {#if f?.success && f.action === 'setMode' && f.id === c.id}
        <span class="msg ok"><IconCheck size={15} /> Saved</span>
      {:else if modeError(c.id)}
        <span class="msg error"><IconAlertTriangle size={15} /> {modeError(c.id)}</span>
      {/if}
    </span>
  </div>
{/snippet}

<!-- Applications -->
<section class="panel">
  <h2>Gated applications <span class="count">{data.gated.length}</span></h2>
  <p class="sub">
    Only restricted apps (testers-only or disabled) are listed. Open apps are hidden — search to find one and
    change its access.
  </p>

  <form method="GET" class="search-form">
    <input type="search" name="q" placeholder="Search applications by name or id…" value={data.q} autocomplete="off" />
    <button type="submit" class="btn primary"><IconSearch size={16} /> Search</button>
  </form>

  {#if data.q}
    <div class="results">
      <h3>Results for “{data.q}” <span class="count">{data.searchResults.length}</span></h3>
      {#if data.searchResults.length === 0}
        <p class="empty">No applications match.</p>
      {:else}
        <div class="table">
          <div class="row header"><span>Application</span><span>Access</span><span></span></div>
          {#each data.searchResults as c (c.id)}
            {@render clientRow(c)}
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  {#if data.gated.length === 0}
    <p class="empty">No gated applications — all are open.</p>
  {:else}
    <div class="table">
      <div class="row header"><span>Application</span><span>Access</span><span></span></div>
      {#each data.gated as c (c.id)}
        {@render clientRow(c)}
      {/each}
    </div>
  {/if}
</section>

<!-- Tester membership moved to the generic roles admin. -->
<section class="panel">
  <h2>Testers</h2>
  <p class="sub">
    Who holds the <code>tester</code> role (what <strong>Testers only</strong> mode allows) is managed on the
    <a href="/admin/roles">Roles</a> page, alongside all other roles.
  </p>
</section>

<style>
  .head h1 {
    margin: 0 0 0.4rem;
    font-size: 1.5rem;
  }
  .head p {
    margin: 0 0 1.5rem;
    max-width: 760px;
    color: #9aa0a6;
    font-size: 0.9rem;
    line-height: 1.5;
  }
  .panel {
    background: #16181d;
    border: 1px solid #2a2d34;
    border-radius: 12px;
    padding: 1.1rem 1.25rem;
    margin-bottom: 1.25rem;
  }
  .panel h2 {
    margin: 0 0 0.9rem;
    font-size: 1.05rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .sub {
    margin: -0.5rem 0 1rem;
    color: #9aa0a6;
    font-size: 0.85rem;
  }
  .search-form {
    display: flex;
    gap: 0.6rem;
    margin-bottom: 1rem;
  }
  .search-form input {
    flex: 1 1 auto;
    background: #0f1115;
    border: 1px solid #2a2d34;
    border-radius: 8px;
    color: #e8eaed;
    padding: 0.5rem 0.7rem;
    font-size: 0.9rem;
  }
  .results {
    margin-bottom: 1.25rem;
    padding-bottom: 1rem;
    border-bottom: 1px solid #2a2d34;
  }
  .results h3 {
    margin: 0 0 0.5rem;
    font-size: 0.9rem;
    color: #c8ccd0;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .count {
    font-size: 0.75rem;
    font-weight: 600;
    color: #9aa0a6;
    background: #1b1e24;
    padding: 0.05rem 0.45rem;
    border-radius: 999px;
  }

  input:focus,
  select:focus {
    outline: none;
    border-color: #4285f4;
  }
  select {
    background: #0f1115;
    border: 1px solid #2a2d34;
    border-radius: 8px;
    color: #e8eaed;
    padding: 0.45rem 0.6rem;
    font-size: 0.9rem;
    cursor: pointer;
  }

  /* Tables */
  .table {
    display: flex;
    flex-direction: column;
  }
  .row {
    display: grid;
    grid-template-columns: 2fr 1.4fr auto;
    align-items: center;
    gap: 0.75rem;
    padding: 0.45rem 0;
    border-top: 1px solid #2a2d34;
  }
  .row.header {
    border-top: 0;
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #6b7177;
    padding-bottom: 0.4rem;
  }
  .name {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .cid {
    font-size: 0.72rem;
    color: #6b7177;
    font-family: ui-monospace, monospace;
  }
  .badge {
    font-size: 0.65rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #69db7c;
    background: #14271a;
    padding: 0.05rem 0.35rem;
    border-radius: 4px;
  }
  .mode-form {
    margin: 0;
  }
  .status {
    min-width: 80px;
  }

  /* Buttons */
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.35rem;
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

  /* Messages */
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
  .empty {
    margin: 0.5rem 0 0;
    color: #9aa0a6;
    font-size: 0.9rem;
  }
</style>
