<script lang="ts">
  import { enhance } from '$app/forms';
  import { IconPlus, IconTrash, IconChevronRight } from '@tabler/icons-svelte';
  import type { PageData, ActionData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<header class="head">
  <h1>Roles</h1>
  <p>
    Create a role, then open it to manage members. Roles are stored in <code>UserRole</code> and delivered
    on the session to every spoke; each app decides what its roles unlock.
  </p>
</header>

{#if form?.message}
  <p class="flash ok">{form.message}</p>
{:else if form?.error}
  <p class="flash error">{form.error}</p>
{/if}

<section class="panel">
  <h2>Create a role</h2>
  <form method="POST" action="?/create" use:enhance class="add-form">
    <div class="field">
      <label for="app">App</label>
      <select id="app" name="app">
        {#each data.apps as app (app)}
          <option value={app}>{app}</option>
        {/each}
      </select>
    </div>
    <div class="field">
      <label for="name">Role name</label>
      <input id="name" name="name" placeholder="e.g. volunteer" autocomplete="off" />
    </div>
    <div class="field grow">
      <label for="description">Description <span class="muted">(optional)</span></label>
      <input id="description" name="description" autocomplete="off" />
    </div>
    <button type="submit" class="btn primary"><IconPlus size={16} /> Create</button>
  </form>
</section>

<section class="panel">
  <h2>All roles <span class="count">{data.roles.length}</span></h2>
  {#if data.roles.length === 0}
    <p class="empty">No roles yet — create one above.</p>
  {:else}
    <div class="table">
      <div class="row header"><span>Role</span><span>Members</span><span></span></div>
      {#each data.roles as role (role.id)}
        <div class="row">
          <a class="role" href={`/admin/roles/${encodeURIComponent(role.id)}`}>
            <code>{role.id}</code>
            {#if role.description}<span class="desc">{role.description}</span>{/if}
          </a>
          <span class="members">{role.memberCount}</span>
          <span class="actions">
            <a class="btn icon" href={`/admin/roles/${encodeURIComponent(role.id)}`} title="Manage members">
              <IconChevronRight size={16} />
            </a>
            <form method="POST" action="?/delete" use:enhance>
              <input type="hidden" name="id" value={role.id} />
              <button
                type="submit"
                class="btn icon danger"
                title="Delete role"
                onclick={(e) => {
                  if (!confirm(`Delete ${role.id} and all its members?`)) e.preventDefault();
                }}
              >
                <IconTrash size={15} />
              </button>
            </form>
          </span>
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
    font-family: ui-monospace, monospace;
    font-size: 0.85em;
    color: #8ab4f8;
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
  .field input,
  select {
    background: #0f1115;
    border: 1px solid #2a2d34;
    border-radius: 8px;
    color: #e8eaed;
    padding: 0.5rem 0.6rem;
    font-size: 0.9rem;
    width: 100%;
  }
  select {
    cursor: pointer;
  }
  input:focus,
  select:focus {
    outline: none;
    border-color: #4285f4;
  }
  .table {
    display: flex;
    flex-direction: column;
  }
  .row {
    display: grid;
    grid-template-columns: 1fr auto auto;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem 0;
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
  .role {
    display: flex;
    align-items: baseline;
    gap: 0.6rem;
    flex-wrap: wrap;
    text-decoration: none;
  }
  .role:hover code {
    text-decoration: underline;
  }
  .desc {
    color: #9aa0a6;
    font-size: 0.85rem;
  }
  .members {
    color: #c8ccd0;
    font-size: 0.9rem;
    min-width: 3ch;
    text-align: right;
  }
  .actions {
    display: flex;
    gap: 0.4rem;
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
