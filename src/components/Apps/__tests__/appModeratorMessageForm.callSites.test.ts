import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import {
  MOD_MESSAGE_BODY_MAX,
  MOD_MESSAGE_BODY_MIN,
  MOD_MESSAGE_SUBJECT_MAX,
  MOD_MESSAGE_SUBJECT_MIN,
} from '~/server/schema/blocks/app-moderator-message.schema';

/**
 * 🔒 THE CALL-SITE LEDGER for the moderator → app-developer message surface.
 *
 * WHY THIS FILE EXISTS. `appListings.messageAppOwner` shipped complete — service,
 * audit event, rate limits, notification type, migration — and then sat in production
 * with ZERO UI callers, because nothing anywhere asserted that a caller existed. A
 * ledger is the cheap, mechanical version of the review that did not happen: it fails
 * when the set of mounting sites SHRINKS (the surface goes dark again) and when it
 * GROWS (a second surface appears that nobody wired to the same rules).
 *
 * It also pins the BOUNDS SINGLE-SOURCE. The composer's floors and ceilings belong to
 * `messageAppOwnerSchema`; a hand-typed copy in the component drifts silently and then
 * either offers a moderator a field they can fill and can never send, or blocks a
 * message the server would have accepted.
 *
 * 🔴 A STRUCTURAL CHECK IS NOT A BEHAVIOURAL ONE. That the modal is mounted says
 * nothing about whether the gate works — that is
 * `__tests__/appModeratorMessageForm.test.ts` (blocking) and
 * `MessageAppOwnerModal.browser.test.tsx` (report-only in CI).
 *
 * 🔴 KNOWN LIMITS, stated rather than implied. Detection is syntactic and per-file: a
 * site that mounts the modal through a wrapper or `React.createElement` is invisible
 * here. Every source assertion reads through {@link codeOf}, which strips comments with
 * a regex, so a `//` sequence inside a string literal in one of the three scanned files
 * would confuse it — none contains one today (checked), and the positive control below
 * proves the detector can still fire when it matters. The MOUNT sweep deliberately reads
 * RAW: a comment quoting `<MessageAppOwnerModal` there produces a loud ledger mismatch,
 * whereas a bad strip would silently hide a real second mount, and loud is the direction
 * to fail in for a sweep whose whole job is to notice a new site. That sweep also matches
 * a PREFIX, so a sibling named `MessageAppOwnerModalCompact` counts as a mount of this
 * one — again the loud direction (an unexpected ledger entry), and again not a silent
 * miss. Renaming BOTH the component and its file to a longer name is the one case it
 * would not notice, and the `MODAL_MODULE` reads below throw ENOENT on that.
 *
 * 🔴 The reset ledger further down is scoped to `useState` DECLARATIONS in the composer
 * module. State introduced some other way — `useReducer`, a custom hook, a ref — is
 * invisible to it, so its claim is "every `useState` piece", not "every piece of state
 * that exists". It is also module-scoped rather than component-scoped: a second component
 * added to this file would have ITS setters demanded inside `reset()` too. That direction
 * fails loudly and is the safe one; the `useState`-only direction is the gap, and widening
 * the composer's state to a reducer means widening this with it.
 *
 * 🔴 And the reset ledger reads `reset()`'s OWN body only. A `reset()` that delegates —
 * `function reset() { clearComposer(); }` — satisfies nothing it should: every setter
 * would read as uncalled and the ledger would fail LOUDLY, which is safe but is a false
 * alarm rather than a finding. Inlining the clears, or teaching {@link resetOffences} to
 * follow one call, are the two fixes; do not "fix" it by dropping the assertion.
 */

const SRC = path.resolve(__dirname, '../../..');

const FORM_MODULE = 'components/Apps/appModeratorMessageForm.ts';
const MODAL_MODULE = 'components/Apps/MessageAppOwnerModal.tsx';
/**
 * The shared field the composer renders its body through. Enrolled here because it is
 * read by NO blocking test otherwise — measured, and the reason `reasonGatedFieldCopy`
 * was extracted in the first place. That extraction moved the STRINGS somewhere a
 * blocking suite can see them; it left the WIRING (which copy function feeds which prop,
 * and whether the length handed to them is trimmed) exactly as unobservable as before.
 */
