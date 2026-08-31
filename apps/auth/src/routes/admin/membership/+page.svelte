<script lang="ts">
  import { enhance } from '$app/forms';
  import { IconCrown, IconTrash } from '@tabler/icons-svelte';
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
  <h1>Membership Overrides</h1>
  <p>
    Comp a membership tier without a subscription. The tier is folded into the session the hub produces, so
    it unlocks everything that reads <code>session.tier</code> — feature flags, tier gating, member-only UI,
    no ads. It does <strong>not</strong> grant subscription-derived perks: monthly Buzz, vault storage, the
    membership badge, or the rewards multiplier. An override only ever raises a tier, so comping someone who
    already pays for a higher one changes nothing.
  </p>
</header>

{#if form?.message}
  <p class="flash ok">{form.message}</p>
{:else if form?.error}
  <p class="flash error">{form.error}</p>
{/if}

<section class="panel">
  <h2>Grant a tier</h2>
  <form method="POST" action="?/set" use:enhance class="add-form">
    <div class="field grow">
      <label for="user">User <span class="muted">(id or username)</span></label>
      <input id="user" name="user" placeholder="e.g. 1 or alice" autocomplete="off" />
    </div>
    <div class="field">
      <label for="tier">Tier</label>
      <select id="tier" name="tier">
        {#each data.tiers as tier (tier)}
          <option value={tier}>{tier}</option>
        {/each}
      </select>
    </div>
    <div class="field grow">
      <label for="note">Note <span class="muted">(optional)</span></label>
      <input id="note" name="note" placeholder="why they're comped" autocomplete="off" />
    </div>
    <button type="submit" class="btn primary"><IconCrown size={16} /> Grant</button>
  </form>
  <p class="hint">Granting again for the same user replaces their existing override.</p>
</section>

<section class="panel">
  <h2>Active overrides <span class="count">{data.overrides.length}</span></h2>
  {#if data.overrides.length === 0}
    <p class="empty">No overrides — grant one above.</p>
  {:else}
    <div class="table">
      <div class="row header">
        <span>User</span><span>Tier</span><span>Note</span><span>Granted by</span><span>Granted</span><span></span>
      </div>
      {#each data.overrides as o (o.userId)}
        <div class="row">
          <span class="name">{o.username ?? `user #${o.userId}`} <span class="cid">#{o.userId}</span></span>
          <span class="tier">{o.tier}</span>
          <span class="note">{o.note ?? '—'}</span>
          <span class="note">{o.grantedByUsername ?? '—'}</span>
          <span class="date">{fmtDate(o.createdAt)}</span>
          <form method="POST" action="?/remove" use:enhance class="delete-form">
            <input type="hidden" name="userId" value={o.userId} />
            <button
              type="submit"
              class="btn icon danger"
              aria-label="Remove override"
              title="Remove override"
              onclick={(e) => {
                if (!confirm(`Remove the ${o.tier} override for ${o.username ?? `user #${o.userId}`}?`))
                  e.preventDefault();
              }}
            >
              <IconTrash size={15} />
            </button>
          </form>
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
  .field select {
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
  .hint {
    margin: 0.75rem 0 0;
    font-size: 0.8rem;
    color: #6b7177;
  }
  .table {
    display: flex;
    flex-direction: column;
  }
  .row {
    display: grid;
    grid-template-columns: 1.4fr 0.6fr 1.4fr 1fr 0.8fr auto;
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
  .tier {
    font-size: 0.8rem;
    font-weight: 600;
    color: #ffd43b;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }
  .note {
    color: #c8ccd0;
    font-size: 0.88rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
