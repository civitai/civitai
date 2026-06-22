<script lang="ts">
  import { buildWordmarkSvg, buildBadgeSvg, getHoliday } from '@civitai/brand';
  import { IconCheck, IconShieldCheck, IconDeviceDesktop } from '@tabler/icons-svelte';
  import type { PageData, ActionData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

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

    {#if form?.step === 'done'}
      <div class="centered">
        <IconCheck size={40} color="#37b24d" />
        <h1>Device connected</h1>
        <p>You can return to your device — it's now authorized. You may close this window.</p>
      </div>
    {:else if form?.step === 'review'}
      <h1>Authorize {form.client.name}</h1>
      {#if form.client.isVerified}
        <p class="verified"><IconShieldCheck size={14} /> Verified by Civitai</p>
      {/if}
      {#if form.client.description}
        <p class="desc">{form.client.description}</p>
      {/if}

      <div class="divider"><span>This device will be able to</span></div>
      <ul class="scopes">
        {#each form.scopes as label (label)}
          <li><IconCheck size={16} color="#37b24d" /><span>{label}</span></li>
        {/each}
      </ul>

      <form method="POST" action="?/approve" class="stack">
        <input type="hidden" name="user_code" value={form.userCode} />
        <button type="submit" class="btn primary">Approve</button>
      </form>
    {:else}
      <div class="centered">
        <IconDeviceDesktop size={36} color="#9aa0a6" />
        <h1>Connect a device</h1>
        <p>Enter the code displayed on your device to continue.</p>
      </div>

      <form method="POST" action="?/lookup" class="stack">
        <input
          type="text"
          name="user_code"
          placeholder="XXXX-XXXX"
          autocomplete="one-time-code"
          autocapitalize="characters"
          spellcheck="false"
          value={form?.userCode ?? data.prefillCode}
          required
        />
        {#if form?.error}<p class="error">{form.error}</p>{/if}
        <button type="submit" class="btn primary">Continue</button>
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
  .centered {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 0.4rem;
    margin-bottom: 1rem;
  }
  .centered p {
    margin: 0;
    color: #9aa0a6;
    font-size: 0.9rem;
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
  .stack {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  .stack input[type='text'] {
    padding: 0.7rem 0.9rem;
    border-radius: 8px;
    border: 1px solid #2a2d34;
    background: #0f1115;
    color: #e8eaed;
    font-size: 1.1rem;
    letter-spacing: 0.15em;
    text-align: center;
    text-transform: uppercase;
  }
  .stack input[type='text']:focus {
    outline: none;
    border-color: #4285f4;
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
  .error {
    font-size: 0.9rem;
    color: #f59f00;
    background: rgba(245, 159, 0, 0.1);
    padding: 0.5rem 0.75rem;
    border-radius: 6px;
    margin: 0;
  }
</style>
