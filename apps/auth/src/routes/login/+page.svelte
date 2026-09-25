<script lang="ts">
  import { onMount } from 'svelte';
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
  import {
    decideAfterGrace,
    probeTurnstile,
    TURNSTILE_TOKEN_DEADLINE_MS,
  } from './turnstile-availability';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  // Tracks the in-flight magic-link request so the button can show a pending state.
  let submitting = $state(false);

  // The typed email is OWNED by local state (bind:value), NOT a one-way value={form?.email ?? ''}.
  // OBSERVED (reproduced live on auth.civitai.com): when the captcha gate flips `captchaPending`
  // mid-typing — "Verifying…" → "Email me a login link" once the invisible widget resolves a token
  // ~1s after load — the one-way-bound input got cleared to empty, wiping what the user typed.
  // (`form` is undefined pre-submit so the bound expression is a constant ''; the exact re-render
  // trigger isn't pinned down, but the wipe is real.) bind:value makes the input own its value so no
  // re-render can reset it; it also preserves the input across a failed submit. Seeded from
  // form?.email so a no-JS POST round-trip (server echoes the email back) still repopulates it.
  let email = $state(form?.email ?? '');

  // Turnstile's primary path is the INVISIBLE widget (CF widget-mode = Invisible) — it runs in the background and
  // auto-issues a token via its success callback (no interactive challenge). We track that token so
  // the submit button can wait for it, avoiding the race where a fast user POSTs an empty
  // `cf-turnstile-response` and the server fail-closes. `captchaUnavailable` is the safety valve:
  // if the widget errors or never loads (CF unreachable, hostname not allow-listed, script blocked),
  // we STOP gating and let the server-side check be the sole gate — a user must never be trapped
  // behind a permanently-disabled button.
  let captchaToken = $state('');
  let captchaUnavailable = $state(false);
  // Whether a widget can appear AT ALL — the two sitekeys are independent config, so neither alone
  // answers it. 🔴 LOAD-BEARING IN captchaPending BELOW: without it, a deployment that enforces with no
  // sitekey tells every visitor an extension or a VPN is blocking a check it never offered. The term
  // is pinned by 'never disables the submit button on the blocked path', which holds captchaPending as
  // a whole string; the harm it prevents is described by 'never concludes the check is blocked where
  // no check was ever offered'.
  const captchaConfigured = $derived(!!data.turnstileSiteKey || !!data.turnstileManagedSiteKey);
  // 🔴 THIS is the expression a broken widget must never reach: no term may be added here that is true
  // because captcha failed (captchaBlocked above all). The soft-release is what keeps a user from
  // being trapped behind a permanently disabled button, and the server stays the sole gate. Both
  // config terms pass that test — they read only `data`, so neither can become true because the check
  // FAILED, and each can only RELEASE the button.
  const captchaPending = $derived(
    data.turnstileEnforced && captchaConfigured && !captchaToken && !captchaUnavailable
  );
  // A token in hand contradicts "blocked" whatever the flag still says. `turnstileEnforced` is
  // DEFENCE IN DEPTH and redundant today, because nothing can set the verdict on an unenforced page.
  // If a writer of `captchaUnavailable = true` ever appears outside triggerFallback's reach, this term
  // is what keeps the blocked copy off that page.
  const captchaBlocked = $derived(data.turnstileEnforced && captchaUnavailable && !captchaToken);
  // The OTHER way email login cannot complete: enforcement on with no widget to produce a token, so
  // every submit is refused. Separate from captchaBlocked because it is provable from `data` and is
  // not about the reader — it must never reach the note above.
  const captchaMisconfigured = $derived(data.turnstileEnforced && !captchaConfigured);
  // Named for the RULE: pressing the button again cannot change the outcome, so the generic "please
  // try again" is suppressed and the button says so. Must NOT grow to cover rate-limited or
  // blocked-domain — those are messages the user can act on.
  const retryCannotHelp = $derived(captchaBlocked || captchaMisconfigured);

  // INTERACTIVE FALLBACK: when the invisible widget can't issue a token, render the MANAGED (visible,
  // interactive) widget instead of un-gating a doomed tokenless submit. `captchaToken` stays the single gate —
  // set by whichever widget solves — so `captchaPending` and the submit button are unchanged; `captchaUnavailable`
  // now flips only when we truly give up (no managed key configured, or the managed widget ALSO failed to load).
  // The managed token rides its own hidden field so it never collides with the invisible auto-injected input.
  type TurnstileApi = {
    // Cloudflare answers a non-string when the widget cannot be created at all.
    render: (el: HTMLElement, opts: Record<string, unknown>) => string | null | undefined;
    reset: (id?: string) => void;
  };
  const turnstileApi = (): TurnstileApi | undefined =>
    (globalThis as unknown as { turnstile?: TurnstileApi }).turnstile;

  let managedToken = $state('');
  let captchaMode = $state('invisible');
  // Why there's no token, tagged on a tokenless submit so the server can split no_token into recoverable
  // (widget-error / timeout → invisible declined) vs unrecoverable (fallback-error → Turnstile fully blocked).
  let captchaFailReason = $state('');
  let fallbackActive = $state(false);
  let managedEl = $state<HTMLDivElement>();
  let managedWidgetId: string | undefined;
  // Reactive mirror of managedWidgetId, which is a plain `let` the template cannot react to.
  // INVARIANT, deliberately unguarded because nothing clears either one today: anything that clears
  // managedWidgetId to allow a fresh render must clear this too, or the prompt, the reserved box and
  // the button label go on claiming a widget that is gone.
  let managedWidgetShown = $state(false);
  // ONE name, because the prompt, the slot's reserved height and the button label all ask it, and the
  // first two are exact negations of each other — spelled separately they diverged once already.
  const solvePrompted = $derived(managedWidgetShown && captchaPending);
  // ORDER IS LOAD-BEARING and invisible at the call site: solvePrompted is a strict
  // SUBSET of captchaPending, so testing captchaPending first makes 'Verify to continue' unreachable
  // and puts "Verifying…" on the button beside a prompt telling the user to complete the check. And
  // the last branch reads retryCannotHelp, not one arm of it: in the blocked state the button would
  // otherwise offer to send a link directly under a note saying email login cannot complete, and the
  // rate limiter runs before the captcha check, so each press of it spends one of five attempts.
  const emailButtonLabel = $derived.by(() => {
    if (submitting) return 'Sending…';
    if (solvePrompted) return 'Verify to continue';
    if (captchaPending) return 'Verifying…';
    if (retryCannotHelp) return 'Email login unavailable';
    return 'Email me a login link';
  });
  // A COUNTER, not a flag. The grace effect below can only re-run when its dependency changes, and Svelte
  // short-circuits a write of an equal value — so a second failure setting a boolean `true` again would
  // not re-arm. A grace spent on a token that then got cleared (resetTurnstile runs after every submit)
  // would never be replaced, leaving the gate closed for the rest of the session with no verdict.
  let scriptWatch = $state(0);

  // The only writer of the verdict. Reaching it needs evidence about the USER'S environment: a Turnstile
  // error callback is that, a missing token or missing global at a deadline is not.
  const concludeUnavailable = () => {
    captchaUnavailable = true;
  };

  // THE COMMITMENT RULE, stated once: `fallbackActive` gates the managed effect below AND short-circuits
  // triggerFallback, while that effect's dependencies do not move on a later failure — so EVERY exit of
  // it that leaves the slot EMPTY must hand the commitment back here, or the page reaches a state
  // nothing can move. A RENDERED widget keeps it: that one recovers through its own error-callback, and
  // the unmount would not. Pinned by the ledger in login-captcha.test.ts.
  const releaseFallbackIfEmpty = () => {
    if (managedWidgetId === undefined) fallbackActive = false;
  };

  // Invisible widget failed to produce a token. Show the managed challenge if a managed key is configured;
  // otherwise keep the pre-existing soft-release (un-gate and let the server fail-closed decide).
  // ONLY WHILE SOMETHING IS WAITING ON A CAPTCHA — captchaPending, the same rule the submit button and
  // the fallback prompt read, not a third hand-spelled copy. Spelled out, it missed two cases, with
  // different harms: with enforcement OFF and a managed key present it renders a real Cloudflare
  // challenge the action then ignores; with NO widget configured there is nothing to render, and the
  // other arm reaches a verdict that blames the reader's browser for a check never offered.
  // `fallbackActive` stays separate — a latch, not a condition, and every empty-slot exit hands it back.
  function triggerFallback(reason: string) {
    if (fallbackActive || !captchaPending) return;
    captchaFailReason = reason;
    // The second arm is live: it runs whenever no managed sitekey is configured.
    if (data.turnstileManagedSiteKey) fallbackActive = true; // $effect renders it once the slot is in the DOM
    else scriptWatch += 1;
  }

  // No managed key: there is no second widget, so the script's presence decides nothing a token does not
  // already decide — and a script that arrived just before the deadline has not had time to solve.
  // COST of that second look, accepted: a genuinely blocked user stays behind a disabled "Verifying…"
  // button for TURNSTILE_TOKEN_DEADLINE_MS plus TURNSTILE_SCRIPT_GRACE_MS, not the deadline alone.
  $effect(() => {
    if (scriptWatch === 0) return;
    return decideAfterGrace({ tokenArrived: () => !!captchaToken, decide: concludeUnavailable });
  });

  // Render the managed widget once (after its slot mounts). Solving it sets the gate token + mode=managed.
  // This effect WRITES one of its own dependencies — probeTurnstile calls onScriptPresent synchronously,
  // so a render producing no widget reaches releaseFallbackIfEmpty inside this body. It terminates
  // because the write FALSIFIES the guard below, so the re-run returns having done nothing.
  $effect(() => {
    if (!fallbackActive || !managedEl || managedWidgetId !== undefined) return;
    return probeTurnstile({
      scriptPresent: () => !!turnstileApi(),
      tokenArrived: () => !!captchaToken,
      onScriptPresent: renderManagedWidget,
      // The grace ended with a token, so nothing was rendered and nothing needs to be — this exit
      // resolves to neither outcome, so the commitment it was taken under has to go back.
      onWithdrawn: releaseFallbackIfEmpty,
      onScriptAbsent: () => {
        // Script never ran, so the interactive fallback cannot reach this user either. Soft-release;
        // the server stays the sole gate. The slot is still empty, so the commitment goes back too:
        // a late token can clear this verdict, and the next failure must be able to probe again.
        captchaFailReason = 'fallback-error';
        concludeUnavailable();
        releaseFallbackIfEmpty();
      },
    });
  });

  function renderManagedWidget() {
    const ts = turnstileApi();
    // KNOWN OPEN: reached, this early return holds the commitment with an empty slot — the dead end
    // releaseFallbackIfEmpty closes everywhere else. Nothing reaches it today, and nothing pins why:
    // managedEl is a $state dependency of the effect above, probeTurnstile hands that effect the grace
    // teardown, and Svelte runs a teardown before a re-run, so an unmount cancels the second look.
    if (!ts || !managedEl || managedWidgetId !== undefined) return;
    let id: string | null | undefined;
    try {
      id = ts.render(managedEl, {
        sitekey: data.turnstileManagedSiteKey,
        action: 'login',
        'response-field': false, // token carried via state → hidden field, not an auto-injected input
        callback: (t: string) => {
          managedToken = t;
          captchaToken = t;
          captchaMode = 'managed';
          // Mirrors onAuthCaptcha: a solve FALSIFIES the unavailable verdict. Without this the flag
          // latches for the session after one transient widget error, and every later form result —
          // a typo'd email, a rejected token — renders the "your browser is blocking this" note
          // beside it, because resetTurnstile() clears captchaToken after every submit.
          captchaUnavailable = false;
        },
        'expired-callback': () => {
          managedToken = '';
          captchaToken = '';
        },
        'error-callback': () => {
          // The managed widget can't load either → the whole Turnstile challenge is blocked for this user.
          captchaFailReason = 'fallback-error';
          concludeUnavailable();
        },
      });
    } catch {
      id = undefined;
    }
    // Cloudflare fires no error-callback for a widget it never made (a managed sitekey not allow-listed
    // for this host), so a non-string id is the only signal that the fallback is not coming.
    if (typeof id !== 'string') {
      captchaFailReason = 'fallback-error';
      concludeUnavailable();
      releaseFallbackIfEmpty(); // nothing was created, so the slot is empty and the commitment goes back
      return;
    }
    managedWidgetId = id;
    managedWidgetShown = true;
  }

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
  // (single-use) token is available for the next attempt; clearing `captchaToken` re-gates the
  // button until the invisible widget produces the new token.
  const resetTurnstile = () => {
    captchaToken = '';
    managedToken = '';
    captchaMode = 'invisible';
    const ts = turnstileApi();
    ts?.reset(); // untargeted: Cloudflare picks the widget. Fresh background token on the usual page.
    if (managedWidgetId) ts?.reset(managedWidgetId); // managed widget (if shown) → fresh solve
  };

  // Wire Turnstile's data-* callbacks (it invokes the named functions on `window`). Set them up
  // client-side only; the invisible widget calls the success callback after its background check.
  onMount(() => {
    const w = window as unknown as Record<string, (token?: string) => void>;
    w.onAuthCaptcha = (token) => {
      captchaToken = token ?? '';
      captchaUnavailable = false;
      // An invisible token arrived (possibly LATE, after the fallback already showed) — submit via the invisible
      // path so we don't POST captchaMode=managed with an empty managed token and eat a wasted rejection.
      captchaMode = 'invisible';
    };
    w.onAuthCaptchaExpired = () => {
      // Token is single-use / TTL-bound; clear it. The invisible widget auto-renews.
      captchaToken = '';
    };
    w.onAuthCaptchaError = () => {
      // Invisible widget errored — offer the interactive fallback (or soft-release if no managed key).
      captchaToken = '';
      triggerFallback('widget-error');
    };
    // If no token has arrived in time, the invisible widget silently failed to auto-solve — offer the
    // fallback. Armed unconditionally: triggerFallback is the single choke point and it refuses unless
    // captchaPending, so where no widget was ever offered this fires and does nothing.
    const timeout = setTimeout(() => {
      if (!captchaToken) triggerFallback('timeout');
    }, TURNSTILE_TOKEN_DEADLINE_MS);
    return () => {
      clearTimeout(timeout);
      delete w.onAuthCaptcha;
      delete w.onAuthCaptchaExpired;
      delete w.onAuthCaptchaError;
    };
  });
