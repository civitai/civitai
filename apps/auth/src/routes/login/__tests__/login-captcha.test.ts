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

// Shared anchors. An anchor that stops matching yields -1 and a SILENTLY EMPTY slice rather than a red,
// so each must exist in exactly one place: a duplicated anchor is one more chance to tighten one copy
// and leave the others pointing at nothing.
const LIVE_REGION_TAG = /<div\b[^>]*role="status"[^>]*>/;
// Regex, not indexOf: an ordinary second class on the form would otherwise red every guard using it.
const EMAIL_FORM_ANCHOR = /class="[^"]*\bemail-form\b/;
const liveRegionTagText = markup.match(LIVE_REGION_TAG)?.[0] ?? '';
const liveRegionClasses = (liveRegionTagText.match(/class="([^"]*)"/)?.[1] ?? '')
  .split(/\s+/)
  .filter(Boolean);
// The note element itself, not only its wrapper. Hiding `.captcha-fallback-note` empties the region
// just as completely as hiding the region, and it is the more natural thing for a responsive edit to
// reach for — it is the element with the padding and the background.
const blockedNoteClasses = (
  markup.match(new RegExp(LIVE_REGION_TAG.source + '[\\s\\S]*?<p class="([^"]*)"'))?.[1] ?? ''
)
  .split(/\s+/)
  .filter(Boolean);
const announcementClasses = [...liveRegionClasses, ...blockedNoteClasses];
const styleStart = pageSource.indexOf('<style');
// indexOf returns -1 the moment the tag gains an attribute, and slice(-1) then yields the file's LAST
// CHARACTER — a guard that passes forever against a 1-char string.
const styles = styleStart > -1 ? pageSource.slice(styleStart) : '';

