<script lang="ts">
  import { enhance } from '$app/forms';
  import { SYNC_PARAM } from '@civitai/auth/client';
  import { buildWordmarkSvg, buildBadgeSvg, getHoliday } from '@civitai/brand';
  import {
    IconBrandDiscord,
    IconBrandGithub,
    IconBrandGoogle,
    IconBrandReddit,
    IconMail,
  } from '@tabler/icons-svelte';
  import type { PageData, ActionData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  // Tracks the in-flight magic-link request so the button can show a pending state.
  let submitting = $state(false);

  // Framework-agnostic brand marks from @civitai/brand — no React, just SVG strings.
  const holiday = getHoliday();
  const badgeSvg = buildBadgeSvg({ holiday });
  const wordmarkSvg = buildWordmarkSvg({ base: '#e8eaed' });

  // Per-provider icon + brand class — mirrors the main app's socialItems / Social.module.css.
  const providerMeta: Record<string, { Icon: typeof IconMail; cls: string }> = {
    discord: { Icon: IconBrandDiscord, cls: 'discord' },
    github: { Icon: IconBrandGithub, cls: 'github' },
    google: { Icon: IconBrandGoogle, cls: 'google' },
    reddit: { Icon: IconBrandReddit, cls: 'reddit' },
  };

  const href = (providerId: string) => {
    const params = new URLSearchParams({ returnUrl: data.returnUrl });
    if (data.sync) params.set(SYNC_PARAM, data.sync);
    if (data.prompt) params.set('prompt', data.prompt);
    return `/login/${providerId}?${params.toString()}`;
  };

  // Cloudflare Turnstile auto-renders any `.cf-turnstile` element once its script loads and injects
  // a hidden `cf-turnstile-response` input into the form. We reset it after each submit so a fresh
  // (single-use) token is available for the next attempt.
  const resetTurnstile = () => {
    (globalThis as unknown as { turnstile?: { reset: () => void } }).turnstile?.reset();
  };
</script>

<svelte:head>
  {#if data.turnstileSiteKey}
    <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
  {/if}
</svelte:head>

<main>
  <div class="card">
    <div class="brand">
      <span class="badge">{@html badgeSvg}</span>
      <span class="wordmark">{@html wordmarkSvg}</span>
    </div>
    <h1>Sign Up or Log In</h1>

    {#if data.error}
      <p class="error">Login error: {data.error}</p>
    {/if}

    {#if data.user && !data.addAccount}
      <div class="signed-in-card">
        <p>Signed in as <strong>{data.user.username ?? data.user.id}</strong>.</p>
        <form method="POST" action="/logout" class="logout-form">
          <button type="submit" class="social email">Log out</button>
        </form>
      </div>
    {:else}
      {#if data.user && data.addAccount}
        <p class="add-account-note">
          Signed in as <strong>{data.user.username ?? data.user.id}</strong>. Log in below to add another
          account.
        </p>
      {/if}

      {#if data.providers.length === 0 && !data.emailEnabled}
        <p class="empty">No login methods are configured. Set provider CLIENT_ID/SECRET or EMAIL_* env vars.</p>
      {/if}

      {#if data.providers.length > 0}
        <div class="socials">
          {#each data.providers as provider (provider.id)}
            {@const meta = providerMeta[provider.id]}
            <a class="social {meta?.cls ?? ''}" href={href(provider.id)}>
              {#if meta}{@const Icon = meta.Icon}<Icon size={20} stroke={2} />{/if}
              <span>{provider.name}</span>
            </a>
          {/each}
        </div>
      {/if}

      {#if data.emailEnabled}
        {#if data.providers.length > 0}
          <div class="divider"><span>Or continue with Email</span></div>
        {/if}

        {#if form?.sent}
          <div class="sent">
            <IconMail size={18} />
            <div>
              <strong>Check your email</strong>
              <span>for a special login link.</span>
            </div>
          </div>
        {:else}
          <form
            method="POST"
            action="?/email"
            class="email-form"
            use:enhance={() => {
              submitting = true;
              // Let SvelteKit apply the action result (updates `form`), then clear pending and reset
              // the captcha so a fresh single-use token is ready for the next attempt.
              return async ({ update }) => {
                await update();
                submitting = false;
                resetTurnstile();
              };
            }}
          >
            <input
              type="email"
              name="email"
              placeholder="Enter your email"
              required
              disabled={submitting}
              value={form?.email ?? ''}
            />
            <input type="hidden" name="returnUrl" value={data.returnUrl} />
            {#if data.sync}<input type="hidden" name={SYNC_PARAM} value={data.sync} />{/if}
            {#if data.turnstileSiteKey}
              <div class="cf-turnstile" data-sitekey={data.turnstileSiteKey} data-theme="dark"></div>
            {/if}
            <button type="submit" class="social email" disabled={submitting}>
              <IconMail size={20} stroke={2} />
              <span>{submitting ? 'Sending…' : 'Email me a login link'}</span>
            </button>
            {#if form?.invalid}<p class="error">Enter a valid email address.</p>{/if}
            {#if form?.rateLimited}
              <p class="error">Too many attempts. Please wait a few minutes and try again.</p>
            {/if}
            {#if form?.captcha}<p class="error">Captcha verification failed. Please try again.</p>{/if}
            {#if form?.blockedDomain}
              <p class="error">That email domain isn't allowed. Try a different address.</p>
            {/if}
            {#if form?.plusBlocked}
              <p class="error">Please use an email address without a "+" to sign up.</p>
            {/if}
            {#if form?.serverError}
              <p class="error">Something went wrong on our end. Please try again in a moment.</p>
            {/if}
          </form>
        {/if}
      {/if}
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
    max-width: 360px;
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
    margin-bottom: 1.5rem;
  }
  .badge {
    display: inline-flex;
    width: 34px;
  }
  .wordmark {
    display: inline-flex;
    width: 118px;
  }
  /* Injected SVG markup is not scoped by Svelte, so target it globally. */
  .badge :global(svg),
  .wordmark :global(svg) {
    display: block;
    width: 100%;
    height: auto;
  }
  h1 {
    font-size: 1.25rem;
    font-weight: 700;
    margin: 0 0 1.25rem;
    text-align: center;
  }

  /* Buttons — mirror the main app's social buttons (Social.module.css). */
  .socials {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    width: 100%;
  }
  .social {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.6rem;
    width: 100%;
    padding: 0.65rem 1rem;
    border: 0;
    border-radius: 8px;
    color: #fff;
    text-decoration: none;
    font-weight: 600;
    font-size: 0.95rem;
    line-height: 1.2;
    cursor: pointer;
  }
  .social.discord {
    background: #5865f2;
  }
  .social.discord:hover {
    background: color-mix(in srgb, #5865f2, white 5%);
  }
  .social.google {
    background: #4285f4;
  }
  .social.google:hover {
    background: color-mix(in srgb, #4285f4, white 5%);
  }
  .social.reddit {
    background: #ff5700;
  }
  .social.reddit:hover {
    background: color-mix(in srgb, #ff5700, white 10%);
  }
  .social.github {
    background: #25262b;
  }
  .social.github:hover {
    background: color-mix(in srgb, #25262b, white 5%);
  }
  .social.email {
    background: #666;
  }
  .social.email:hover {
    background: color-mix(in srgb, #666, white 10%);
  }
  .social:disabled {
    opacity: 0.6;
    cursor: default;
  }

  .divider {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin: 1.25rem 0;
    color: #9aa0a6;
    font-size: 0.85rem;
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

  .email-form {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  .email-form input[type='email'] {
    padding: 0.7rem 0.9rem;
    border-radius: 8px;
    border: 1px solid #2a2d34;
    background: #0f1115;
    color: #e8eaed;
    font-size: 0.95rem;
  }
  .email-form input[type='email']::placeholder {
    color: #6b7178;
  }
  .email-form input[type='email']:focus {
    outline: none;
    border-color: #4285f4;
  }

  .sent {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.85rem 1rem;
    border-radius: 8px;
    background: #1d2530;
    color: #e8eaed;
  }
  .sent div {
    display: flex;
    flex-direction: column;
    line-height: 1.3;
  }
  .sent span {
    color: #9aa0a6;
    font-size: 0.85rem;
  }

  .empty,
  .signed-in {
    font-size: 0.9rem;
    color: #9aa0a6;
  }
  .signed-in-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
  }
  .signed-in-card p {
    margin: 0;
    font-size: 0.95rem;
    color: #c8ccd0;
    text-align: center;
  }
  .add-account-note {
    margin: 0 0 1rem;
    font-size: 0.9rem;
    color: #9aa0a6;
    text-align: center;
  }
  .signed-in-card .social {
    width: 100%;
  }
  .logout-form {
    width: 100%;
    margin: 0;
  }
  .error {
    font-size: 0.9rem;
    color: #f59f00;
    background: rgba(245, 159, 0, 0.1);
    padding: 0.5rem 0.75rem;
    border-radius: 6px;
    margin: 0 0 0.75rem;
  }
</style>
