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
const pageSource = readFileSync(fileURLToPath(new URL('../+page.svelte', import.meta.url)), 'utf8');

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

// The artifact under test here is PROSE, so the copy is pinned as a whole normalised string rather than by
// keyword — a reword can keep any keyword you grep for while dropping the cause or the way out.
const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();
// Structural guards read THIS, not pageSource. A comment can spell any token a guard looks for, and the
// comments most likely to be rewritten are the ones warning against the very edit being guarded.
const markup = pageSource
  .replace(/<!--[\s\S]*?-->/g, '')
  .split('\n')
  .filter((line) => !line.trim().startsWith('//'))
  .join('\n');
const blockedNote = normalize(
  pageSource.match(
    /\{#if captchaBlocked\}[\s\S]*?<p class="captcha-fallback-note"[^>]*>([\s\S]*?)<\/p>/
  )?.[1] ?? ''
);

describe('login copy when the verification check cannot run', () => {
  it('derives the blocked state from ENFORCEMENT, an unavailable widget, and no token', () => {
    // All three terms are load-bearing, and each has its own way of producing a false note:
    //  - the 8s timeout sets captchaUnavailable even with captcha switched off entirely, and a bare
    //    sitekey test is wrong on both edges (a sitekey can exist where the action does not enforce);
    //  - captchaUnavailable is never cleared on the managed path, so without !captchaToken a fallback
    //    widget that errors and then solves keeps claiming login is blocked while a submit would pass.
    const decl = normalize(
      pageSource.match(/const captchaBlocked = \$derived\([\s\S]*?\);/)?.[0] ?? ''
    );
    expect(decl).toBe(
      'const captchaBlocked = $derived(data.turnstileEnforced && captchaUnavailable && !captchaToken);'
    );
  });

  it('names the cause as LIKELY (not certain), gives both ways out, and never says "try again"', () => {
    // Hedged deliberately: captchaUnavailable cannot separate a blocked browser from our own sitekey
    // misconfiguration, and asserting the former turns a config outage into user self-blame.
    expect(blockedNote, 'captchaBlocked note not found').not.toBe('');
    expect(blockedNote).toBe(
      "{#if form?.captcha}That didn't go through.{/if} Something is preventing the verification " +
        'check from running in this browser — often a browser extension, privacy or VPN tool, or a ' +
        "network filter — so email login can't complete. " +
        '{#if data.providers.length > 0}Sign in with one of the buttons above instead.{/if} To use ' +
        'email, turn off whatever is blocking the check and reload this page.'
    );
    // The leading `{#if form?.captcha}` prefix pinned above is the ONLY acknowledgement a refused
    // submit gets on this path: the generic message is suppressed and nothing else here reads `form`,
    // so without it the DOM after a refused click is identical to the DOM before it.
    expect(blockedNote.toLowerCase()).not.toContain('try again');
  });

  // SCOPE for the two tests below: a source-text suite can show the region is not inside a Svelte block
  // opened within the form, and that nothing in this file hides it. It CANNOT see an ancestor ELEMENT
  // wrapped around it, so that hole stays open by construction rather than by oversight.
  it('keeps the live region out of the block that conditions its content', () => {
    // A role="status" created together with its text does not announce, and the note appears with no
    // user action behind it. THREE claims, each with its own way of going green while broken:
    //  - the note must be INSIDE the region (ordering alone survives moving the note below it),
    //  - the region must open NO block before the note (containment alone survives a nested
    //    `{#if captchaBlocked}{#if form}`, which is the wasted-submit regression by another spelling),
    //  - the region must be UNCONDITIONAL (containment alone survives wrapping the whole region in
    //    {#if fallbackActive} — the very fold the markup comment forbids — which hides the note
    //    entirely in the no-managed-key config, where fallbackActive is never set).
    // Every anchor is read from the comment-stripped copy: a comment can spell any token a guard looks
    // for, the comment forbidding the fold included, and that comment is what an edit folding it rewrites.
    const openTag = /<div\b[^>]*role="status"[^>]*>/;
    expect(markup, 'no role="status" wrapper found').toMatch(openTag);

    const region = markup.match(new RegExp(openTag.source + '([\\s\\S]*?)<\\/div>'))?.[1] ?? '';
    expect(region, 'live region is present but empty').toContain('{#if captchaBlocked}');
    // The note sits at depth 1 inside the region: exactly ONE block opened before it and none closed.
    // A prefix match is not enough — `{#if captchaBlocked}{#if form}` still starts with the right
    // literal while putting the note behind a second condition, which is the wasted-submit regression.
    const noteStart = region.indexOf('<p');
    expect(noteStart, 'no note element inside the live region').toBeGreaterThan(-1);
    const beforeNote = region.slice(0, noteStart);
    expect((beforeNote.match(/\{#/g) ?? []).length, 'extra block opened before the note').toBe(1);
    expect((beforeNote.match(/\{\//g) ?? []).length).toBe(0);

    // Unconditional == every block opened since the form tag is also closed before the region.
    // The anchor is a regex, not indexOf: an ordinary second class would otherwise red this with a
    // bare "expected 3 to be 4" for no defect. Block counting runs over the unquoted text: stripping
    // quoted spans pairs the apostrophe in "Couldn't" with the next quote and swallows a {/if}, and
    // the prose that would justify stripping lives in comments, which are already gone.
    const formStart = markup.search(/class="[^"]*\bemail-form\b/);
    const regionStart = markup.search(openTag);
    // Without these the slice can silently go empty (anchor lost → -1, or region moved above the
    // form → start > end), and `0 === 0` would pass with the region wrapped in a condition.
    expect(formStart, 'email-form anchor not found').toBeGreaterThan(-1);
    expect(regionStart).toBeGreaterThan(formStart);
    const between = markup.slice(formStart, regionStart);
    expect((between.match(/\{#/g) ?? []).length).toBe((between.match(/\{\//g) ?? []).length);
  });

  it('never hides the live region while it is empty', () => {
    // A region that is display:none until it fills is the same no-announce shape as one that is
    // absent, and the motive is real: the region is mounted for every visitor, so anything it costs
    // an empty page invites hiding it. `display: contents` is the escape that pays that cost without
    // leaving the accessibility tree. Pin the MECHANISM, not a selector spelling — `[role='status']:empty`,
    // `.live-region:empty` and `.email-form div:empty` are the same defect, and only the first names the role.
    const openTagText = markup.match(/<div\b[^>]*role="status"[^>]*>/)?.[0];
    expect(openTagText, 'no role="status" wrapper found').toBeDefined();
    // `display: contents` is a legitimate way to drop the gap, so only inline hiding is banned here.
    // `style:` is in the ban because it is the sibling directive of `class:` — already used on the
    // slot one element up — and an expression-valued `style:display={…}` hides the region while
    // spelling none of the words a literal-only ban looks for.
    expect(openTagText, 'the region tag can hide or mute itself').not.toMatch(
      /\bhidden\b|class:|aria-live=['"]off|style:(display|visibility)|style=["{][^>]*?(display|visibility)/
    );

    // indexOf('<style>') returns -1 the moment the tag gains an attribute, and slice(-1) then yields
    // the file's LAST CHARACTER — a guard that passes forever against a 1-char string, silently.
    const styleStart = pageSource.indexOf('<style');
    expect(styleStart, '<style> block not found').toBeGreaterThan(-1);
    const styles = pageSource.slice(styleStart);
    // The DECLARATION is the mechanism, not the selector: `:empty` hides nothing on its own, and
    // banning it reds a legitimate `:not(:empty) { margin… }`.
    // The rules searched are only those that can REACH this region. Banning the pair across the whole
    // stylesheet reds on an ordinary responsive edit — a `@media` rule hiding the divider — under a
    // name that blames the live region, and a gate that goes red for a non-defect is one people learn
    // to click through. The tag-level assertion above already covers the inline spelling.
    const hidingRules = [...styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(([, , body]) => /display:\s*none|visibility:\s*hidden/.test(body))
      .map(([, selector]) => selector.trim().replace(/\s+/g, ' '));
    const canReachLiveRegion = (selector: string) =>
      // The region's own class or role, or a bare element/universal selector that sweeps it in with
      // everything else — `.email-form div`, `.card *` and `[role='status']:empty` are one defect.
      /live-region|role=['"]?status/.test(selector) ||
      /(^|[\s,>+~])(\*|div)(?![\w-])/.test(selector);
    expect(
      hidingRules.filter(canReachLiveRegion),
      'a CSS rule that can match the live region hides it. While the region is empty that is the same ' +
        'no-announce shape as never rendering it. Narrow the selector so it cannot reach the region, ' +
        'or use a non-hiding property.'
    ).toEqual([]);
  });

  it('keeps the always-mounted live region out of the form layout', () => {
    // The region is mounted for every visitor, including the overwhelming majority who never see a
    // note, and as a flex child of .email-form an empty one still spends a 0.6rem gap — every login
    // page laid out around content that is not there. `display: contents` is the removal that keeps
    // the element in the accessibility tree; the alternatives are the hiding the test above bans.
    const openTagText = markup.match(/<div\b[^>]*role="status"[^>]*>/)?.[0] ?? '';
    const classes = (openTagText.match(/class="([^"]*)"/)?.[1] ?? '').split(/\s+/).filter(Boolean);
    expect(
      classes,
      'the live region carries no class, so no rule can take it out of the flex flow'
    ).not.toHaveLength(0);
    const styleStart = pageSource.indexOf('<style');
    expect(styleStart).toBeGreaterThan(-1);
    const styles = pageSource.slice(styleStart);
    const removedFromFlow = classes.some((cls) =>
      new RegExp(`\\.${cls}\\b[^{}]*\\{[^}]*display:\\s*contents`).test(styles)
    );
    expect(removedFromFlow, 'no `display: contents` rule reaches the live region').toBe(true);
  });

  it('clears the unavailable verdict when the managed widget finally solves', () => {
    // Without this the flag latches for the session, and because resetTurnstile() wipes captchaToken
    // after every submit, the !captchaToken term cannot mask it once any form result is on screen.
    // Pin the whole statement list, not the line: a line-anchored match is walkable by commenting the
    // statement out OR by re-indenting it under a guard (`if (!data.turnstileEnforced) { … }`), which
    // leaves the clear unreachable on exactly the deployments that enforce captcha.
    // The `\n      },` terminator is the callback's OWN closer — a nested `}` is indented deeper, so a
    // re-wrapped body is captured whole and shows up here as extra entries.
    // Anchored on ts.render(managedEl, …): without that, the statements can be left intact in an
    // options object that is never handed to Turnstile, so the widget renders with no callbacks at all.
    // Two separate failures, so a red says which: the call site is gone, or its body no longer parses
    // at the pinned indentation (a re-indent silently swallows the next callback's statements).
    const callSite = /ts\.render\(managedEl, \{[\s\S]*?callback: \(t: string\) => \{/;
    expect(markup, 'ts.render(managedEl, …) with a (t: string) success callback not found').toMatch(
      callSite
    );
    const body = markup.match(new RegExp(callSite.source + '([\\s\\S]*?)\\n      \\},'))?.[1];
    expect(
      body,
      'managed success callback body not closed at the expected indentation'
    ).toBeDefined();
    const statements = (body ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('//'));
    expect(statements).toEqual([
      'managedToken = t;',
      'captchaToken = t;',
      "captchaMode = 'managed';",
      'captchaUnavailable = false;',
    ]);
  });

  // SEAM between this component and turnstile-availability.ts. The probe's own behaviour — that it never
  // reports absence on a first look — is exercised in ../__tests__/turnstile-availability.test.ts; this
  // side pins that the component routes its absence-shaped evidence THROUGH it. Neither half can see the
  // defect alone: the probe passes with nothing calling it, and a source-text guard cannot run it.
  it('reaches the unavailable verdict only through the probe or a Turnstile error callback', () => {
    // The 8s deadline with no token, and an absent `turnstile` global, are the same evidence a SLOW
    // connection produces — the api.js tag is `async defer`. A site that concludes from either without
    // the probe's second look announces "email login can't complete" to a user whose login completes
    // seconds later, which is a statement the page has no grounds for.
    const setter = normalize(
      markup.match(/const concludeUnavailable = \(\) => \{[\s\S]*?\};/)?.[0] ?? ''
    );
    expect(setter, 'concludeUnavailable declaration not found').toBe(
      'const concludeUnavailable = () => { captchaUnavailable = true; };'
    );
    // One writer, so the verdict cannot be reached behind the ledger below.
    expect(markup.match(/captchaUnavailable = true/g) ?? []).toHaveLength(1);

    // Ledger of every line naming it. A new route to the verdict makes this list GROW and must restate
    // what evidence it has; deleting the probe from a route makes it SHRINK. A count alone sees neither.
    const sites = markup
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.includes('concludeUnavailable'));
    expect(sites).toEqual([
      'const concludeUnavailable = () => {',
      // triggerFallback with no managed key: no second widget to offer, so either answer ends here —
      // but only after the probe's grace, which is what lets a late token withdraw the question.
      'onScriptPresent: concludeUnavailable,',
      'onScriptAbsent: concludeUnavailable,',
      // The managed slot's probe: script present → render the fallback, absent → soft-release.
      'onScriptAbsent: concludeUnavailable,',
      // The managed widget's own error callback — Turnstile reporting its failure, so no grace needed.
      'concludeUnavailable();',
    ]);
  });

  it('surfaces the note proactively, not only after a wasted submit', () => {
    // Gating it on `form` would mean the user learns only after spending a rate-limit slot.
    const condition = pageSource.match(/\{#if captchaBlocked[^}]*\}/)?.[0] ?? '';
    expect(condition).toBe('{#if captchaBlocked}');
    // …and it sits inside the email form, above the submit button, so it is read before the click.
    // Anchor on the email submit's own markup: the logout form has a `<button type="submit">` too.
    // Regex, not indexOf: an ordinary second class on the form would otherwise red this for no defect.
    const formStart = markup.search(/class="[^"]*\bemail-form\b/);
    const noteStart = markup.indexOf('{#if captchaBlocked}');
    const submitStart = markup.indexOf('disabled={submitting || captchaPending}');
    expect(formStart).toBeGreaterThan(-1);
    expect(submitStart).toBeGreaterThan(-1);
    expect(noteStart).toBeGreaterThan(formStart);
    expect(noteStart).toBeLessThan(submitStart);
  });

  it('replaces the generic "try again" message on the blocked path, and keeps it otherwise', () => {
    // A rejected-but-working token (expired / reused) is genuinely retryable and must keep the generic copy.
    expect(pageSource).toMatch(/\{#if form\?\.captcha && !captchaBlocked\}/);
    expect(pageSource).toContain('Captcha verification failed. Please try again.');
  });

  it('drops the "complete this quick check" prompt once the check itself is blocked', () => {
    // The managed widget is what failed, so inviting the user to solve it is an unfollowable instruction.
    // Assert CONTAINMENT, not adjacency: `{#if !captchaBlocked}` followed by an unbounded match would
    // still pass with the prompt moved BELOW the closing {/if}, which is the regression being named.
    // `markup`, like the twin count below: reading the block from pageSource while counting from
    // markup let a comment inside the guard stand in for the prompt moved out of it.
    const guarded = markup.match(/\{#if !captchaBlocked\}([\s\S]*?)\{\/if\}/)?.[1] ?? '';
    expect(guarded, '{#if !captchaBlocked} block not found').not.toBe('');
    expect(guarded).toContain('Complete this quick check to continue.');
    // …and it must appear nowhere else, or the guarded copy has a twin that ignores the guard.
    // `markup`, not pageSource: a comment naming the copy it guards would otherwise red this.
    expect(markup.split('Complete this quick check to continue.')).toHaveLength(2);
  });

  // INVARIANT GUARD (green before this change too): the blocked path must never re-gate the button. The
  // soft-release is the whole reason a broken widget cannot trap a user, and the server stays the sole gate.
  it('never disables the submit button on the blocked path', () => {
    // The logout form also has a `<button type="submit">`, so anchor on the email submit's own class.
    const disabledExpr = pageSource.match(
      /<button type="submit" class="social email" disabled=\{([^}]*)\}/
    )?.[1];
    expect(disabledExpr).toBe('submitting || captchaPending');
    // Pinning the `disabled=` expression alone is not the guard the name claims: the realistic break is
    // folding captchaBlocked into captchaPending's own definition, which leaves `disabled=` untouched.
    const pending = normalize(
      pageSource.match(/const captchaPending = \$derived\([\s\S]*?\);/)?.[0] ?? ''
    );
    expect(pending).toBe(
      'const captchaPending = $derived(!!data.turnstileSiteKey && !captchaToken && !captchaUnavailable);'
    );
  });
});