// Every line naming `identifier`, paired with the top-level scope it sits in. Scope resolution includes
// the matched line, so a declaration is its own scope.
const ledger = (identifier: string) => {
  const scopeOf = (end: number) => {
    const opener = [
      ...markup.slice(0, end).matchAll(/^ {2}(?:function (\w+)\(|const (\w+) =|(\$effect)\()/gm),
    ].pop();
    return opener ? opener[1] ?? opener[2] ?? opener[3] : '(module)';
  };
  return [...markup.matchAll(new RegExp(`^.*${identifier}.*$`, 'gm'))].map((m) => [
    scopeOf((m.index ?? 0) + m[0].length),
    m[0].trim(),
  ]);
};

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
    expect(markup, 'no role="status" wrapper found').toMatch(LIVE_REGION_TAG);

    const region =
      markup.match(new RegExp(LIVE_REGION_TAG.source + '([\\s\\S]*?)<\\/div>'))?.[1] ?? '';
    expect(region, 'live region is present but empty').toContain('{#if captchaBlocked}');
    // The note sits at depth 1 inside the region: exactly ONE block opened before it and none closed.
    // A prefix match is not enough — `{#if captchaBlocked}{#if form}` still starts with the right
    // literal while putting the note behind a second condition, which is the wasted-submit regression.
    const noteStart = region.indexOf('<p');
    expect(noteStart, 'no note element inside the live region').toBeGreaterThan(-1);
    const beforeNote = region.slice(0, noteStart);
    expect((beforeNote.match(/\{#/g) ?? []).length, 'extra block opened before the note').toBe(1);
    expect((beforeNote.match(/\{\//g) ?? []).length).toBe(0);

    // Unconditional == every block opened since the form tag is also closed before the region. Block
    // counting runs over the unquoted text: stripping quoted spans pairs the apostrophe in "Couldn't"
    // with the next quote and swallows a {/if}, and the prose that would justify stripping lives in
    // comments, which are already gone.
    const formStart = markup.search(EMAIL_FORM_ANCHOR);
    const regionStart = markup.search(LIVE_REGION_TAG);
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
    // an empty page invites hiding it. Pin the MECHANISM, not a selector spelling — `[role='status']:empty`,
    // `.live-region:empty` and `.email-form div:empty` are the same defect, and only the first names the role.
    expect(liveRegionTagText, 'no role="status" wrapper found').not.toBe('');
    // `display: contents` is a legitimate way to drop the gap, so only inline hiding is banned here.
    // `style:` is in the ban because it is the sibling directive of `class:` — already used on the
    // slot one element up — and an expression-valued `style:display={…}` hides the region while
    // spelling none of the words a literal-only ban looks for.
    expect(liveRegionTagText, 'the region tag can hide or mute itself').not.toMatch(
      /\bhidden\b|class:|aria-live=['"]off|style:(display|visibility)|style=["{][^>]*?(display|visibility)/
    );
    expect(styles, '<style> block not found').not.toBe('');

    // The DECLARATION is the mechanism, not the selector: `:empty` hides nothing on its own, and
    // banning it reds a legitimate `:not(:empty) { margin… }`.
    // Only rules that can REACH this region are searched. Banning the pair across the whole stylesheet
    // reds on an ordinary responsive edit — a `@media` rule hiding the divider — under a name that
    // blames the live region. The tag-level assertion above already covers the inline spelling.
    const hidingRules = [...styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(([, , body]) => /display:\s*none|visibility:\s*hidden/.test(body))
      .map(([, selector]) => selector.trim().replace(/\s+/g, ' '));
    // Reach is decided on the FINAL compound — the part that has to match the element itself. A token
    // heuristic misses `.email-form :empty` (names no element yet matches) and false-positives on
    // `div.foo` (names `div` yet cannot match). Pseudo-classes are dropped: these elements can satisfy
    // `:empty` and friends, so they never rule anything out. The set covers BOTH the region and the
    // note inside it — hiding either leaves nothing to announce.
    const canReachAnnouncement = (selectorList: string) =>
      selectorList.split(',').some((selector) => {
        const compound =
          selector
            .trim()
            .split(/[\s>+~]+/)
            .filter(Boolean)
            .pop() ?? '';
        const tokens = compound
          .replace(/::?[\w-]+(\([^)]*\))?/g, '')
          .match(/[#.]?[\w*-]+|\[[^\]]*\]/g);
        return (tokens ?? []).every((t) =>
          t.startsWith('.')
            ? announcementClasses.includes(t.slice(1))
            : t.startsWith('[')
            ? /^\[\s*role\b/.test(t)
            : t.startsWith('#')
            ? false
            : t === 'div' || t === 'p' || t === '*'
        );
      });
    expect(announcementClasses, 'neither the region nor the note carries a class').not.toHaveLength(
      0
    );
    expect(
      hidingRules.filter(canReachAnnouncement),
      'a CSS rule that can match the live region or the note inside it hides it. While the region is ' +
        'empty that is the same no-announce shape as never rendering it. Narrow the selector so it ' +
        'cannot reach either element, or use a non-hiding property.'
    ).toEqual([]);
  });

  it('keeps the always-mounted live region out of the form layout', () => {
    // The region is mounted for every visitor, including the overwhelming majority who never see a
    // note, and as a flex child of .email-form an empty one still spends a 0.6rem gap — every login
    // page laid out around content that is not there. `display: contents` is the only removal that
    // leaves the element in the accessibility tree; the alternatives are the hiding the test above
    // bans. Whether the announcement survives it is a browser fact no test here can reach — that
    // claim belongs to a manual check with a screen reader, not to this guard.
    expect(
      liveRegionClasses,
      'the live region carries no class, so no rule can take it out of the flex flow'
    ).not.toHaveLength(0);
    const removedFromFlow = liveRegionClasses.some((cls) =>
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
    // The terminator is the callback's OWN closer, found by back-reference to its opening indentation
    // rather than a literal depth — a nested `}` is deeper, so a re-wrapped body is captured whole and
    // shows up here as extra entries, while wrapping the whole call in a try block does not red it.
    // Anchored on ts.render(managedEl, …): without that, the statements can be left intact in an
    // options object that is never handed to Turnstile, so the widget renders with no callbacks at all.
    // Two separate failures, so a red says which: the call site is gone, or its body no longer closes.
    const callSite = /ts\.render\(managedEl, \{[\s\S]*?\n( +)callback: \(t: string\) => \{/;
    expect(markup, 'ts.render(managedEl, …) with a (t: string) success callback not found').toMatch(
      callSite
    );
    const body = markup.match(new RegExp(callSite.source + '([\\s\\S]*?)\\n\\1\\},'))?.[2];
    expect(
      body,
      'managed success callback body has no closer at its own indentation'
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

  // SEAM between this component and turnstile-availability.ts. The probe's timing is pinned in
  // ./turnstile-availability.test.ts; this side pins that the component routes its absence-shaped
  // evidence through it.
  it('reaches the unavailable verdict only through the probe or a Turnstile error callback', () => {
    // The 8s deadline with no token, and an absent `turnstile` global, are the same evidence a SLOW
    // connection produces — the api.js tag is `async defer`. A site that concludes from either without
    // a second look announces "email login can't complete" to a user whose login completes seconds later.
    const setter = normalize(
      markup.match(/const concludeUnavailable = \(\) => \{[\s\S]*?\};/)?.[0] ?? ''
    );
    expect(setter, 'concludeUnavailable declaration not found').toBe(
      'const concludeUnavailable = () => { captchaUnavailable = true; };'
    );
    // One writer, so the verdict cannot be reached behind the ledger below.
    expect(markup.match(/captchaUnavailable = true/g) ?? []).toHaveLength(1);

    // Ledger of every line naming it, PAIRED WITH THE SCOPE IT SITS IN. A new route makes this list
    // grow and must restate what evidence it has; deleting one makes it shrink. The scope is what stops
    // a line being moved between functions — two `concludeUnavailable();` lines are indistinguishable
    // without it, and swapping one for the managed render disables the fallback under an identical list.
    const sites = ledger('concludeUnavailable');
    expect(sites).toEqual([
      ['concludeUnavailable', 'const concludeUnavailable = () => {'],
      // No managed key: no second widget to offer, so the token alone decides — after the grace.
      [
        '$effect',
        'return decideAfterGrace({ tokenArrived: () => !!captchaToken, decide: concludeUnavailable });',
      ],
      // The managed slot's probe: script absent after the grace → soft-release.
      ['$effect', 'concludeUnavailable();'],
      // The managed widget's own error callback — Turnstile reporting its failure, so no grace needed.
      ['renderManagedWidget', 'concludeUnavailable();'],
      // render() produced no widget, so there is nothing to wait for and no error callback coming.
      ['renderManagedWidget', 'concludeUnavailable();'],
    ]);
  });

  it('re-arms the grace on every failure, not once per page load', () => {
    // An $effect re-runs only when a dependency CHANGES, and Svelte short-circuits a write of an equal
    // value — so a boolean set to `true` a second time re-arms nothing. That is reachable: the widget
    // can fail, recover with a token that spends the grace harmlessly, and fail again after
    // resetTurnstile() clears the token on the next submit. With no second arm the verdict never
    // lands: captchaPending stays true, the submit is disabled for the rest of the session, and
    // captchaBlocked stays false so the honest note never appears either.
    // This is a source-text guard, not a behavioural one — no component can be mounted here — so it
    // pins the RELATIONSHIP: the trigger produces a fresh value, and the grace effect reads that value.
    const trigger = markup.match(/function triggerFallback\([\s\S]*?\n  \}/)?.[0] ?? '';
    expect(trigger, 'triggerFallback not found').not.toBe('');
    const armed = trigger.match(/else (\w+) \+= 1;/)?.[1];
    expect(
      armed,
      'the no-managed-key arm does not produce a new value on every call'
    ).toBeDefined();
    const grace =
      markup.match(/\$effect\(\(\) => \{[\s\S]*?decideAfterGrace[\s\S]*?\n  \}\);/)?.[0] ?? '';
    expect(grace, 'the decideAfterGrace effect not found').not.toBe('');
    expect(grace, 'the grace effect does not depend on the value the trigger bumps').toContain(
      `${armed} ===`
    );
  });

  it('asks nobody to solve a challenge that is not on screen', () => {
    const guarded = markup.match(
      /\{#if managedWidgetShown && !captchaBlocked\}([\s\S]*?)\{\/if\}/
    )?.[1];
    expect(guarded, 'the fallback prompt is not gated on the widget being on screen').toBeDefined();
    expect(guarded).toContain('Complete this quick check to continue.');
    expect(markup.split('Complete this quick check to continue.')).toHaveLength(2);
    expect(markup, 'the slot reserves height before the widget exists').toMatch(
      /class:collapsed=\{captchaBlocked \|\| !managedWidgetShown\}/
    );
    expect(markup, 'the button invites a solve before the widget exists').toMatch(
      /\? managedWidgetShown\s*\n\s*\? 'Verify to continue'\s*\n\s*: 'Verifying…'/
    );

    // Pinning the readers is worth nothing while nothing SETS the mirror — it would be false forever,
    // and all three assertions above would still pass.
    expect(ledger('managedWidgetShown = true')).toEqual([
      ['renderManagedWidget', 'managedWidgetShown = true;'],
    ]);
    const renderBody = markup.match(/function renderManagedWidget\(\)[\s\S]*?\n  \}/)?.[0] ?? '';
    expect(renderBody, 'renderManagedWidget body not found').not.toBe('');
    expect(renderBody.indexOf('managedWidgetShown = true')).toBeGreaterThan(
      renderBody.indexOf('ts.render(managedEl')
    );
  });

  it('releases the gate when no widget could be created at all', () => {
    expect(markup, 'the render() return type is declared as always-a-string').toMatch(
      /render: \([^)]*\) => string \| null \| undefined;/
    );
    const renderBody = markup.match(/function renderManagedWidget\(\)[\s\S]*?\n  \}/)?.[0] ?? '';
    expect(renderBody, 'renderManagedWidget body not found').not.toBe('');
    // A throw out of render() is the same outcome by a quieter route, so it lands in the same branch.
    // The call being inside a try is the claim; how the catch spells it is not.
    expect(renderBody, 'render() can throw past the guard').toMatch(/\} catch \{/);
    const failure = renderBody.match(/if \(typeof id !== 'string'\) \{([\s\S]*?)\n    \}/)?.[1];
    expect(failure, 'no branch for a render that produced no widget').toBeDefined();
    expect(failure).toContain("captchaFailReason = 'fallback-error';");
    expect(failure).toContain('concludeUnavailable();');
    expect(failure).toContain('return;');
    // …and the mirror must be set only past that branch, or it claims a widget that does not exist.
    expect(renderBody.indexOf('managedWidgetShown = true')).toBeGreaterThan(
      renderBody.indexOf("if (typeof id !== 'string')")
    );
  });

  it('surfaces the note proactively, not only after a wasted submit', () => {
    // Gating it on `form` would mean the user learns only after spending a rate-limit slot.
    const condition = pageSource.match(/\{#if captchaBlocked[^}]*\}/)?.[0] ?? '';
    expect(condition).toBe('{#if captchaBlocked}');
    // …and it sits inside the email form, above the submit button, so it is read before the click.
    // Anchor on the email submit's own markup: the logout form has a `<button type="submit">` too.
    const formStart = markup.search(EMAIL_FORM_ANCHOR);
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