const FIELD_MODULE = 'components/Apps/ReasonGatedActionModal.tsx';

/**
 * Every PRODUCTION site that mounts `MessageAppOwnerModal`. One today: the /apps/review
 * "Manage listings" table, which is the only moderator surface that holds an
 * `AppListing` id for an arbitrary listing in any status. Adding a second surface means
 * adding it here — that is the point, not an inconvenience.
 */
const MOUNT_SITES = ['components/Apps/AppListingsModerationTable.tsx'] as const;

const SCHEMA_IMPORT = '~/server/schema/blocks/app-moderator-message.schema';

function read(rel: string): string {
  return fs.readFileSync(path.join(SRC, rel), 'utf8');
}

/** Strip `/* *\/` and `//` comments so prose that MENTIONS a bound is not a hit. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * 🔴 THE ONLY READER ANY ASSERTION BELOW SHOULD USE — comment-stripped source.
 *
 * Every check here is a claim about CODE, and prose is not code. A raw read gets the
 * polarity wrong in BOTH directions: a `toContain` is satisfied by a comment that merely
 * quotes the call it demands (so a deleted branch reads as present), and a
 * `not.toContain` is broken by a comment that names the identifier it forbids (so a
 * correct file reads as an offence). Neither is hypothetical in a file whose comments
 * deliberately quote the code around them — this one included. The numeric-bounds scan
 * already stripped; four source assertions did not, and now nothing reads raw.
 */
function codeOf(rel: string): string {
  return stripComments(read(rel));
}

/** Standalone occurrences of `value` as a numeric token (not part of an identifier). */
function bareNumericHits(source: string, value: number): number {
  const re = new RegExp(`(?<![\\w.$])${value}(?![\\w.$])`, 'g');
  return (source.match(re) ?? []).length;
}

/**
 * The text between a balanced pair of `open`/`close`, starting at the first `open` at
 * or after `from`. Comment-stripped source only — a delimiter inside a comment or a
 * string literal would throw the depth off, and every caller below strips first.
 */
function balanced(source: string, from: number, open: string, close: string): string {
  const start = source.indexOf(open, from);
  if (start < 0) throw new Error(`no "${open}" at or after index ${from}`);
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === open) depth++;
    else if (source[i] === close) {
      depth--;
      if (depth === 0) return source.slice(start + 1, i);
    }
  }
  throw new Error(`unbalanced "${open}" from index ${start}`);
}

/**
 * The body of `function <name>(…) { … }` OR of `const <name> = (…) => { … }`. The
 * parameter list is skipped with its own balance pass so a destructured parameter's `{`
 * can't be mistaken for the opening brace of the body.
 *
 * 🔴 BOTH FORMS, because supporting only the `function` keyword made this throw
 * `no function reset` on a pure refactor — an error naming a syntax choice rather than a
 * defect, which is the shape that gets a guard deleted as broken instead of read as a
 * finding. Behaviour is identical either way, so the ledger must not have an opinion.
 * An arrow with a CONCISE body (`const reset = () => setX('')`) is still unsupported and
 * throws by name below; it cannot express the multi-statement reset this pins.
 */