</script>

<svelte:head>
  {#if captchaConfigured}
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

    {#if data.error === 'BlockedDomain'}
      <p class="error">That email domain isn't allowed. Try a different address.</p>
    {:else if data.error}
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
          <!-- The live region must pre-exist its content — a role="status" inserted together with its
               text is the no-announce shape, and this note appears with no user action behind it. It is
               a SIBLING of the form, never a child: as a flex child an always-mounted empty region
               spends the form's gap on every login page that never fills it, and the removals available
               from inside are hiding it (the no-announce shape again) or `display: contents`, whose
               effect on the accessibility tree is a browser fact nothing here can check. Out here an
               empty div is simply zero-height. Keep it unconditional relative to the form. -->
          <div class="live-region" role="status">
            {#if captchaBlocked}
              <p class="captcha-fallback-note">
                {#if form?.captcha}That didn't go through.{/if} Something is preventing the verification
                check from running in this browser — often a browser extension, privacy or VPN tool, or a
                network filter — so email login can't complete.
                {#if data.providers.length > 0}Sign in with one of the buttons above instead.{/if} To use
                email, turn off whatever is blocking the check and reload this page.
              </p>
            {:else if captchaMisconfigured}
              <!-- Same dead end, opposite cause, so deliberately NOT the note above: no action of the
                   reader's can clear this, so it names no cause and offers only what still works.
                   Unlike its sibling this derives from `data` alone, so it is present at first paint and
                   the live region announces nothing for it — it is read in document order. -->
              <p class="captcha-fallback-note">
                {#if form?.captcha}That didn't go through.{/if} Email login isn't available right now.
                {#if data.providers.length > 0}Sign in with one of the buttons above instead.{/if}
              </p>
            {/if}
          </div>
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
              bind:value={email}
            />
            <input type="hidden" name="returnUrl" value={data.returnUrl} />
            {#if data.sync}<input type="hidden" name={SYNC_PARAM} value={data.sync} />{/if}
            {#if data.turnstileSiteKey}
              <!-- Invisible widget: no data-size (invisibility comes from the sitekey's CF
                   widget-mode, not an attribute). Callbacks track the token for the submit gate. -->
              <div
                class="cf-turnstile"
                data-sitekey={data.turnstileSiteKey}
                data-action="login"
                data-callback="onAuthCaptcha"
                data-expired-callback="onAuthCaptchaExpired"
                data-error-callback="onAuthCaptchaError"
                data-theme="dark"
              ></div>
            {/if}
            {#if fallbackActive}
              <!-- Interactive fallback: shown only after the invisible widget fails. The managed widget is
                   rendered imperatively into this slot (see the $effect) so it can carry data-action + callbacks. -->
              {#if solvePrompted}
                <!-- The slot mounts a grace period before the widget can render, and asking for a check
                     that is not there yet is an instruction with no target — so the prompt, the slot's
                     reserved height and the button label all read one derived. -->
                <p class="captcha-fallback-note">
                  Couldn't verify you automatically. Complete this quick check to continue.
                </p>
              {/if}
              <!-- Only reserve height for a widget that exists. A widget that rendered and then errored
                   keeps Cloudflare's own error UI, which min-height cannot shrink. -->
              <div
                class="managed-slot"
                class:collapsed={!solvePrompted}
                bind:this={managedEl}
              ></div>
            {/if}
            <!-- Token carriers: the invisible widget auto-injects `cf-turnstile-response`; the managed fallback
                 rides `managed-turnstile-response` + `captchaMode`. `captchaFailReason` tags a tokenless submit. -->
            <input type="hidden" name="captchaMode" value={captchaMode} />
            <input type="hidden" name="managed-turnstile-response" value={managedToken} />
            <input type="hidden" name="captchaFailReason" value={captchaFailReason} />
            <button type="submit" class="social email" disabled={submitting || captchaPending}>
              <IconMail size={20} stroke={2} />
              <span>{emailButtonLabel}</span>
            </button>
            {#if form?.invalid}<p class="error">Enter a valid email address.</p>{/if}
            {#if form?.rateLimited}
              <p class="error">Too many attempts. Please wait a few minutes and try again.</p>
            {/if}
            <!-- "try again" only where a retry can work — a rejected (expired/reused) token, not a
                 check that cannot run. Dropping the second term re-invites a doomed retry. -->
            {#if form?.captcha && !retryCannotHelp}
              <p class="error">Captcha verification failed. Please try again.</p>
            {/if}
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
  .captcha-fallback-note {
    font-size: 0.82rem;
    color: #f59f00;
    background: rgba(245, 159, 0, 0.1);
    padding: 0.5rem 0.7rem;
    border-radius: 6px;
    margin: 0;
    line-height: 1.4;
  }
  /* Deliberately NO `.live-region` rule — see the region's own comment in the markup for why it sits
     outside .email-form and why `display: contents` is refused. Only its content is spaced. */
  .live-region > .captcha-fallback-note {
    margin-bottom: 0.6rem;
  }
  /* Reserve the managed widget's footprint so the card doesn't jump when it renders. */
  .managed-slot {
    min-height: 65px;
  }
  .managed-slot.collapsed {
    min-height: 0;
  }
</style>
