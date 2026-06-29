<script lang="ts">
  import { enhance } from '$app/forms';
  import { IconPlus, IconTrash, IconCheck, IconAlertTriangle, IconSearch } from '@tabler/icons-svelte';
  import type { PageData, ActionData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  type FormResult = {
    action?: 'setMode' | 'addTester' | 'removeTester';
    success?: boolean;
    error?: string;
    id?: string;
    userId?: number;
    username?: string;
    accessMode?: string;
  };
  const f = $derived((form ?? null) as unknown as FormResult | null);

  const fmtDate = (d: unknown) => {
    try {
      return new Date(d as string | Date).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
    } catch {
      return '';
    }
  };

  const MODE_LABEL: Record<string, string> = {
    open: 'Open — anyone',
    testers: 'Testers only',
    disabled: 'Disabled — no one',
  };

  const addError = $derived(f?.action === 'addTester' ? (f.error ?? null) : null);
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

<!-- Testers -->
<section class="panel">
  <h2>Testers <span class="count">{data.testers.length}</span></h2>
  <p class="sub">
    The global tester allowlist. Any application set to <strong>Testers only</strong> lets these users in.
  </p>

  <form method="POST" action="?/addTester" use:enhance class="add-form">
    <div class="field grow">
      <label for="new-user">User</label>
      <input id="new-user" name="user" placeholder="username or user id" autocomplete="off" spellcheck="false" required />
    </div>
    <div class="field grow">
      <label for="new-note">Note <span class="muted">(optional)</span></label>
      <input id="new-note" name="note" placeholder="e.g. comfy cloud beta" autocomplete="off" />
    </div>
    <button type="submit" class="btn primary"><IconPlus size={16} /> Add</button>
  </form>
  {#if addError}
    <p class="msg error"><IconAlertTriangle size={15} /> {addError}</p>
  {:else if f?.action === 'addTester' && f?.success}
    <p class="msg ok"><IconCheck size={15} /> Added {f.username}.</p>
  {/if}

  {#if data.testers.length > 0}
    <div class="table testers">
      <div class="row header">
        <span>User</span>
        <span>Note</span>
        <span>Added</span>
        <span></span>
      </div>
      {#each data.testers as t (t.userId)}
        <div class="row">
          <span class="name">{t.username ?? `user #${t.userId}`} <span class="cid">#{t.userId}</span></span>
          <span class="note">{t.note ?? '—'}</span>
          <span class="date">{fmtDate(t.createdAt)}</span>
          <form
            method="POST"
            action="?/removeTester"
            class="delete-form"
            use:enhance={() => async ({ update }) => {
              await update();
            }}
          >
            <input type="hidden" name="userId" value={t.userId} />
            <button
              type="submit"
              class="btn icon danger"
              title="Remove tester"
              onclick={(e) => {
                if (!confirm(`Remove ${t.username ?? `user #${t.userId}`} from testers?`)) e.preventDefault();
              }}
            >
              <IconTrash size={16} />
            </button>
          </form>
        </div>
      {/each}
    </div>
  {:else}
    <p class="empty">No testers yet — add one above.</p>
  {/if}
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

  /* Add form */
  .add-form {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 0.75rem;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .field.grow {
    flex: 1 1 200px;
  }
  .field label {
    font-size: 0.78rem;
    color: #9aa0a6;
  }
  .muted {
    color: #6b7177;
  }
  .field input {
    background: #0f1115;
    border: 1px solid #2a2d34;
    border-radius: 8px;
    color: #e8eaed;
    padding: 0.5rem 0.6rem;
    font-size: 0.9rem;
    width: 100%;
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
  .table.testers .row {
    grid-template-columns: 1.6fr 1.6fr 0.8fr auto;
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
  .note {
    color: #c8ccd0;
    font-size: 0.88rem;
  }
  .date {
    font-size: 0.8rem;
    color: #9aa0a6;
  }
  .mode-form {
    margin: 0;
  }
  .status {
    min-width: 80px;
  }
  .delete-form {
    display: flex;
    justify-content: flex-end;
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
  .btn.icon {
    background: #1b1e24;
    color: #c8ccd0;
    border: 1px solid #2a2d34;
    padding: 0.4rem;
  }
  .btn.icon.danger:hover {
    background: #3a1d1f;
    border-color: #f03e3e;
    color: #ff8787;
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