function functionBody(source: string, name: string): string {
  const declaration = new RegExp(
    `(?:function\\s+${name}\\s*\\()|(?:const\\s+${name}\\s*=\\s*(?:async\\s*)?\\()`
  ).exec(source);
  if (!declaration) {
    throw new Error(
      `no \`function ${name}(\` and no \`const ${name} = (\` — if it was refactored to ` +
        `another form, widen functionBody rather than deleting this ledger`
    );
  }
  let depth = 0;
  for (let i = source.indexOf('(', declaration.index); i < source.length; i++) {
    if (source[i] === '(') depth++;
    else if (source[i] === ')') {
      depth--;
      if (depth === 0) {
        const rest = source.slice(i + 1);
        // The arrow form puts `=> ` (and possibly a return type) between `)` and `{`;
        // a concise-body arrow has no `{` of its own and must not silently borrow the
        // next block in the file.
        if (/^\s*(?::[^=]*)?=>/.test(rest) && !/^\s*(?::[^=]*)?=>\s*\{/.test(rest)) {
          throw new Error(`${name} is a concise-body arrow — functionBody needs a block body`);
        }
        return balanced(source, i + 1, '{', '}');
      }
    }
  }
  throw new Error(`unbalanced parameter list in ${name}`);
}

/** The initialiser of a `const <name> = …;` binding, up to the `;` or the line end. */
function constInitialiser(source: string, name: string): string {
  const m = new RegExp(`const\\s+${name}\\s*=\\s*([^;\\n]+)`).exec(source);
  if (!m) throw new Error(`no const ${name}`);
  return normalise(m[1]);
}

/** The single argument of a `<callee>(…)` call. */
function callArgument(source: string, callee: string): string {
  const at = source.indexOf(`${callee}(`);
  if (at < 0) throw new Error(`no call to ${callee}`);
  return balanced(source, at + callee.length, '(', ')');
}

/**
 * The text of one TOP-LEVEL property of an object literal (the `{…}` inner text), from
 * its key through to the `,` that ends it. Depth-aware, so a `,` inside a nested call
 * or object belongs to that nesting and not to this property.
 */
function objectProperty(objectInner: string, key: string): string {
  const start = objectInner.indexOf(`${key}:`);
  if (start < 0) throw new Error(`no property ${key}`);
  let depth = 0;
  for (let i = start; i < objectInner.length; i++) {
    const c = objectInner[i];
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) return objectInner.slice(start, i);
  }
  return objectInner.slice(start);
}

/** Whitespace collapsed to single spaces and trimmed, so formatting is not a difference. */
function normalise(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Every `useState` piece in a module: the setter name → the NORMALISED text of the
 * DECLARED INITIAL VALUE. Comment-stripped source only.
 *
 * The initial value is read with a balance pass from the `(` that follows `useState`
 * rather than by regex, so a type argument of any shape (`useState<Foo<Bar>>('')`) and
 * an initialiser containing its own parens both survive. A `useState` with no call
 * parens at all would make that `(` belong to some later expression, so the text between
 * is asserted to be argument-free first — it throws rather than silently reading the
 * wrong span.
 */
function stateInitialValues(source: string): Map<string, string> {
  const re = /const\s*\[\s*[A-Za-z0-9_$]+\s*,\s*(set[A-Za-z0-9_$]+)\s*\]\s*=\s*useState/g;
  const out = new Map<string, string>();
  for (const m of source.matchAll(re)) {
    const after = m.index + m[0].length;
    const paren = source.indexOf('(', after);
    if (paren < 0) throw new Error(`no useState call parens for ${m[1]}`);
    const between = source.slice(after, paren);
    if (/[;{}=]/.test(between)) throw new Error(`useState for ${m[1]} is not called`);
    out.set(m[1], normalise(balanced(source, paren, '(', ')')));
  }
  return out;
}

/**
 * 🔴 EVERY WAY `reset()` CAN FAIL TO RESET, as human-readable offences.
 *
 * Two of them, and the second is why this replaced a "was the setter CALLED" check:
 * mutating `setIncludeCollaborators(false)` to `setIncludeCollaborators(true)` inside
 * `reset()` left the whole blocking tier green (13/13), because the setter was still
 * called — only the report-only browser tier saw it. A ledger that asserts a call
 * happened cannot see the value it carries, and the value is the entire hazard: a
 * collaborator opt-in that survives a send fans the NEXT moderation message out to third
 * parties who opted into nothing.
 *
 * So the assertion is the RELATIONSHIP `reset() restores the declared initial`, not
 * `reset() mentions the setter`. It fails when a piece of state is added without a
 * reset, when an existing reset is deleted, AND when a reset is rewritten to a value
 * that is not what the component mounts with.
 */
function resetOffences(body: string, initials: Map<string, string>): string[] {
  const offences: string[] = [];
  for (const [setter, initial] of initials) {
    const call = new RegExp(`\\b${setter}\\s*\\(`).exec(body);
    if (!call) {
      offences.push(`${setter}: never called in reset() (declared initial ${initial})`);
      continue;
    }
    const arg = normalise(balanced(body, call.index + call[0].length - 1, '(', ')'));
    if (arg !== initial) {
      offences.push(`${setter}: reset() passes ${arg}, declared initial is ${initial}`);
    }
  }
  return offences;
}

/**
 * The literal text between `open` and the next `close`, for a JSX element whose children
 * are prose. It refuses a span containing a `<`, so a nested element makes this throw by
 * name rather than return a half-string that a whole-sentence assertion would then
 * compare against and fail confusingly.
 */
function elementText(source: string, open: string, close: string): string {
  const start = source.indexOf(open);
  if (start < 0) throw new Error(`no ${open}`);
  const end = source.indexOf(close, start + open.length);
  if (end < 0) throw new Error(`no ${close} after ${open}`);
  const text = source.slice(start + open.length, end);
  if (text.includes('<')) throw new Error(`${open} has nested elements — widen elementText`);
  return text;
}

/** A self-closing JSX element's full text, `<Name` through the matching `/>`. */
function selfClosingElement(source: string, name: string): string {
  const at = source.indexOf(`<${name}`);
  if (at < 0) throw new Error(`no <${name}`);
  const end = source.indexOf('/>', at);
  if (end < 0) throw new Error(`<${name} is not self-closing`);
  return source.slice(at, end + 2);
}

/**
 * Every production `.ts`/`.tsx` under `src/components` and `src/pages`, test files
 * excluded. Both trees are walked because a moderator surface can be a page as easily
 * as a component, and a mount added to a page would otherwise be invisible to the
 * ledger.
 */
function productionSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      if (/\.(test|browser\.test|spec)\.tsx?$/.test(entry.name)) continue;
      out.push(path.relative(SRC, full));
    }
  };
  walk(path.join(SRC, 'components'));
  walk(path.join(SRC, 'pages'));
  return out;
}

