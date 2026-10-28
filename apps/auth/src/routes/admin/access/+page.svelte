<script lang="ts">
  import { enhance } from '$app/forms';
  import { IconCheck, IconAlertTriangle, IconSearch, IconKey } from '@tabler/icons-svelte';
  import type { SubmitFunction } from '@sveltejs/kit';
  import type { PageData, ActionData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  type FormResult = {
    action?: 'setMode' | 'setSkipConsent' | 'setTokenRateLimit' | 'moveToSystem' | 'createSystemApp';
    success?: boolean;
    error?: string;
    id?: string;
    name?: string;
    clientSecret?: string | null;
  };
  const f = $derived((form ?? null) as unknown as FormResult | null);
  const created = $derived(f?.action === 'createSystemApp' && f.success ? f : null);
  // A confidential app moved to the system account gets a new secret, shown once.
  const movedSecret = $derived(f?.action === 'moveToSystem' && f.success ? (f.clientSecret ?? null) : null);
  const createError = $derived(f?.action === 'createSystemApp' ? (f.error ?? null) : null);

  const MODE_LABEL: Record<string, string> = {
    open: 'Open — anyone',
    testers: 'Testers only',
    disabled: 'Disabled — no one',
  };

  // The last save on this row: one status per app, whichever of its settings was changed.
  const rowResult = (id: string) => (f?.id === id && f.action !== 'createSystemApp' ? f : null);

  // Through use:enhance, which ignores a prevented submit event, so cancelling has to go through its cancel().
  const confirmMove =
    (name: string): SubmitFunction =>
    ({ cancel }) => {
      const message = `Move ${name} to the civitai system account?\n\nIts owner will no longer see or manage it from their OAuth Apps. A confidential app gets a new secret, shown once, and its old one stops working.`;
      if (!confirm(message)) cancel();
    };

  // A refused toggle leaves the data unchanged, so put the checkbox back to match it.
  const revertToggleOnFailure: SubmitFunction =
    ({ formElement }) =>
    async ({ result, update }) => {
      if (result.type === 'failure') {
        const box = formElement.querySelector<HTMLInputElement>('input[type=checkbox]');
        if (box) box.checked = !box.checked;
      }
      await update();
    };

  type App = (typeof data.system)[number];
</script>

<header class="head">
  <div>
    <h1>OAuth Apps</h1>
    <p>
      <strong>System apps</strong> are the OAuth apps Civitai runs, owned by the civitai system account. Only
      they can <strong>skip consent</strong> (signed-in users go straight through, no consent screen) or have
      their own <strong>token limit</strong> per minute once past the per-IP limit (blank = the per-IP limit
      only). <strong>Access</strong> gates who can log into any app: <strong>Open</strong> (default),
      <strong>Testers only</strong> (the tester role) or <strong>Disabled</strong>. Skip consent and the token
      limit need a confidential app (one with a secret); public apps such as the CLI always show consent and
      use the per-IP limit, which already falls on each user's own address. First-party sites
      (civitai.com / civitai.red) are never listed here.
    </p>
  </div>
</header>

{#snippet status(id: string)}
  {@const result = rowResult(id)}
  <span class="status">
    {#if result?.success}
      <span class="msg ok"><IconCheck size={15} /> Saved</span>
    {:else if result?.error}
      <span class="msg error"><IconAlertTriangle size={15} /> {result.error}</span>
    {/if}
  </span>
{/snippet}

{#snippet appName(c: App)}
  <span class="name">
    {c.name}
    {#if c.isVerified}<span class="badge">verified</span>{/if}
    <span class="cid">{c.id}</span>
  </span>
{/snippet}

{#snippet accessForm(c: App)}
  <form method="POST" action="?/setMode" use:enhance class="inline-form">
    <input type="hidden" name="id" value={c.id} />
    <select name="accessMode" value={c.accessMode} onchange={(e) => e.currentTarget.form?.requestSubmit()}>
      {#each Object.entries(MODE_LABEL) as [value, label] (value)}
        <option {value}>{label}</option>
      {/each}
    </select>
  </form>
{/snippet}

<!-- System apps -->
<section class="panel">
  <h2>System apps <span class="count">{data.system.length}</span></h2>
  {#if movedSecret}
    <div class="created">
      <p class="msg ok"><IconCheck size={15} /> Moved to the system account, with a new secret.</p>
      <dl>
        <dt>Client ID</dt>
        <dd><code>{f?.id}</code></dd>
        <dt><IconKey size={14} /> Client secret</dt>
        <dd><code>{movedSecret}</code></dd>
      </dl>
      <p class="warn">Copy the secret now and update the app. It is shown only once, and the old one no longer works.</p>
    </div>
  {/if}
  {#if data.system.length === 0}
    <p class="empty">No system apps yet. Register one below, or move an existing app to the system account.</p>
  {:else}
    <div class="table">
      <div class="row system header">
        <span>Application</span><span>Access</span><span>Consent</span><span>Token limit / min</span><span></span>
      </div>
      {#each data.system as c (c.id)}
        <div class="row system">
          {@render appName(c)}
          {@render accessForm(c)}
          {#if c.isConfidential}
            <form method="POST" action="?/setSkipConsent" use:enhance={revertToggleOnFailure} class="inline-form">
              <input type="hidden" name="id" value={c.id} />
              <input type="hidden" name="skipConsent" value={c.skipConsent ? 'false' : 'true'} />
              <label class="toggle">
                <input type="checkbox" checked={c.skipConsent} onchange={(e) => e.currentTarget.form?.requestSubmit()} />
                <span>Skip</span>
              </label>
            </form>
            <form method="POST" action="?/setTokenRateLimit" use:enhance class="inline-form limit-form">
              <input type="hidden" name="id" value={c.id} />
              <input
                type="number"
                name="tokenRateLimit"
                min="1"
                step="1"
                placeholder="Per-IP"
                value={c.tokenRateLimit ?? ''}
                aria-label="Token limit per minute"
              />
              <button type="submit" class="btn small">Save</button>
            </form>
          {:else}
            <!-- Both settings need a secret: a public app always shows consent and gets the per-IP limit. -->
            <span class="na" title="A public app (no secret) always shows the consent screen">Always shown</span>
            <span class="na" title="Only an app that proves its secret gets its own limit">Per-IP (no secret)</span>
          {/if}
          {@render status(c.id)}
        </div>
      {/each}
    </div>
  {/if}
</section>

<!-- Register a system app -->
<section class="panel">
  <h2>Register a system app</h2>
  {#if created}
    <div class="created">
      <p class="msg ok"><IconCheck size={15} /> Registered <strong>{created.name}</strong>.</p>
      <dl>
        <dt>Client ID</dt>
        <dd><code>{created.id}</code></dd>
        {#if created.clientSecret}
          <dt><IconKey size={14} /> Client secret</dt>
          <dd><code>{created.clientSecret}</code></dd>
        {/if}
      </dl>
      {#if created.clientSecret}
        <p class="warn">Copy the secret now. It is shown only once and cannot be recovered.</p>
      {/if}
    </div>
  {/if}
  <form method="POST" action="?/createSystemApp" use:enhance class="create-form">
    <label>
      <span>Name</span>
      <input name="name" required maxlength="100" autocomplete="off" />
    </label>
    <label>
      <span>Description <small>(optional)</small></span>
      <input name="description" maxlength="500" autocomplete="off" />
    </label>
    <label>
      <span>Redirect URIs <small>(one per line; https, or http on localhost)</small></span>
      <textarea
        name="redirectUris"
        rows="3"
        required
        placeholder="https://advertising.civitai.com/auth/callback"
      ></textarea>
    </label>
    <label class="toggle">
      <input type="checkbox" name="isConfidential" value="true" checked />
      <span>Confidential (a server-side app with a client secret)</span>
    </label>
    <fieldset class="scopes">
      <legend>Scopes the app may request</legend>
      {#each data.scopeOptions as o (o.bit)}
        <label class="toggle">
          {#if o.bit === data.userReadBit}
            <!-- UserRead is always granted -->
            <input type="checkbox" checked disabled />
          {:else}
            <input type="checkbox" name="scope" value={o.bit} />
          {/if}
          <span>{o.label}</span>
        </label>
      {/each}
    </fieldset>
    {#if createError}
      <p class="msg error"><IconAlertTriangle size={15} /> {createError}</p>
    {/if}
    <button type="submit" class="btn primary">Register system app</button>
  </form>
</section>

<!-- Other apps -->
<section class="panel">
  <h2>Other apps</h2>
  <p class="sub">Find any other app by name or id, to gate its login or move it to the system account.</p>

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
          <div class="row other header"><span>Application</span><span>Access</span><span></span><span></span></div>
          {#each data.searchResults as c (c.id)}
            <div class="row other">
              {@render appName(c)}
              {@render accessForm(c)}
              <form method="POST" action="?/moveToSystem" use:enhance={confirmMove(c.name)} class="inline-form">
                <input type="hidden" name="id" value={c.id} />
                <button type="submit" class="btn small">Move to system</button>
              </form>
              {@render status(c.id)}
            </div>
          {/each}
        </div>
      {/if}
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
    margin-bottom: 0.25rem;
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
  select:focus,
  textarea:focus {
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
    align-items: center;
    gap: 0.75rem;
    padding: 0.45rem 0;
    border-top: 1px solid #2a2d34;
  }
  .row.system {
    grid-template-columns: 2fr 1.3fr 0.7fr 1.3fr auto;
  }
  .row.other {
    grid-template-columns: 2fr 1.3fr auto auto;
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
  .inline-form {
    margin: 0;
  }
  .limit-form {
    display: flex;
    gap: 0.4rem;
  }
  .limit-form input {
    width: 6.5rem;
    background: #0f1115;
    border: 1px solid #2a2d34;
    border-radius: 8px;
    color: #e8eaed;
    padding: 0.45rem 0.6rem;
    font-size: 0.9rem;
  }
  .toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.85rem;
    color: #c8ccd0;
    cursor: pointer;
  }
  .status {
    min-width: 80px;
  }
  .na {
    font-size: 0.8rem;
    color: #6b7177;
  }

  /* Register form */
  .create-form {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    max-width: 640px;
  }
  .create-form label:not(.toggle) {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    font-size: 0.85rem;
    color: #c8ccd0;
  }
  .create-form small {
    color: #6b7177;
  }
  .create-form input:not([type='checkbox']),
  .create-form textarea {
    background: #0f1115;
    border: 1px solid #2a2d34;
    border-radius: 8px;
    color: #e8eaed;
    padding: 0.5rem 0.7rem;
    font-size: 0.9rem;
    font-family: inherit;
  }
  .create-form .btn {
    align-self: flex-start;
  }
  .scopes {
    margin: 0;
    border: 1px solid #2a2d34;
    border-radius: 8px;
    padding: 0.6rem 0.8rem;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 0.35rem 1rem;
  }
  .scopes legend {
    font-size: 0.8rem;
    color: #9aa0a6;
    padding: 0 0.3rem;
  }
  .created {
    background: #0f1115;
    border: 1px solid #2a2d34;
    border-radius: 8px;
    padding: 0.8rem 1rem;
    margin-bottom: 1rem;
  }
  .created dl {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.35rem 1rem;
    margin: 0.6rem 0;
    font-size: 0.85rem;
  }
  .created dt {
    color: #9aa0a6;
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
  }
  .created dd {
    margin: 0;
    word-break: break-all;
  }
  .warn {
    margin: 0;
    color: #ffd43b;
    font-size: 0.85rem;
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
  .btn.small {
    background: #1b1e24;
    color: #e8eaed;
    border: 1px solid #2a2d34;
    padding: 0.4rem 0.7rem;
    font-size: 0.85rem;
  }
  .btn.small:hover {
    background: #23262d;
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
