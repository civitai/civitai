import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Regression guard for the 2026-06-25 Turnstile fix. The hub login moved OFF the managed widget
// (interactive challenge, ~50% solve, broke email login) ONTO the invisible widget the main app
// uses (~99%). Two invariants must hold in the login markup, or the fix silently regresses:
//   1. The widget does NOT carry data-size="invisible" — invisibility is a property of the
//      sitekey's Cloudflare widget-mode, not a div attribute (the original fix attempt set an
//      invalid data-size and was a no-op). A stray data-size would mean someone reverted to the
//      attribute-hack mental model.
//   2. The widget wires the success/expired/error callbacks AND the submit button is gated on the
//      captcha token (captchaPending). Without the gate, a fast user POSTs an empty token and the
//      server fail-closes — the race the fix is meant to prevent.
// The app has no Svelte component DOM harness (vitest env = node), so we assert the source markup
// directly. The security-critical fail-closed behavior is covered in ../../lib/server/auth/__tests__/
// captcha.test.ts; this only locks the client wiring.
const pageSource = readFileSync(
  fileURLToPath(new URL('../+page.svelte', import.meta.url)),
  'utf8'
);

// Isolate the `.cf-turnstile` element (anchor on the real attribute, not the comment token).
const widget = pageSource.match(/class="cf-turnstile"[\s\S]*?><\/div>/)?.[0] ?? '';

describe('login Turnstile widget (invisible mode + token-gated submit)', () => {
  it('renders a .cf-turnstile widget bound to the SSR sitekey', () => {
    expect(widget, 'cf-turnstile widget element not found').not.toBe('');
    expect(widget).toMatch(/data-sitekey=\{data\.turnstileSiteKey\}/);
  });

  it('does NOT set data-size="invisible" (invisibility comes from the CF widget-mode, not an attr)', () => {
    expect(widget).not.toMatch(/data-size/);
  });

  it('wires the success/expired/error callbacks so the token can be tracked', () => {
    expect(widget).toMatch(/data-callback="onAuthCaptcha"/);
    expect(widget).toMatch(/data-expired-callback="onAuthCaptchaExpired"/);
    expect(widget).toMatch(/data-error-callback="onAuthCaptchaError"/);
  });

  it('gates the email submit button on the captcha token (prevents empty-token race)', () => {
    expect(pageSource).toMatch(/disabled=\{submitting \|\| captchaPending\}/);
  });

  it('has a safety valve so a broken/blocked widget cannot hard-block login', () => {
    // captchaPending must clear when the widget is known-unavailable, falling back to server enforcement.
    expect(pageSource).toMatch(/captchaUnavailable/);
    expect(pageSource).toMatch(/!captchaToken && !captchaUnavailable/);
  });

  it('binds the email input to local state (not a one-way form value the captcha re-render wipes)', () => {
    // The captchaPending flip re-renders the form; a one-way `value={form?.email ?? ''}` (='' pre-submit)
    // would re-assert empty and clear what the user typed. The input must use bind:value to own its value.
    const input = pageSource.match(/<input\b[\s\S]*?name="email"[\s\S]*?\/>/)?.[0] ?? '';
    expect(input, 'email input not found').not.toBe('');
    expect(input).toMatch(/bind:value=\{email\}/);
    expect(input).not.toMatch(/value=\{form\?\.email/);
  });
});

describe('login interactive fallback wiring', () => {
  it('renders the managed fallback slot only after the invisible widget fails', () => {
    expect(pageSource).toMatch(/\{#if fallbackActive\}/);
    expect(pageSource).toMatch(/class="managed-slot"[\s\S]*?bind:this=\{managedEl\}/);
  });

  it('carries the managed token + mode + fail reason as hidden fields', () => {
    expect(pageSource).toMatch(/name="captchaMode"/);
    expect(pageSource).toMatch(/name="managed-turnstile-response"/);
    expect(pageSource).toMatch(/name="captchaFailReason"/);
  });

  it('keeps the invisible submit gate unchanged (fallback rides captchaToken, not a new disabled term)', () => {
    // The whole design hinges on captchaToken staying the single gate; the button expr must not gain a term.
    expect(pageSource).toMatch(/disabled=\{submitting \|\| captchaPending\}/);
  });
});
