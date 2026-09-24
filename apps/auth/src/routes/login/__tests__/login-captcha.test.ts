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
// The whole region element, extracted ONCE: its position, its inner text and its length all come off
// this. Three separate near-identical extractions is the duplicated-anchor trap this file warns about
// two comments up — tighten one copy and the others quietly point at nothing.
const LIVE_REGION = markup.match(new RegExp(LIVE_REGION_TAG.source + '([\\s\\S]*?)<\\/div>'));
const liveRegionInner = LIVE_REGION?.[1] ?? '';
// Same rule, same reason: three tests read renderManagedWidget's body and two read its no-widget
// branch. A rename or a change to the closing indentation would otherwise empty whichever copies the
// edit missed, and an emptied anchor yields `undefined`, not a red, at most of the sites.
const RENDER_BODY = markup.match(/function renderManagedWidget\(\)[\s\S]*?\n {2}\}/)?.[0] ?? '';
const NO_WIDGET_BRANCH = RENDER_BODY.match(
  /if \(typeof id !== 'string'\) \{([\s\S]*?)\n {4}\}/
)?.[1];
// The note element itself, not only its wrapper — extracted ONCE, same rule as above: two readers now
// (its classes, and the inline-hide ban), and two hand-written patterns for one element disagree the
// moment an attribute is added before `class`. Hiding `.captcha-fallback-note` empties the region just
// as completely as hiding the region, and it is the more natural thing for a responsive edit to reach
// for — it is the element with the padding and the background.
const NOTE_TAG_TEXT = liveRegionInner.match(/<p\b[^>]*>/)?.[0] ?? '';
const blockedNoteClasses = (NOTE_TAG_TEXT.match(/class="([^"]*)"/)?.[1] ?? '')
  .split(/\s+/)
  .filter(Boolean);
// Covers BOTH the region and the note; each half is asserted non-empty where the ban is applied.
const announcementClasses = [...liveRegionClasses, ...blockedNoteClasses];
const styleStart = pageSource.indexOf('<style');
// indexOf returns -1 the moment the tag gains an attribute, and slice(-1) then yields the file's LAST
// CHARACTER — a guard that passes forever against a 1-char string.
// CSS comments come out for the same reason script comments come out of `markup`: the rules below ban
// a property by reading the text, and the comments most likely to spell `display: contents` are the
// ones explaining why it is banned.
const styles = (styleStart > -1 ? pageSource.slice(styleStart) : '').replace(
  /\/\*[\s\S]*?\*\//g,
  ''
);

// Only these name the SUBJECT of the compound they sit in, so only their argument can rule a rule out.
// `:not()` names what it EXCLUDES and `:has()` names a descendant — read either as a subject and the
// answer inverts, turning a rule that DOES hide the region into one reported as unable to reach it.
// Everything outside this set therefore counts as reaching, deliberately erring toward a FALSE BLOCK:
// an unrelated `:not()` hide can red under this ban's name, which is loud and fixable by narrowing the
// selector, while the error in the other direction is this guard silently passing a hidden announcement.
const SUBJECT_PSEUDO = /^::?(?:is|where|matches|global)\(/;

// Can this selector list match the live region, or the note inside it? Reach is decided on the FINAL
// compound — the part that has to match the element itself. A token heuristic misses `.card :empty`
// (names no element yet matches) and false-positives on `div.foo` (names `div` yet cannot match).
// Pseudo-classes are dropped from the compound: these elements can satisfy `:empty` and friends, so a
// bare pseudo never rules anything out.
// A compound that is ENTIRELY pseudo therefore strips to nothing, and `[].every(...)` is vacuously TRUE.
// That answer is RIGHT for anything whose argument does not name the subject — an argument-less pseudo
// names no element at all, and `:not()`/`:has()` name something other than what they match — so reach
// stays the safe default there. It is WRONG only for the subject pseudos above: `:global(svg)` and
// `:is(.foo)` do name what the compound matches, and every such rule in the sheet was being reported as
// reaching the region. Those, and only those, are decided from the argument.
// Split OUTSIDE parens and brackets. Both splits below are structural, and `String.split` is blind to
// nesting: on `:not(.a, .b)` it tears the compound at the comma, and the fragment `:not(.a` then reads
// as the plain class `.a` because the strip pattern's optional argument group needs a closing paren
// that is now on the other fragment. The combinator split has the identical hole at the SPACE after
// that comma. Either one makes the multi-argument spelling of an inverting pseudo answer "cannot
// reach" for a rule that does hide the region — the one answer this must never give — and that
// spelling is the natural one for a "hide everything except these" compaction edit.
const splitTopLevel = (text: string, isSeparator: (c: string) => boolean): string[] => {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '(' || c === '[') depth += 1;
    else if (c === ')' || c === ']') depth -= 1;
    else if (depth === 0 && isSeparator(c)) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
};

