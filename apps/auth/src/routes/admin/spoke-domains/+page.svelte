<script lang="ts">
  import { enhance } from '$app/forms';
  import { IconPlus, IconDeviceFloppy, IconTrash, IconCheck, IconAlertTriangle } from '@tabler/icons-svelte';
  import type { PageData, ActionData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  // The three actions return slightly different shapes; widen to a single optional record so the template
  // can read fields without fighting the generated discriminated union.
  type FormResult = {
    action?: 'create' | 'update' | 'delete';
    success?: boolean;
    error?: string;
    id?: number;
    domain?: string;
    values?: { includeSubdomains?: boolean; enabled?: boolean; label?: string };
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

  // Form result helpers.
  const createError = $derived(f?.action === 'create' ? (f.error ?? null) : null);
  const createValues = $derived(f?.action === 'create' ? f.values : undefined);
  const rowError = (id: number) =>
    f && (f.action === 'update' || f.action === 'delete') && f.id === id ? (f.error ?? null) : null;
</script>

<header class="head">
  <div>
    <h1>Spoke Domains</h1>
    <p>
      Hosts allowed to drive <strong>first-party OAuth login</strong> — these skip the consent screen and
      are the only origins whose authorization code can be exchanged for a session. Store a <em>bare host</em>
      (no scheme or port). Turn on <strong>subdomains</strong> only for a preview zone like
      <code>civitaic.com</code> (covers ephemeral <code>pr-2468.civitaic.com</code> hosts).
    </p>
  </div>
</header>

<!-- Add -->
<section class="panel">
  <h2>Add a domain</h2>
  <form method="POST" action="?/create" use:enhance class="add-form">
    <div class="field grow">
      <label for="new-domain">Domain</label>
      <input id="new-domain" name="domain" placeholder="test-auth.civitai.red" autocomplete="off" spellcheck="false" required />
    </div>
    <div class="field grow">
      <label for="new-label">Label <span class="muted">(optional)</span></label>
      <input id="new-label" name="label" placeholder="test alias (red)" autocomplete="off" value={createValues?.label ?? ''} />
    </div>
    <label class="check">
      <input type="checkbox" name="includeSubdomains" value="true" checked={createValues?.includeSubdomains ?? false} />
      <span>Subdomains</span>
    </label>
    <label class="check">
      <input type="checkbox" name="enabled" value="true" checked={createValues?.enabled ?? true} />
      <span>Enabled</span>
    </label>
    <button type="submit" class="btn primary"><IconPlus size={16} /> Add</button>
  </form>
  {#if createError}
    <p class="msg error"><IconAlertTriangle size={15} /> {createError}</p>
  {:else if f?.action === 'create' && f?.success}
    <p class="msg ok"><IconCheck size={15} /> Added <code>{f.domain}</code>.</p>
  {/if}
</section>

<!-- List / edit -->
<section class="panel">
  <h2>Registry <span class="count">{data.domains.length}</span></h2>

  {#if data.domains.length === 0}
    <p class="empty">No domains yet — add one above. (The hub also auto-trusts <code>localhost</code> in dev.)</p>
  {:else}
    <div class="table">
      <div class="row header">
        <span>Domain</span>
        <span>Label</span>
        <span class="center">Subdomains</span>
        <span class="center">Enabled</span>
        <span>Updated</span>
        <span></span>
      </div>

      {#each data.domains as d (d.id)}
        <div class="row" class:disabled={!d.enabled}>
          <form method="POST" action="?/update" use:enhance class="row-form">
            <input type="hidden" name="id" value={d.id} />
            <span><input name="domain" value={d.domain} autocomplete="off" spellcheck="false" /></span>
            <span><input name="label" value={d.label ?? ''} placeholder="—" autocomplete="off" /></span>
            <span class="center"><input type="checkbox" name="includeSubdomains" value="true" checked={d.includeSubdomains} /></span>
            <span class="center"><input type="checkbox" name="enabled" value="true" checked={d.enabled} /></span>
            <span class="date">{fmtDate(d.updatedAt)}</span>
            <span class="actions">
              <button type="submit" class="btn icon" title="Save changes"><IconDeviceFloppy size={16} /></button>
            </span>
          </form>
          <form
            method="POST"
            action="?/delete"
            class="delete-form"
            use:enhance={() => async ({ update }) => {
              await update();
            }}
          >
            <input type="hidden" name="id" value={d.id} />
            <button
              type="submit"
              class="btn icon danger"
              title="Delete"
              onclick={(e) => {
                if (!confirm(`Delete "${d.domain}" from the registry?`)) e.preventDefault();
              }}
            >
              <IconTrash size={16} />
            </button>
          </form>
          {#if rowError(d.id)}
            <p class="msg error row-msg"><IconAlertTriangle size={15} /> {rowError(d.id)}</p>
          {:else if f?.success && f.action === 'update' && f.id === d.id}
            <p class="msg ok row-msg"><IconCheck size={15} /> Saved.</p>
          {/if}
        </div>
      {/each}
    </div>
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
  code {
    background: #1b1e24;
    padding: 0.05rem 0.3rem;
    border-radius: 4px;
    font-size: 0.85em;
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
  input:not([type]),
  .field input {
    background: #0f1115;
    border: 1px solid #2a2d34;
    border-radius: 8px;
    color: #e8eaed;
    padding: 0.5rem 0.6rem;
    font-size: 0.9rem;
    width: 100%;
  }
  input:focus {
    outline: none;
    border-color: #4285f4;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.85rem;
    color: #c8ccd0;
    padding-bottom: 0.55rem;
    white-space: nowrap;
  }

  /* Table */
  .table {
    display: flex;
    flex-direction: column;
  }
  .row {
    display: grid;
    grid-template-columns: 1.6fr 1.4fr 0.8fr 0.7fr 0.9fr auto;
    align-items: center;
    gap: 0.5rem;
    padding: 0.35rem 0;
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
  .row.disabled .row-form input[name='domain'] {
    color: #6b7177;
    text-decoration: line-through;
  }
  .row-form {
    display: contents;
  }
  .row .center {
    text-align: center;
  }
  .row .date {
    font-size: 0.8rem;
    color: #9aa0a6;
  }
  .row .actions {
    display: flex;
    justify-content: flex-end;
  }
  .delete-form {
    display: flex;
    justify-content: flex-end;
    align-self: center;
  }
  .row-msg {
    grid-column: 1 / -1;
    margin: 0.2rem 0 0.4rem;
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
  .btn.icon:hover {
    background: #232730;
    color: #e8eaed;
  }
  .btn.icon.danger:hover {
    background: #3a1d1f;
    border-color: #f03e3e;
    color: #ff8787;
  }

  /* Messages */
  .msg {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin: 0.75rem 0 0;
    font-size: 0.85rem;
  }
  .msg.error {
    color: #ffa8a8;
  }
  .msg.ok {
    color: #69db7c;
  }
  .empty {
    margin: 0;
    color: #9aa0a6;
    font-size: 0.9rem;
  }
</style>
