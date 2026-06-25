<script lang="ts">
  import { buildWordmarkSvg, buildBadgeSvg, getHoliday } from '@civitai/brand';
  import { IconCheck, IconShieldCheck, IconX } from '@tabler/icons-svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const holiday = getHoliday();
  const badgeSvg = buildBadgeSvg({ holiday });
  const wordmarkSvg = buildWordmarkSvg({ base: '#e8eaed' });
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