describe('the owner-message surface is MOUNTED (it shipped dark once already)', () => {
  it('the exact ledger of sites that mount MessageAppOwnerModal', () => {
    const mounting = productionSources().filter((rel) =>
      read(rel).includes('<MessageAppOwnerModal')
    );
    // Positive control: the scan really does see mounts, so an equal-to-ledger result
    // is a match and not an empty sweep.
    expect(mounting.length).toBeGreaterThan(0);
    expect(mounting.sort()).toEqual([...MOUNT_SITES].sort());
  });

  it('the mounting site routes the action through actionOpensOwnerMessage, not the reason modal', () => {
    const table = codeOf(MOUNT_SITES[0]);
    // The router must be CALLED, not merely imported — an import with no call site is
    // exactly how the message action would silently fall through to
    // `setPendingAction` and open the wrong modal.
    expect(table).toContain('actionOpensOwnerMessage(action)');
    expect(table).toContain('setMessageRow(row)');
  });

  it('the mounting site BRANCHES on actionRequiresReason for the reason-gated actions', () => {
    // The third route out of `openAction`. Until this assertion existed the predicate
    // was referenced by nothing but its own test while carrying 🔴 comments claiming it
    // gated routing — measured by reverting it to `action !== 'review'`, which left all
    // 48 component tests green. A ledger over MOUNTS has to cover the ROUTERS too, or
    // the surface stays mounted and reachable by the wrong modal.
    const table = codeOf(MOUNT_SITES[0]);
    expect(table).toContain('actionRequiresReason(action)');
    expect(table).toContain('setPendingAction({ action, row })');
  });

  it('the modal is fed the listing ID, never the slug', () => {
    // `messageAppOwner` keys on `apl_<ULID>`; a slug would come back NOT_FOUND. The
    // row carries both and they are adjacent in the object literal, so this is a
    // realistic transposition rather than a hypothetical one.
    const table = codeOf(MOUNT_SITES[0]);
    expect(table).toMatch(/appListingId:\s*messageRow\.id/);
  });
});

