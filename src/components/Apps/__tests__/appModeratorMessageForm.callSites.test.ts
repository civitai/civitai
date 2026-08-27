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
 * here. The numeric-literal scan strips comments with a regex, so a `//` sequence
 * inside a string literal in one of the scanned files would confuse it — neither
 * scanned file contains one today, and the positive control below proves the detector
 * can still fire when it matters.
 *
 * 🔴 The reset-completeness ledger further down is scoped to `useState` DECLARATIONS in
 * the composer module. State introduced some other way — `useReducer`, a custom hook, a
 * ref — is invisible to it, so its claim is "every `useState` piece", not "every piece
 * of state that exists". It is also module-scoped rather than component-scoped: a second
 * component added to this file would have ITS setters demanded inside `reset()` too.
 * That direction fails loudly and is the safe one; the `useState`-only direction is the
 * gap, and widening the composer's state to a reducer means widening this with it.
 */

const SRC = path.resolve(__dirname, '../../..');

const FORM_MODULE = 'components/Apps/appModeratorMessageForm.ts';
const MODAL_MODULE = 'components/Apps/MessageAppOwnerModal.tsx';

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
 * The body of a `function <name>(…) { … }` declaration. The parameter list is skipped
 * with its own balance pass so a destructured parameter's `{` can't be mistaken for the
 * opening brace of the body.
 */
function functionBody(source: string, name: string): string {
  const at = source.indexOf(`function ${name}(`);
  if (at < 0) throw new Error(`no function ${name}`);
  let depth = 0;
  for (let i = source.indexOf('(', at); i < source.length; i++) {
    if (source[i] === '(') depth++;
    else if (source[i] === ')') {
      depth--;
      if (depth === 0) return balanced(source, i + 1, '{', '}');
    }
  }
  throw new Error(`unbalanced parameter list in ${name}`);
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

/** Every `set…` returned by a `const [x, setX] = useState(…)` in a module. */
function stateSetters(source: string): string[] {
  const re = /const\s*\[\s*[A-Za-z0-9_$]+\s*,\s*(set[A-Za-z0-9_$]+)\s*\]\s*=\s*useState/g;
  return [...source.matchAll(re)].map((m) => m[1]);
}

/** Which of `setters` are NOT called anywhere in `body`. */
function settersNotCalledIn(body: string, setters: string[]): string[] {
  return setters.filter((s) => !new RegExp(`\\b${s}\\s*\\(`).test(body));
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
    const table = read(MOUNT_SITES[0]);
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
    const table = read(MOUNT_SITES[0]);
    expect(table).toContain('actionRequiresReason(action)');
    expect(table).toContain('setPendingAction({ action, row })');
  });

  it('the modal is fed the listing ID, never the slug', () => {
    // `messageAppOwner` keys on `apl_<ULID>`; a slug would come back NOT_FOUND. The
    // row carries both and they are adjacent in the object literal, so this is a
    // realistic transposition rather than a hypothetical one.
    const table = read(MOUNT_SITES[0]);
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
      const code = stripComments(read(rel));
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
    const code = stripComments(read(MODAL_MODULE));

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
    const code = stripComments(read(MODAL_MODULE));
    const at = code.indexOf('listing: {');
    expect(at).toBeGreaterThan(-1);
    const shape = balanced(code, at, '{', '}');
    const keys = [...shape.matchAll(/([A-Za-z0-9_$]+)\??\s*:/g)].map((m) => m[1]);
    expect(keys).toEqual(['appListingId', 'slug']);
  });

  it('neither the composer nor its mount site carries a display owner', () => {
    for (const rel of [MODAL_MODULE, MOUNT_SITES[0]]) {
      expect(read(rel)).not.toContain('ownerLabel');
    }
    // Positive control: the mount site DOES still build the props it is supposed to.
    expect(read(MOUNT_SITES[0])).toMatch(/appListingId:\s*messageRow\.id/);
  });
});

/**
 * 🔴 TWO STATE-LIFECYCLE PROPERTIES THE PR MARKS 🔴 AND THE BLOCKING TIER DID NOT SEE.
 * Both survived the unit suite untouched before this block existed, so both were
 * claims in a comment rather than pinned behaviour.
 */
describe('the composer resets per message and never on failure', () => {
  it('reset() clears every useState piece the composer declares, the collaborator opt-in included', () => {
    const code = stripComments(read(MODAL_MODULE));
    const setters = stateSetters(code);
    // Positive control on the detector: the composer really does declare state, and the
    // opt-in is one of the pieces this is asserting about.
    expect(setters.length).toBeGreaterThan(0);
    expect(setters).toContain('setIncludeCollaborators');
    // The RELATIONSHIP, not a fixed list: the ledger fails when state is ADDED without a
    // matching reset just as it does when an existing reset is dropped.
    expect(settersNotCalledIn(functionBody(code, 'reset'), setters)).toEqual([]);
  });

  it('the reset-completeness detector fires on a composer that forgets one setter', () => {
    const planted = [
      "const [subject, setSubject] = useState('');",
      'const [includeCollaborators, setIncludeCollaborators] = useState(false);',
      'function reset() {',
      "  setSubject('');",
      '}',
    ].join('\n');
    const setters = stateSetters(planted);
    expect(setters).toEqual(['setSubject', 'setIncludeCollaborators']);
    expect(settersNotCalledIn(functionBody(planted, 'reset'), setters)).toEqual([
      'setIncludeCollaborators',
    ]);
  });

  it('a failed send does not reset — the mutation onError never calls reset()', () => {
    const options = callArgument(stripComments(read(MODAL_MODULE)), 'useMutation');
    // Positive control on the property extractor: the SUCCESS handler does reset, so a
    // clean `onError` is a real read of real code and not an empty match.
    expect(objectProperty(options, 'onSuccess')).toContain('reset()');
    expect(objectProperty(options, 'onError')).not.toContain('reset(');
  });
});