const canReachAnnouncement = (selectorList: string): boolean =>
  splitTopLevel(selectorList, (c) => c === ',').some((selector) => {
    const compound =
      splitTopLevel(selector.trim(), (c) => /[\s>+~]/.test(c))
        .filter(Boolean)
        .pop() ?? '';
    const tokens = compound.replace(/::?[\w-]+(\([^)]*\))?/g, '').match(/[#.]?[\w*-]+|\[[^\]]*\]/g);
    if (!tokens?.length) {
      const fns = [...compound.matchAll(/::?[\w-]+\([^)]*\)/g)].map((m) => m[0]);
      // `[^)]*` cannot span a nested `(`, so a compound these do not fully reassemble was never
      // parsed — answer from the safe side rather than from a fragment. That also makes any future
      // disagreement between this pattern and the strip pattern above fail toward "reaches".
      if (!fns.length || fns.join('') !== compound || !fns.every((fn) => SUBJECT_PSEUDO.test(fn)))
        return true;
      return canReachAnnouncement(fns.map((fn) => fn.slice(fn.indexOf('(') + 1, -1)).join(','));
    }
    return tokens.every((t) =>
      t.startsWith('.')
        ? // Class names are the one case-SENSITIVE part of a selector for HTML, so compare as written.
          announcementClasses.includes(t.slice(1))
        : // ANY attribute selector reaches. Both guarded elements carry `class`, one carries `role`, and
        // `[class~='live-region']` / `[class*='live']` / `[class]` all match them while naming no class
        // token this can compare. Attribute NAMES are also case-insensitive for HTML, so `[ROLE=...]`
        // is the same selector as `[role=...]`. An allowlist here answered "cannot reach" for every one
        // of those, which is the one answer an absence-ban must never give; erring the other way can
        // only produce a loud red on an unrelated attribute hide.
        t.startsWith('[')
        ? true
        : t.startsWith('#')
        ? false
        : // Type selectors are case-insensitive for HTML too.
          ['div', 'p', '*'].includes(t.toLowerCase())
    );
  });

// Every rule in the sheet whose body declares `prop` AND whose selector can reach the announcement.
// ONE mechanism for both property bans below: the alternative — a bespoke regex per property, matched
// against the region's own classes — cannot see `[role='status']` or `.card > *`, and once a ban asserts
// ABSENCE every shape its regex cannot see becomes a silent pass rather than a loud red.
// The body is NORMALISED before matching, for that same reason: `display : none`, `DISPLAY:NONE` and
// `display:none` are one declaration to a browser, and `prop` is written in the tightest spelling.
// Its OWN contract is asserted here, not restated at each caller: this returns [] both when nothing
// reaches the announcement and when it had no stylesheet to read or no class to compare, and a caller
// asserting an ABSENCE cannot tell those apart. Every ban built on it inherits the check for free.
const rulesDeclaring = (prop: RegExp) => {
  expect(styles, '<style> block not found').not.toBe('');
  expect(liveRegionClasses, 'the live region carries no class').not.toHaveLength(0);
  expect(blockedNoteClasses, 'the blocked note carries no class').not.toHaveLength(0);
  return [...styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, , body]) => prop.test(body.toLowerCase().replace(/\s*:\s*/g, ':')))
    .map(([, selector]) => selector.trim().replace(/\s+/g, ' '))
    .filter(canReachAnnouncement);
};