describe('the composer bounds are single-sourced from the server schema', () => {
  it('both modules import the bounds from messageAppOwnerSchema', () => {
    for (const rel of [FORM_MODULE, MODAL_MODULE]) {
      expect(read(rel)).toContain(SCHEMA_IMPORT);
    }
  });

  it('neither module hardcodes a bound as a numeric literal', () => {
    const bounds = {
      MOD_MESSAGE_SUBJECT_MIN,
      MOD_MESSAGE_SUBJECT_MAX,
      MOD_MESSAGE_BODY_MIN,
      MOD_MESSAGE_BODY_MAX,
    };
    const offences: string[] = [];
    for (const rel of [FORM_MODULE, MODAL_MODULE]) {
      const code = codeOf(rel);
      for (const [name, value] of Object.entries(bounds)) {
        const hits = bareNumericHits(code, value);
        if (hits > 0) offences.push(`${rel}: ${hits}× bare ${value} (use ${name})`);
      }
    }
    expect(offences).toEqual([]);
  });

  /**
   * 🔴 POSITIVE CONTROL on the detector above. A "no offences" result is
   * indistinguishable from a scan wired to nothing until the same detector has been
   * watched to FIRE — here on a synthetic source that hardcodes the body ceiling, and
   * NOT on the same source once it is written as a comment (which is the false positive
   * the comment-stripping exists to avoid).
   */
  it('the hardcoded-bound detector fires on a planted literal and not on prose', () => {
    const planted = `const max = ${MOD_MESSAGE_BODY_MAX};`;
    expect(bareNumericHits(stripComments(planted), MOD_MESSAGE_BODY_MAX)).toBe(1);

    const prose = `// the ceiling is ${MOD_MESSAGE_BODY_MAX} characters\nconst max = MOD_MESSAGE_BODY_MAX;`;
    expect(bareNumericHits(stripComments(prose), MOD_MESSAGE_BODY_MAX)).toBe(0);

    // And it must not fire on a number that merely CONTAINS the bound's digits.
    const embedded = `const other = ${MOD_MESSAGE_BODY_MAX}0;`;
    expect(bareNumericHits(stripComments(embedded), MOD_MESSAGE_BODY_MAX)).toBe(0);
  });

  /**
   * Importing the right constants is not the same as WIRING them to the right field.
   * Cross-wiring the body's ceiling to `MOD_MESSAGE_SUBJECT_MAX` passes every check
   * above (both names are imported, no bare literal appears) and every blocking suite —
   * it was pinned only in the report-only browser tier.
   */
  it('each field is wired to ITS OWN bounds — the body to the body pair, the subject to the subject pair', () => {
    const code = codeOf(MODAL_MODULE);

    const body = selfClosingElement(code, 'ReasonGatedField');
    // Positive control on the extractor: it grabbed the body field and not some other
    // self-closing element.
    expect(body).toContain('testId="apps-mod-message-body"');
    expect(body).toContain('minLength={MOD_MESSAGE_BODY_MIN}');
    expect(body).toContain('maxLength={MOD_MESSAGE_BODY_MAX}');
    expect(body).not.toContain('MOD_MESSAGE_SUBJECT_');

    const subject = selfClosingElement(code, 'TextInput');
    expect(subject).toContain('data-testid="apps-mod-message-subject"');
    expect(subject).toContain('MOD_MESSAGE_SUBJECT_MIN');
    expect(subject).toContain('MOD_MESSAGE_SUBJECT_MAX');
    expect(subject).not.toContain('MOD_MESSAGE_BODY_');
  });
});

