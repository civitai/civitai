<script lang="ts">
  import { enhance } from '$app/forms';
  import { IconUserPlus, IconTrash, IconArrowLeft } from '@tabler/icons-svelte';
  import type { PageData, ActionData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

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
</script>

<header class="head">
  <a class="back" href="/admin/roles"><IconArrowLeft size={15} /> Roles</a>
  <h1><code>{data.role.id}</code></h1>
  {#if data.role.description}<p>{data.role.description}</p>{/if}
</header>

{#if form?.message}
  <p class="flash ok">{form.message}</p>
{:else if form?.error}
  <p class="flash error">{form.error}</p>
{/if}

<section class="panel">
  <h2>Add member</h2>
  <form method="POST" action="?/add" use:enhance class="add-form">
    <div class="field grow">
      <label for="user">User <span class="muted">(id or username)</span></label>
      <input id="user" name="user" placeholder="e.g. 1 or alice" autocomplete="off" />
    </div>
    <div class="field grow">
      <label for="note">Note <span class="muted">(optional)</span></label>
      <input id="note" name="note" autocomplete="off" />
    </div>
    <button type="submit" class="btn primary"><IconUserPlus size={16} /> Add</button>
  </form>
</section>

<section class="panel">
  <h2>Members <span class="count">{data.members.length}</span></h2>
  {#if data.members.length === 0}
    <p class="empty">No members yet — add one above.</p>
  {:else}
    <div class="table">
      <div class="row header"><span>User</span><span>Note</span><span>Added</span><span></span></div>
      {#each data.members as m (m.userId)}
        <div class="row">
          <span class="name">{m.username ?? `user #${m.userId}`} <span class="cid">#{m.userId}</span></span>
          <span class="note">{m.note ?? '—'}</span>
          <span class="date">{fmtDate(m.createdAt)}</span>
          <form method="POST" action="?/remove" use:enhance class="delete-form">
            <input type="hidden" name="userId" value={m.userId} />
            <button type="submit" class="btn icon danger" aria-label="Remove member" title="Remove member">
              <IconTrash size={15} />
            </button>
          </form>
        </div>
      {/each}
    </div>
  {/if}
</section>

<style>
  .back {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    color: #9aa0a6;
    font-size: 0.85rem;
    text-decoration: none;
    margin-bottom: 0.6rem;
  }
  .back:hover {
    color: #c8ccd0;
  }
  .head h1 {
    margin: 0 0 0.4rem;
    font-size: 1.4rem;
  }
  .head code {
    font-family: ui-monospace, monospace;
    color: #8ab4f8;
  }
  .head p {
    margin: 0 0 1.5rem;
    color: #9aa0a6;
    font-size: 0.9rem;
  }
  .flash {
    margin: 0 0 1.25rem;
    padding: 0.6rem 0.85rem;
    border-radius: 8px;
    font-size: 0.88rem;
    border: 1px solid;
  }
  .flash.ok {
    color: #69db7c;
    background: #14271a;
    border-color: #2f6b3f;
  }
  .flash.error {
    color: #ffa8a8;
    background: #3a1d1f;
    border-color: #7a2e30;
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
  input:focus {
    outline: none;
    border-color: #4285f4;
  }
  .table {
    display: flex;
    flex-direction: column;
  }
  .row {
    display: grid;
    grid-template-columns: 1.6fr 1.6fr 0.8fr auto;
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
  .note {
    color: #c8ccd0;
    font-size: 0.88rem;
  }
  .date {
    font-size: 0.8rem;
    color: #9aa0a6;
  }
  .delete-form {
    display: flex;
    justify-content: flex-end;
  }
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
  .empty {
    margin: 0.5rem 0 0;
    color: #9aa0a6;
    font-size: 0.9rem;
  }
</style>
