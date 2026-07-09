<script lang="ts">
  import { buildWordmarkSvg, buildBadgeSvg, getHoliday } from '@civitai/brand';
  import { IconCheck, IconShieldCheck, IconX } from '@tabler/icons-svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const holiday = getHoliday();
  const badgeSvg = buildBadgeSvg({ holiday });
  const wordmarkSvg = buildWordmarkSvg({ base: '#e8eaed' });

  let showSwitcher = $state(false);
  // User images are sometimes bare CDN keys, not URLs — only render an <img> for an absolute URL, else
  // fall back to an initial avatar so the picker never shows a broken image.
  const isUrl = (s: string | undefined) => !!s && /^https?:\/\//.test(s);
  const initial = (username: string | undefined) => (username ?? '?').charAt(0).toUpperCase();
</script>

<main>
  <div class="card">
    <div class="brand">
      <span class="badge">{@html badgeSvg}</span>
      <span class="wordmark">{@html wordmarkSvg}</span>
    </div>

    {#if data.invalid}
      <div class="invalid">
        <IconX size={40} color="#f03e3e" />
        <h1>Invalid application</h1>
        <p>The application you're trying to authorize wasn't found, or its callback URL isn't registered.</p>
      </div>
    {:else}
      <h1>Authorize {data.client.name}</h1>
      {#if data.client.isVerified}
        <p class="verified"><IconShieldCheck size={14} /> Verified by Civitai</p>
      {/if}
      {#if data.client.description}
        <p class="desc">{data.client.description}</p>
      {/if}

      {#if data.accounts.length >= 2 && data.accounts.some((a) => a.active)}
        {@const active = data.accounts.find((a) => a.active)}
        <div class="account">
          <div class="account-current">
            <span class="avatar">
              {#if isUrl(active?.image)}
                <img src={active?.image} alt="" />
              {:else}
                {initial(active?.username)}
              {/if}
            </span>
            <div class="account-meta">
              <span class="account-kicker">Authorizing as</span>
              <span class="account-name">{active?.username ?? `User #${active?.userId}`}</span>
            </div>
            <button type="button" class="switch-toggle" onclick={() => (showSwitcher = !showSwitcher)}>
              {showSwitcher ? 'Cancel' : 'Switch'}
            </button>
          </div>

          {#if showSwitcher}
            <ul class="account-list">
              {#each data.accounts.filter((a) => !a.active) as acc (acc.userId)}
                <li>
                  <form method="POST" action="?/switch">
                    {#each Object.entries(data.params) as [name, value] (name)}
                      <input type="hidden" {name} {value} />
                    {/each}
                    <input type="hidden" name="userId" value={acc.userId} />
                    <button type="submit" class="account-option">
                      <span class="avatar sm">
                        {#if isUrl(acc.image)}
                          <img src={acc.image} alt="" />
                        {:else}
                          {initial(acc.username)}
                        {/if}
                      </span>
                      <span class="account-name">{acc.username ?? `User #${acc.userId}`}</span>
                    </button>
                  </form>
                </li>
              {/each}
            </ul>
          {/if}
        </div>
      {/if}

      <div class="divider"><span>This app will be able to</span></div>

      <ul class="scopes">
        {#each data.scopes as label (label)}
          <li><IconCheck size={16} color="#37b24d" /><span>{label}</span></li>
        {/each}
      </ul>

      <!-- Approve posts straight to the §D protocol endpoint, which issues the code and redirects to
           the client. A native (non-enhanced) submit so SvelteKit follows the cross-route 303. -->
      <form method="POST" action="/api/auth/oauth/authorize" class="approve-form">
        {#each Object.entries(data.params) as [name, value] (name)}
          <input type="hidden" {name} {value} />
        {/each}
        <input type="hidden" name="approved" value="true" />

        <label class="remember">
          <input type="checkbox" name="remember" value="true" checked />
          <span>Remember my decision for this app</span>
        </label>

        <div class="actions">
          <button type="submit" class="btn primary">Authorize</button>
        </div>
      </form>

      <form method="POST" action="?/deny" class="deny-form">
        <input type="hidden" name="client_id" value={data.params.client_id} />
        <input type="hidden" name="redirect_uri" value={data.params.redirect_uri} />
        <input type="hidden" name="state" value={data.params.state ?? ''} />
        <button type="submit" class="btn ghost">Deny</button>
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
    margin: 0 0 0.5rem;
    text-align: center;
  }
  .verified {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.3rem;
    margin: 0 0 0.5rem;
    color: #37b24d;
    font-size: 0.8rem;
    font-weight: 600;
  }
  .desc {
    margin: 0 0 0.5rem;
    text-align: center;
    color: #9aa0a6;
    font-size: 0.875rem;
  }
  .account {
    margin: 1rem 0 0;
    border: 1px solid #2a2d34;
    border-radius: 8px;
    background: #1b1e24;
  }
  .account-current {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.6rem 0.75rem;
  }
  .account-meta {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1;
  }
  .account-kicker {
    color: #9aa0a6;
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }
  .account-name {
    color: #e8eaed;
    font-size: 0.9rem;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .switch-toggle {
    flex-shrink: 0;
    background: transparent;
    border: 1px solid #2a2d34;
    color: #c8ccd0;
    border-radius: 6px;
    padding: 0.3rem 0.6rem;
    font-size: 0.8rem;
    font-weight: 600;
    cursor: pointer;
  }
  .switch-toggle:hover {
    background: #22262d;
    color: #e8eaed;
  }
  .account-list {
    list-style: none;
    margin: 0;
    padding: 0.25rem;
    border-top: 1px solid #2a2d34;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }
  .account-list form {
    margin: 0;
  }
  .account-option {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.45rem 0.5rem;
    background: transparent;
    border: 0;
    border-radius: 6px;
    color: #e8eaed;
    cursor: pointer;
    text-align: left;
  }
  .account-option:hover {
    background: #22262d;
  }
  .avatar {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 34px;
    height: 34px;
    border-radius: 50%;
    background: #2a2d34;
    color: #e8eaed;
    font-size: 0.95rem;
    font-weight: 700;
    overflow: hidden;
  }
  .avatar.sm {
    width: 28px;
    height: 28px;
    font-size: 0.8rem;
  }
  .avatar img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .divider {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin: 1.25rem 0 0.75rem;
    color: #9aa0a6;
    font-size: 0.8rem;
    font-weight: 600;
    white-space: nowrap;
  }
  .divider::before,
  .divider::after {
    content: '';
    flex: 1;
    height: 1px;
    background: #2a2d34;
  }
  .scopes {
    list-style: none;
    margin: 0 0 1rem;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
  }
  .scopes li {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.9rem;
  }
  .remember {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0.25rem 0 1rem;
    font-size: 0.85rem;
    color: #c8ccd0;
    cursor: pointer;
  }
  .actions {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
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
  .btn.primary:hover {
    background: color-mix(in srgb, #4285f4, white 8%);
  }
  .deny-form {
    margin: 0.6rem 0 0;
  }
  .btn.ghost {
    background: transparent;
    color: #9aa0a6;
    border: 1px solid #2a2d34;
  }
  .btn.ghost:hover {
    background: #1b1e24;
    color: #e8eaed;
  }
  .invalid {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 0.5rem;
  }
  .invalid p {
    margin: 0;
    color: #9aa0a6;
    font-size: 0.9rem;
  }
</style>