/**
 * 🔴 THE SEAM THE EXTRACTION CREATED, WHICH NEITHER TIER WAS WATCHING.
 *
 * `reasonGatedFieldCopy` was split out of `ReasonGatedField` so the counter and the
 * inline error would be pinned by something that can block a merge. That closed half the
 * hole: the strings are now pure functions with their own blocking suite, but the JSX
 * that CALLS them is in a file no blocking test reads. Measured on the extracted code —
 * both of these survived 1318 blocking + 1113 browser tests:
 *
 *   - swapping `description={reasonGatedFieldDescription(copy)}` with
 *     `error={reasonGatedFieldError(copy)}`, which renders the "too long" message as the
 *     neutral counter and the counter as a red error;
 *   - `length: len` → `length: value.length`, which silently drops the trimming the
 *     server's own validation assumes, so a body of spaces opens the gate and comes
 *     straight back rejected.
 *
 * Two hermetically-tested halves, a defect that lives only between them. These pin the
 * RELATIONSHIP: which function feeds which prop, and that the length both receive is the
 * trimmed one no matter which identifier it arrives under.
 */
describe('the shared field is wired to the copy module it was extracted into', () => {
  it('each prop is fed by ITS OWN copy function', () => {
    const code = codeOf(FIELD_MODULE);
    const textarea = selfClosingElement(code, 'Textarea');
    // Positive control on the extractor: it grabbed the reason textarea and not some
    // other self-closing element in the file.
    expect(textarea).toContain('data-testid={testId}');
    expect(textarea).toContain('description={reasonGatedFieldDescription(copy)}');
    expect(textarea).toContain('error={reasonGatedFieldError(copy)}');
  });

  it('the copy input is built from the TRIMMED length, through however many aliases', () => {
    const code = codeOf(FIELD_MODULE);
    const at = code.indexOf('const copy = {');
    expect(at).toBeGreaterThan(-1);
    const copyLiteral = balanced(code, at, '{', '}');
    const written = normalise(objectProperty(copyLiteral, 'length').replace(/^length:\s*/, ''));
    // Written as a bare identifier? Resolve it to what that identifier is assigned, so
    // the trim can't be dropped one level up where this assertion could not see it.
    const resolved = /^[A-Za-z0-9_$]+$/.test(written) ? constInitialiser(code, written) : written;
    expect(resolved).toBe('value.trim().length');
  });
});

/**
 * 🔴 THE COMPOSER MUST NAME NO RECIPIENT.
 *
 * `messageAppOwner` resolves the owner server-side, and for an ON-SITE listing
 * `resolveCanonicalListingOwner` resolves the backing block's owner rather than the
 * listing's `userId` column. The mod table holds only that column. A composer that
 * displayed it would let a moderator write copy aimed at the person on screen while the
 * platform delivered it to a different one — a disclosure, not a mislabel.
 *
 * This is pinned as a PROP-SHAPE LEDGER rather than a search for one word, because the
 * defect it replaces was not a missing warning: an earlier revision carried a `🔴 Never
 * present it as the delivery target` docstring on the very value it then rendered.
 * Prose does not gate anything; the accepted key set does.
 */
describe('the composer takes no owner from its caller', () => {
  it('the exact key set of the listing prop', () => {
    const code = codeOf(MODAL_MODULE);
    const at = code.indexOf('listing: {');
    expect(at).toBeGreaterThan(-1);
    const shape = balanced(code, at, '{', '}');
    const keys = [...shape.matchAll(/([A-Za-z0-9_$]+)\??\s*:/g)].map((m) => m[1]);
    expect(keys).toEqual(['appListingId', 'slug']);
  });

  it('neither the composer nor its mount site carries a display owner', () => {
    for (const rel of [MODAL_MODULE, MOUNT_SITES[0]]) {
      expect(codeOf(rel)).not.toContain('ownerLabel');
    }
    // Positive control: the mount site DOES still build the props it is supposed to.
    expect(codeOf(MOUNT_SITES[0])).toMatch(/appListingId:\s*messageRow\.id/);
  });

  /**
   * 🔴 THE NOTICE, PINNED WHOLE — because a guard on WORDS is walkable by REWORDING.
   *
   * The browser tier asked only that no `@handle`/`#id` appear. That is a SPELLED guard:
   * rewriting the notice as "…to the app owner devuser, resolved when you send" names a
   * recipient in plain prose, matches no `[@#]\w`, and passed all 17 browser tests. The
   * prop-shape ledger above already stops a CALLER handing the composer an owner, so the
   * residual hazard is this file naming one itself — which is a change to this exact
   * string and nothing else.
   *
   * So the whole normalised sentence is the assertion, and it lives in the BLOCKING tier
   * rather than only in the report-only browser one. A deliberate reword fails this and
   * is meant to: the copy is a claim about where a moderation message goes, and updating
   * a machine-readable pin is the cheap half of changing it.
   */
  it('the delivery notice is exactly this sentence', () => {
    expect(normalise(elementText(codeOf(MODAL_MODULE), '<Text size="sm">', '</Text>'))).toBe(
      'Delivered as a notification to the app&apos;s owner, resolved when you send. One-way — ' +
        'replies are not delivered — and the subject and message are recorded in this ' +
        'listing&apos;s moderation history.'
    );
  });
});