// Every line naming `identifier`, paired with the top-level scope it sits in. Scope resolution includes
// the matched line, so a declaration is its own scope. Trailing comments are stripped: a ledger pins
// what the code does, and rewording a comment beside it is not a change to that.
const ledger = (identifier: string) => {
  const scopeOf = (end: number) => {
    const opener = [
      ...markup.slice(0, end).matchAll(/^ {2}(?:function (\w+)\(|const (\w+) =|(\$effect)\()/gm),
    ].pop();
    return opener ? opener[1] ?? opener[2] ?? opener[3] : '(module)';
  };
  return [...markup.matchAll(new RegExp(`^.*${identifier}.*$`, 'gm'))].map((m) => [
    scopeOf((m.index ?? 0) + m[0].length),
    m[0].replace(/\s*\/\/.*$/, '').trim(),
  ]);
};

describe('login copy when the verification check cannot run', () => {
  it('derives the blocked state from ENFORCEMENT, an unavailable widget, and no token', () => {
    // All three terms are load-bearing, and each has its own way of producing a false note:
    //  - the token deadline sets captchaUnavailable even with captcha switched off entirely, and a bare
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

  // SCOPE for the two tests below: a source-text suite can show the region is a sibling of the form
  // rather than a child of it, and that nothing in this file hides it. It CANNOT see an ancestor ELEMENT
  // wrapped around the pair, so that hole stays open by construction rather than by oversight.
  it('keeps the live region beside the form, out of its flex flow and out of its blocks', () => {
    // A role="status" created together with its text does not announce, and the note appears with no
    // user action behind it. FOUR claims, each with its own way of going green while broken:
    //  - the note must be INSIDE the region (ordering alone survives moving the note below it),
    //  - the region must open NO block before the note (containment alone survives a nested
    //    `{#if captchaBlocked}{#if form}`, which is the wasted-submit regression by another spelling),
    //  - the region must sit OUTSIDE .email-form. As a flex child, an always-mounted empty region spends
    //    the form's 0.6rem gap on every login page that never fills it, and the removals available from
    //    inside are hiding (the no-announce shape) or `display: contents`, whose accessibility-tree
    //    effect is a browser fact no test here can settle. Out of the container the empty div costs
    //    nothing and the announcement rests on an ordinary in-flow role="status".
    //  - the region must be exactly as conditional as the form it explains: no block may open or close
    //    between the two, so anything that hides the region hides the form with it. (A block wrapping
    //    BOTH is not caught and does not need to be — it takes the form away too, so no user is left
    //    looking at a form with no explanation.)
    // Every anchor is read from the comment-stripped copy: a comment can spell any token a guard looks
    // for, the comment forbidding the fold included, and that comment is what an edit folding it rewrites.
    expect(markup, 'no role="status" wrapper found').toMatch(LIVE_REGION_TAG);

    const region = liveRegionInner;
    expect(region, 'live region is present but empty').toContain('{#if captchaBlocked}');
    // The note sits at depth 1 inside the region: exactly ONE block opened before it and none closed.
    // A prefix match is not enough — `{#if captchaBlocked}{#if form}` still starts with the right
    // literal while putting the note behind a second condition, which is the wasted-submit regression.
    const noteStart = region.indexOf('<p');
    expect(noteStart, 'no note element inside the live region').toBeGreaterThan(-1);
    const beforeNote = region.slice(0, noteStart);
    expect((beforeNote.match(/\{#/g) ?? []).length, 'extra block opened before the note').toBe(1);
    expect((beforeNote.match(/\{\//g) ?? []).length).toBe(0);

    // Sibling, above the form. Block counting runs over the unquoted text: stripping quoted spans pairs
    // the apostrophe in "Couldn't" with the next quote and swallows a {/if}, and the prose that would
    // justify stripping lives in comments, which are already gone.
    const formStart = markup.search(EMAIL_FORM_ANCHOR);
    // Without these the slice can silently go empty (anchor lost → -1, or the region moved below the
    // form → start > end), and `0 === 0` would pass with the region wrapped in a condition.
    expect(formStart, 'email-form anchor not found').toBeGreaterThan(-1);
    expect(LIVE_REGION, 'live region has no closing tag').not.toBeNull();
    const regionStart = LIVE_REGION?.index ?? -1;
    expect(regionStart, 'live region not found in the markup').toBeGreaterThan(-1);
    expect(
      regionStart,
      'the live region is not above the email form. Inside or after it, the region is a flex child of ' +
        '.email-form and spends a 0.6rem gap on every login page that never fills it.'
    ).toBeLessThan(formStart);
    const between = markup.slice(regionStart + (LIVE_REGION?.[0].length ?? 0), formStart);
    expect(
      (between.match(/\{[#/]/g) ?? []).length,
      'a Svelte block opens or closes between the live region and the form it explains'
    ).toBe(0);
    // …and no rule may put it back out of flow. Same reach query as the hiding ban below, deliberately:
    // a bespoke regex over the region's own classes cannot see `[role='status']` or `.card > *`, and an
    // ABSENCE assertion turns each shape it cannot see into a silent pass.
    expect(
      rulesDeclaring(/display:contents/),
      '`display: contents` is back on the live region or the note inside it. It buys 0.6rem of gap ' +
        'against an accessibility-tree claim this repo cannot verify; keeping the region out of ' +
        '.email-form costs nothing instead.'
    ).toEqual([]);
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
    // BOTH tags, for the same reason the CSS ban covers both elements: the note carries the padding and
    // the background, so an inline `style:display` lands on it at least as readily as on its wrapper,
    // and hiding it empties the announcement just as completely. `aria-live` is only meaningful on the
    // region, but a stray `aria-live="off"` on the note is not a thing to permit either.
    const INLINE_HIDE =
      /\bhidden\b|class:|aria-live=['"]off|style:(display|visibility)|style=["{][^>]*?(display|visibility)/;
    expect(liveRegionTagText, 'the region tag can hide or mute itself').not.toMatch(INLINE_HIDE);
    expect(NOTE_TAG_TEXT, 'no note element found inside the live region').not.toBe('');
    expect(NOTE_TAG_TEXT, 'the note tag can hide or mute itself').not.toMatch(INLINE_HIDE);
    // …and NEITHER may carry an id. The reach test answers a hard `false` for an `#id` compound, which
    // is only sound while these elements have no id to select — and an id is one ordinary edit away
    // (aria-describedby, a scroll anchor, a test hook). Measured: with an id on the region and a
    // matching `#id { display: none }` in the sheet, every guard here stays green while the
    // announcement is hidden. Pinning the precondition is cheaper than widening `#` to "reaches",
    // which would red on any unrelated id-scoped hide.
    expect(
      liveRegionTagText,
      'the region tag carries an id, which the reach test cannot see'
    ).not.toMatch(/\bid=/);
    expect(
      NOTE_TAG_TEXT,
      'the note tag carries an id, which the reach test cannot see'
    ).not.toMatch(/\bid=/);
    expect(styles, '<style> block not found').not.toBe('');

    // The DECLARATION is the mechanism, not the selector: `:empty` hides nothing on its own, and
    // banning it reds a legitimate `:not(:empty) { margin… }`.
    // LIMIT, stated precisely because the assertion's name over-sells it: only rules whose FINAL
    // COMPOUND can match the region or the note are searched (see canReachAnnouncement above). A rule
    // hiding an ANCESTOR — `.card`, `main` — empties the announcement just as completely and is NOT
    // searched. That is left open on purpose: an ancestor hide takes the entire login card down with
    // it, which nobody can ship without noticing, whereas banning the pair across the whole stylesheet
    // reds on an ordinary responsive edit — a `@media` rule hiding the divider — under a name that
    // blames the live region. The tag-level assertion above covers the inline spelling.
    expect(
      rulesDeclaring(/display:none|visibility:hidden/),
      'a CSS rule that can match the live region or the note inside it hides it. While the region is ' +
        'empty that is the same no-announce shape as never rendering it. Narrow the selector so it ' +
        'cannot reach either element, or use a non-hiding property.'
    ).toEqual([]);
  });

  // INSTRUMENT CONTROL, not component coverage: this exercises the reach test above, which is the thing
  // deciding whether the ban ever fires. A reassuring empty `hidingRules.filter(...)` is indistinguishable
  // from a filter wired to nothing, so it is pinned against cases that MUST match and cases that must not.
  // It does NOT read the stylesheet, so no CSS edit can red it — but it DOES read the two class names off
  // the markup, so removing the class from the region or the note reds it here as well as elsewhere.
  it('decides reach from the element the rule can actually match', () => {
    const [regionClass] = liveRegionClasses;
    const [noteClass] = blockedNoteClasses;
    expect(regionClass, 'live region class not found').toBeTruthy();
    expect(noteClass, 'blocked note class not found').toBeTruthy();
    // Reaches: the region, the note, the role, and an argument-less pseudo, which names no element.
    expect(canReachAnnouncement(`.${regionClass}`)).toBe(true);
    expect(canReachAnnouncement(`.${noteClass}`)).toBe(true);
    expect(canReachAnnouncement('[role="status"]')).toBe(true);
    expect(canReachAnnouncement('.card :empty')).toBe(true);
    expect(canReachAnnouncement(`.nope, .${regionClass}`)).toBe(true);
    // A purely-pseudo final compound strips to NO tokens, where `every` is vacuously true. A SUBJECT
    // pseudo is decided from its argument instead: `svg` cannot be the region or the note, the region's
    // own class inside `:is()` can. Without that branch the first of these is a false positive.
    expect(canReachAnnouncement('.badge :global(svg)')).toBe(false);
    expect(canReachAnnouncement(`.badge :is(.${regionClass})`)).toBe(true);
    // …and the INVERTING pseudos must NOT be read that way. `.card > :not(.divider)` genuinely hides
    // the region (a direct child of .card — Svelte blocks create no elements), and `:has()` names a
    // descendant, not the subject. Reading either argument as a subject filter reports both as unable
    // to reach, which is the one answer this ban must never give about a rule that does hide it.
    expect(canReachAnnouncement('.card > :not(.divider)')).toBe(true);
    expect(canReachAnnouncement('.card :has(.divider)')).toBe(true);
    expect(canReachAnnouncement(`.card :is(.divider):not(.${regionClass})`)).toBe(true);
    // …including the MULTI-ARGUMENT spelling, which is the natural one for "hide everything except
    // these". A naive `split(',')` tears these in half and both halves answer "cannot reach".
    expect(canReachAnnouncement('.card > :not(.divider, .socials)')).toBe(true);
    expect(canReachAnnouncement('.card > :has(.divider, .socials)')).toBe(true);
    // …and a nested functional pseudo, which the flat `[^)]*` grammar cannot parse, answers safely.
    expect(canReachAnnouncement('.badge :global(:not(.divider))')).toBe(true);
    // …and ATTRIBUTE selectors, in every spelling that matches these two elements while naming no class
    // token the reach test can compare. An allowlist of `role` answered "cannot reach" for all of them.
    // One case is enough: the branch is an unconditional `true`, so `[class~=…]`, `[class*=…]` and
    // `[class]` all exercise the same line. What the old `role`-only allowlist got wrong was answering
    // `false` for every attribute that is not `role`.
    expect(canReachAnnouncement(`[class~='${regionClass}']`)).toBe(true);
    // …and type names are case-INSENSITIVE for HTML, while class names are not.
    expect(canReachAnnouncement('DIV[role]')).toBe(true);
    expect(canReachAnnouncement(`.${regionClass.toUpperCase()}`)).toBe(false);
    // The `#` branch stays a hard `false`, which is sound only because neither element carries an id —
    // asserted in the hiding ban above, not here.
    expect(canReachAnnouncement('#anything')).toBe(false);
    // A genuine multi-selector list still splits: neither side reaches.
    expect(canReachAnnouncement('.badge svg, .divider span')).toBe(false);
    // …and a subject pseudo with several arguments still decides from them.
    expect(canReachAnnouncement(`.card :is(.divider, .${noteClass})`)).toBe(true);
    expect(canReachAnnouncement('.card :is(.divider, .socials)')).toBe(false);
    // Does not reach: an unrelated element, an id, an ancestor-only compound.
    expect(canReachAnnouncement('.badge svg')).toBe(false);
    expect(canReachAnnouncement('div.divider')).toBe(false);
    expect(canReachAnnouncement('#something')).toBe(false);
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
    // The token deadline with no token, and an absent `turnstile` global, are the same evidence a SLOW
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

  it('hands the fallback commitment back at every exit that leaves the slot empty', () => {
    // `fallbackActive` gates the managed effect AND short-circuits triggerFallback, while that effect's
    // dependencies (fallbackActive, managedEl) do not move on a later failure — so a latched `true`
    // holding no widget is a state nothing can reach. The token that let the page get there is cleared
    // by resetTurnstile() on the next submit, and what is left is a disabled submit with no note, for
    // the rest of the session. THREE exits reach it, and the suite pins all three together because
    // fixing one and leaving the others is exactly what happened before:
    //  - probeTurnstile's withdrawal, which resolves to neither outcome by design,
    //  - the script being absent after the grace,
    //  - a render() that produced no widget.
    // A RENDERED widget must keep the commitment instead: that one re-derives a verdict through its own
    // error-callback and is re-solved by resetTurnstile(), while the unmount would be unrecoverable.
    // The three exits are asserted ONE BY ONE and BEFORE the ledgers, so a red names which regressed —
    // the ledgers below fail identically for all three and would mask them behind one diff.
    const grace = markup.match(/probeTurnstile\(\{[\s\S]*?\n {4}\}\);/)?.[0] ?? '';
    expect(grace, 'the managed probe not found').not.toBe('');
    expect(grace, 'the withdrawal exit does not hand the commitment back').toMatch(
      /onWithdrawn: releaseFallbackIfEmpty,/
    );
    const absent = grace.match(/onScriptAbsent: \(\) => \{([\s\S]*?)\n {6}\},/)?.[1];
    expect(absent, 'the script-absent handler not found').toBeDefined();
    expect(absent ?? '', 'the script-absent exit does not hand the commitment back').toContain(
      'releaseFallbackIfEmpty();'
    );
    expect(NO_WIDGET_BRANCH, 'no branch for a render that produced no widget').toBeDefined();
    expect(
      NO_WIDGET_BRANCH ?? '',
      'the no-widget render exit does not hand the commitment back'
    ).toContain('releaseFallbackIfEmpty();');

    // ONE WRITER of the release, so the guard on "no widget to destroy" cannot be dropped at one site
    // only, and no fourth route can set the commitment behind the ledger.
    expect(ledger('fallbackActive = (?:true|false)')).toEqual([
      ['releaseFallbackIfEmpty', 'if (managedWidgetId === undefined) fallbackActive = false;'],
      ['triggerFallback', 'if (data.turnstileManagedSiteKey) fallbackActive = true;'],
    ]);
    // …and the complete list of call sites, in FILE ORDER. This is what catches an EXTRA release (one
    // added on a path that does hold a widget) and a release MOVED between handlers of the same effect,
    // which the scope column alone cannot see — every handler there reports `$effect`.
    expect(ledger('releaseFallbackIfEmpty')).toEqual([
      ['releaseFallbackIfEmpty', 'const releaseFallbackIfEmpty = () => {'],
      ['$effect', 'onWithdrawn: releaseFallbackIfEmpty,'],
      ['$effect', 'releaseFallbackIfEmpty();'],
      ['renderManagedWidget', 'releaseFallbackIfEmpty();'],
    ]);
  });

  it('never concludes the check is blocked where no check was ever offered', () => {
    // `captchaBlocked` consults ENFORCEMENT but not whether a widget exists, and the note it gates
    // blames the reader's browser. With enforcement on and NEITHER sitekey configured, nothing on the
    // page ever requests a token — no api.js, no .cf-turnstile, no managed slot — so the one route to
    // captchaUnavailable that survives is the onMount deadline. Unguarded it fires on every page load
    // for every visitor, and ~5s later the page tells all of them an extension, a VPN or a network
    // filter is blocking a check that was never offered. That claim is not merely unhedgeable there,
    // it is refutable from `data` alone. The other two routes to the verdict sit behind fallbackActive,
    // which only a managed sitekey sets, so guarding the deadline closes the class at its root — which
    // is why captchaBlocked itself carries no captchaConfigured term.
    const mount = markup.match(/onMount\(\(\) => \{[\s\S]*?\n {2}\}\);/)?.[0] ?? '';
    expect(mount, 'the onMount block was not found').not.toBe('');
    const armed = mount.match(/const timeout = ([\s\S]*?);\n {4}return \(\) => \{/)?.[1] ?? '';
    expect(armed, 'the deadline is not assigned to `timeout` before the teardown').not.toBe('');
    // The DEPENDENCY, not the operator: a ternary, a `&&`, or anything else that makes the arming
    // expression read captchaConfigured satisfies this, and an unconditional arm does not. LIMIT: the
    // extraction below assumes `const timeout = <expr>;`, so rewriting this as a bare `if` statement
    // reds here — widen the extraction with that change rather than dropping the guard.
    expect(
      armed,
      'the token deadline is armed without consulting captchaConfigured, so it concludes "this ' +
        'browser is blocking the check" in a configuration that never offered one'
    ).toContain('captchaConfigured');
    expect(armed, 'the deadline does not call triggerFallback').toContain(
      "triggerFallback('timeout')"
    );
    // A bare literal here is a second, unnamed copy of a timing constant the cost note reasons about.
    expect(armed, 'the deadline length is an unnamed literal').toContain(
      'TURNSTILE_TOKEN_DEADLINE_MS'
    );
  });

  it('does not re-offer the fallback while an unavailable verdict stands', () => {
    // The two exits that CONCLUDE the verdict also hand the commitment back, so re-entry is open while
    // the verdict is on screen — and nothing clears the verdict except a token. Reachable: api.js is
    // `async defer`, so it can land after the grace, auto-render the invisible widget, and have that
    // widget error. Re-entering then renders a live, SOLVABLE managed challenge with its prompt
    // suppressed and its box collapsed (both gated on captchaBlocked) directly under a role="status"
    // note telling the user email login cannot complete and to reload — the screen contradicting
    // itself about the user's own situation. The same re-entry overwrites captchaFailReason, recording
    // an unrecoverable submit as recoverable in the server's no_token split.
    // The term cannot trap anyone, which is the constraint every guard here answers to: captchaPending
    // is false whenever captchaUnavailable is true, so the submit is already released and the server is
    // the sole gate; and both success callbacks clear the verdict, so a token — the one thing that
    // proves the check CAN run here — re-opens re-entry immediately.
    const guard = normalize(
      markup.match(/function triggerFallback\(reason: string\) \{\n([^\n]*)/)?.[1] ?? ''
    );
    expect(guard, 'triggerFallback does not open with a short-circuit').not.toBe('');
    expect(guard).toBe('if (fallbackActive || !captchaPending) return;');
  });

  it('asks nobody to solve a challenge that is not on screen, or that nothing is waiting on', () => {
    // ON SCREEN, because the slot mounts a grace period before the widget can render and asking for a
    // check that is not there yet is an instruction with no target. AND captchaPending, because that IS
    // the predicate "solving this is what unblocks the button" — the same expression the button reads,
    // so the two cannot disagree. Hand-spelling it as `!captchaBlocked && !captchaToken` is equal on
    // the common path and leaves the instruction standing beside an ALREADY-ENABLED button in two
    // others: a rendered widget that errored with enforcement off, and a deployment whose invisible
    // sitekey has no secret.
    const guarded = markup.match(
      /\{#if managedWidgetShown && captchaPending\}([\s\S]*?)\{\/if\}/
    )?.[1];
    expect(
      guarded,
      'the fallback prompt is not gated on the widget being on screen AND the submit still being gated'
    ).toBeDefined();
    expect(guarded).toContain('Complete this quick check to continue.');
    expect(markup.split('Complete this quick check to continue.')).toHaveLength(2);
    // The slot's height and the prompt read ONE rule, negated — they diverged once already, leaving a
    // bare Cloudflare challenge in an expanded box with no copy beside it.
    expect(markup, 'the slot reserves height for a widget nothing is waiting on').toMatch(
      /class:collapsed=\{!managedWidgetShown \|\| !captchaPending\}/
    );
    expect(markup, 'the button invites a solve before the widget exists').toMatch(
      /\? managedWidgetShown\s*\n\s*\? 'Verify to continue'\s*\n\s*: 'Verifying…'/
    );

    // Pinning the readers is worth nothing while nothing SETS the mirror — it would be false forever,
    // and all three assertions above would still pass.
    expect(ledger('managedWidgetShown = true')).toEqual([
      ['renderManagedWidget', 'managedWidgetShown = true;'],
    ]);
    expect(RENDER_BODY, 'renderManagedWidget body not found').not.toBe('');
    expect(RENDER_BODY.indexOf('managedWidgetShown = true')).toBeGreaterThan(
      RENDER_BODY.indexOf('ts.render(managedEl')
    );
  });

  it('releases the gate when no widget could be created at all', () => {
    expect(markup, 'the render() return type is declared as always-a-string').toMatch(
      /render: \([^)]*\) => string \| null \| undefined;/
    );
    expect(RENDER_BODY, 'renderManagedWidget body not found').not.toBe('');
    // A throw out of render() is the same outcome by a quieter route, so it lands in the same branch.
    // The call being inside a try is the claim; how the catch spells it is not — an empty body is safe,
    // because `let id` with no initializer is already undefined. What is NOT safe is a catch that
    // assigns a STRING: that walks past the branch below and reaches the mirror with an id naming no
    // widget, which is the trap again with a container-only check satisfied.
    const catchBody = RENDER_BODY.match(/\} catch \{([\s\S]*?)\n {4}\}/)?.[1];
    expect(catchBody, 'render() is not called inside a try').toBeDefined();
    expect(catchBody ?? '', 'the catch leaves a string in `id`').not.toMatch(
      /\bid\s*=\s*(?!undefined\b|null\b)\S/
    );
    // A bare `return` is the other spelling that passes a container-only check and skips the branch,
    // leaving no widget, no verdict and a gated submit.
    expect(catchBody ?? '', 'the catch returns before the branch below').not.toMatch(/\breturn\b/);
    expect(NO_WIDGET_BRANCH, 'no branch for a render that produced no widget').toBeDefined();
    expect(NO_WIDGET_BRANCH).toContain("captchaFailReason = 'fallback-error';");
    expect(NO_WIDGET_BRANCH).toContain('concludeUnavailable();');
    expect(NO_WIDGET_BRANCH).toContain('return;');
    // …and the mirror must be set only past that branch, or it claims a widget that does not exist.
    expect(RENDER_BODY.indexOf('managedWidgetShown = true')).toBeGreaterThan(
      RENDER_BODY.indexOf("if (typeof id !== 'string')")
    );
  });

  it('surfaces the note proactively, not only after a wasted submit', () => {
    // Gating it on `form` would mean the user learns only after spending a rate-limit slot.
    const condition = pageSource.match(/\{#if captchaBlocked[^}]*\}/)?.[0] ?? '';
    expect(condition).toBe('{#if captchaBlocked}');
    // …and it is read before the click. Anchor on the email submit's own markup: the logout form has a
    // `<button type="submit">` too. The region's own placement relative to the form is pinned by the
    // test above, from a different anchor; this one only has to put the NOTE ahead of the button.
    const noteStart = markup.indexOf('{#if captchaBlocked}');
    const submitStart = markup.indexOf('disabled={submitting || captchaPending}');
    expect(noteStart, 'the blocked note is not in the markup').toBeGreaterThan(-1);
    expect(submitStart, 'the email submit button was not found').toBeGreaterThan(-1);
    expect(noteStart, 'the blocked note is not above the submit button it explains').toBeLessThan(
      submitStart
    );
  });

  it('replaces the generic "try again" message on BOTH unusable paths, and keeps it otherwise', () => {
    // A rejected-but-working token (expired / reused) is genuinely retryable and must keep the generic
    // copy. The two states where a retry CANNOT work are different in cause and identical in that
    // respect, so the suppression reads the union rather than one of them: gating on captchaBlocked
    // alone leaves the misconfigured state inviting a doomed retry, five of which spend the
    // rate-limit budget and turn into "Too many attempts".
    expect(pageSource).toMatch(/\{#if form\?\.captcha && !emailUnusable\}/);
    expect(pageSource).toContain('Captcha verification failed. Please try again.');
    const union = normalize(
      pageSource.match(/const emailUnusable = \$derived\([\s\S]*?\);/)?.[0] ?? ''
    );
    expect(union).toBe('const emailUnusable = $derived(captchaBlocked || captchaMisconfigured);');
  });

  it('tells a user whose page was never given a check, without blaming their browser', () => {
    // captchaBlocked cannot be reached where nothing was offered — the deadline that would set the
    // verdict is not armed there — so that configuration had NO copy at all and fell through to the
    // generic retry. It is a real state: enforcement is keyed on the invisible SECRET and the widget on
    // the invisible SITEKEY, two separate values, so setting one without the other reaches it.
    const decl = normalize(
      pageSource.match(/const captchaMisconfigured = \$derived\([\s\S]*?\);/)?.[0] ?? ''
    );
    expect(decl).toBe(
      'const captchaMisconfigured = $derived(data.turnstileEnforced && !captchaConfigured);'
    );
    // It must never gate the submit: the server is the sole gate, exactly as on the blocked path.
    expect(
      pageSource.match(/disabled=\{([^}]*)\}/g)?.join(' '),
      'the misconfigured state reached the submit gate'
    ).not.toContain('captchaMisconfigured');
    // The copy, pinned whole. It names NO cause — the page cannot honestly attribute a key it was
    // never given — and offers the one route that still works. The browser-blame vocabulary of the
    // sibling note is banned outright: reaching for it here is the regression this replaced.
    const note = normalize(
      pageSource.match(
        /\{:else if captchaMisconfigured\}[\s\S]*?<p class="captcha-fallback-note">([\s\S]*?)<\/p>/
      )?.[1] ?? ''
    );
    expect(note, 'no note for the misconfigured state').not.toBe('');
    expect(note).toBe(
      "{#if form?.captcha}That didn't go through.{/if} Email login isn't available right now. " +
        '{#if data.providers.length > 0}Sign in with one of the buttons above instead.{/if}'
    );
    expect(note.toLowerCase()).not.toContain('try again');
    for (const blame of ['browser', 'extension', 'vpn', 'filter', 'reload']) {
      expect(
        note.toLowerCase(),
        `the misconfigured note blames the reader ("${blame}")`
      ).not.toContain(blame);
    }
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
      'const captchaPending = $derived( data.turnstileEnforced && captchaConfigured && !captchaToken && !captchaUnavailable );'
    );
    // The two config terms are what make this gate honest, and each can only RELEASE the button:
    //  - turnstileEnforced, or a deployment with a sitekey and no secret makes every user wait on a
    //    check the action passes through, and then asks them to solve the interactive fallback for it;
    //  - captchaOffered, or a managed-only deployment leaves the button live while its only widget is
    //    still a deadline away, refusing that submit for a token the page never asked for.
    // Both read only `data`, so neither can become true because captcha FAILED — the one property this
    // expression must keep.
    const offered = normalize(
      pageSource.match(/const captchaConfigured = \$derived\([\s\S]*?\);/)?.[0] ?? ''
    );
    // …and the predicate is expressed ONCE. The `<svelte:head>` gate on api.js asks the same question,
    // and it is the physical precondition for everything captchaConfigured claims — a hand-spelled copy
    // there can answer the old question after this declaration is changed, and nothing would say so.
    expect(
      markup.match(/<svelte:head>[\s\S]*?\{#if ([^}]*)\}/)?.[1],
      'the api.js gate hand-spells the predicate instead of reading captchaConfigured'
    ).toBe('captchaConfigured');
    expect(
      markup.match(/data\.turnstileSiteKey \|\| !?!?data\.turnstileManagedSiteKey/g) ?? [],
      'the two-sitekey disjunction is written in more than one place'
    ).toHaveLength(1);
    expect(offered).toBe(
      'const captchaConfigured = $derived(!!data.turnstileSiteKey || !!data.turnstileManagedSiteKey);'
    );
  });
});