/**
 * 🔴 TWO STATE-LIFECYCLE PROPERTIES THE PR MARKS 🔴 AND THE BLOCKING TIER DID NOT SEE.
 * Both survived the unit suite untouched before this block existed, so both were
 * claims in a comment rather than pinned behaviour.
 */
describe('the composer resets per message and never on failure', () => {
  it('reset() restores every useState piece to its DECLARED initial value, the collaborator opt-in included', () => {
    const code = codeOf(MODAL_MODULE);
    const initials = stateInitialValues(code);
    // Positive control on the detector: the composer really does declare state, the
    // opt-in is one of the pieces this is asserting about, and it mounts OFF — so the
    // comparison below has a real, non-empty right-hand side to be wrong about.
    expect(initials.size).toBeGreaterThan(0);
    expect(initials.get('setIncludeCollaborators')).toBe('false');
    expect(resetOffences(functionBody(code, 'reset'), initials)).toEqual([]);
  });

  it('the reset detector fires on a forgotten setter AND on one reset to the wrong value', () => {
    const declarations = [
      "const [subject, setSubject] = useState('');",
      'const [includeCollaborators, setIncludeCollaborators] = useState(false);',
    ];
    const forgot = [...declarations, 'function reset() {', "  setSubject('');", '}'].join('\n');
    const forgotInitials = stateInitialValues(forgot);
    expect([...forgotInitials.entries()]).toEqual([
      ['setSubject', "''"],
      ['setIncludeCollaborators', 'false'],
    ]);
    expect(resetOffences(functionBody(forgot, 'reset'), forgotInitials)).toEqual([
      'setIncludeCollaborators: never called in reset() (declared initial false)',
    ]);

    // 🔴 THE MUTANT THE OLD "was it called" LEDGER LET THROUGH. The setter is called, so
    // a call-presence check is satisfied; the value it carries is the opposite of what
    // the composer mounts with.
    const wrongValue = [
      ...declarations,
      'function reset() {',
      "  setSubject('');",
      '  setIncludeCollaborators(true);',
      '}',
    ].join('\n');
    const wrongInitials = stateInitialValues(wrongValue);
    expect(resetOffences(functionBody(wrongValue, 'reset'), wrongInitials)).toEqual([
      'setIncludeCollaborators: reset() passes true, declared initial is false',
    ]);

    // And a correct composer produces no offence at all — so the detector is not simply
    // always-red, which would make the real assertion above meaningless.
    const correct = [
      ...declarations,
      'function reset() {',
      "  setSubject('');",
      '  setIncludeCollaborators(false);',
      '}',
    ].join('\n');
    expect(resetOffences(functionBody(correct, 'reset'), stateInitialValues(correct))).toEqual([]);
  });

  it('a failed send does not reset — the mutation onError never calls reset()', () => {
    const options = callArgument(codeOf(MODAL_MODULE), 'useMutation');
    // Positive control on the property extractor: the SUCCESS handler does reset, so a
    // clean `onError` is a real read of real code and not an empty match.
    expect(objectProperty(options, 'onSuccess')).toContain('reset()');
    expect(objectProperty(options, 'onError')).not.toContain('reset(');
  });
});
