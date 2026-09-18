import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { describe, expect, test } from 'vitest';
import { BRIDGE_NACK_EXEMPT } from '~/components/AppBlocks/bridgeTelemetry';

/**
 * NO HOST MESSAGE HANDLER MAY DROP A CREDENTIAL-LESS REQUEST WITHOUT ANSWERING IT.
 *
 * 🔴 WHY A STRUCTURAL GUARD AND NOT ONLY THE BEHAVIOURAL TESTS. The behavioural
 * suites (`PageBlockHostNoTokenNack.browser.test.tsx`) pin the handlers that exist
 * TODAY. The realistic regression is the THIRTY-SECOND handler, written by copying
 * the thirty-first's opening lines, whose reviewer has no reason to know that
 * `if (!token) return;` is the one shape that must not appear in a message handler
 * — and whose defect is INVISIBLE by construction: nothing errors, nothing logs,
 * the block simply hangs to its SDK timeout class (30s default, 120s workflow,
 * 600s human-in-the-loop). A per-handler test cannot cover a handler nobody has
 * written yet.
 *
 * 🔴 THE POPULATION IS EVERY `if` GUARD WHOSE CONDITION TESTS `!token`, AND THE
 * ASSERTION IS ABOUT ITS OWN CONSEQUENT. Two earlier revisions of this file got
 * that wrong in ways that each read as coverage:
 *
 *   - testing for a response ANYWHERE IN THE ENCLOSING HANDLER, which every
 *     handler's SUCCESS path satisfies with its own `send('<X>_RESULT', …)`;
 *   - stripping comments with a REGEX, which ate `cleaned.includes('//')` — real
 *     code inside a string literal — deleting two `)` and a `{` and leaving one
 *     `onMessage(` unmatched. The resulting "handler range" ran 71,358 chars to
 *     EOF, i.e. the paren-bounding this file advertises was inoperative over 76%
 *     of `PageBlockHost.tsx`, and a legitimate lifecycle guard added below that
 *     point failed with a message about dropped requests.
 *
 * So the source is first passed through a real STATE-MACHINE scan
 * (`blankNonCode`) that replaces the contents of comments, strings and template
 * literals with spaces while preserving every byte offset. Every paren/brace walk
 * below runs on that, so nothing inside a comment or a string can move a bracket.
 * `the source scan is not corrupting the file` is the self-check that keeps it
 * honest — it is the assertion the regex version would have failed.
 *
 * Guards OUTSIDE any `onMessage` handler are excluded: the hosts legitimately test
 * `!token` in lifecycle effects (init gating, status escalation), where there is no
 * request to answer.
 *
 * 🔴 WHAT IT DOES NOT CLAIM, STATED WIDER THAN IS COMFORTABLE.
 *   - It checks that a RESPONSE CALL is present in the consequent, not that the
 *     response is correct, correlated, or accepted by the SDK's inbound validator.
 *     Those are behavioural claims and they live in the browser suites.
 *   - The population is the literal spelling `!token`. These equally-silent
 *     spellings are NOT in it: `if (token) { …respond… }` with no `else`,
 *     `const t = token; if (!t) return;`, `if (token == null)`, `if (!props.token)`.
 *     A handler written any of those ways passes this file while dropping requests.
 *     Widening the regex without widening the population walk would be worse than
 *     the gap, so it is named here rather than half-closed.
 */

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const HOSTS = ['PageBlockHost.tsx', 'IframeHost.tsx'] as const;

/**
 * Replace the CONTENTS of comments, strings and template literals with spaces,
 * preserving length and newlines so every offset still maps to the real file.
 *
 * 🔴 A REGEX CANNOT DO THIS, and the attempt is what broke the previous revision:
 * `/(^|[^:])\/\/.*$/gm` treats the `//` inside `cleaned.includes('//')` as the
 * start of a comment and deletes the rest of the line — real code. A state machine
 * only enters a comment from CODE state, so a `//` inside a string is just two
 * characters.
 *
 * Regex literals are deliberately NOT tracked (telling a regex from a division
 * needs real parsing). A regex containing an unmatched quote would therefore
 * confuse the scan — which is exactly what the self-check below is for: it fails
 * loudly instead of silently mis-bounding a handler.
 */
export function blankNonCode(src: string): string {
  const out = src.split('');
  let i = 0;
  const blank = (at: number) => {
    if (out[at] !== '\n') out[at] = ' ';
  };
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') blank(i++);
      continue;
    }
    if (c === '/' && n === '*') {
      blank(i++);
      blank(i++);
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) blank(i++);
      blank(i++);
      blank(i++);
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      i++; // keep the opening quote so the token is still visible as a string
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\') blank(i++);
        if (i < src.length) blank(i++);
      }
      i++; // keep the closing quote
      continue;
    }
    i++;
  }
  return out.join('');
}

function hostFile(file: string): string {
  return readFileSync(join(REPO_ROOT, 'src', 'components', 'AppBlocks', file), 'utf8');
}

/** A call that puts something on the wire for the block, rather than swallowing the request. */
const RESPONDS = /\bnack\s*\(|\bsend\s*\(|\.reply\s*\(/;

/** Index just past the `)` / `}` that closes the bracket at `open`. */
function matchBracket(code: string, open: number, o: '(' | '{', c: ')' | '}'): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === o) depth++;
    else if (code[i] === c) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return code.length;
}

type Handler = { start: number; end: number; type: string; inlineFn: boolean };

/**
 * Every `onMessage(...)` registration, bounded by its OWN parentheses.
 *
 * The generic argument (`onMessage<{ requestId?: unknown }>(`) is skipped by angle
 * depth — with `=>` excluded, because a function type inside the generic would
 * otherwise drive the counter negative and make the call's `(` unfindable, which
 * silently drops the whole handler out of the population.
 */
function handlers(src: string): Handler[] {
  const code = blankNonCode(src);
  const out: Handler[] = [];
  for (const m of code.matchAll(/\bonMessage\s*[<(]/g)) {
    let i = (m.index as number) + 'onMessage'.length;
    let angle = 0;
    while (i < code.length) {
      const ch = code[i];
      if (ch === '<') angle++;
      else if (ch === '>' && code[i - 1] !== '=') angle--;
      else if (ch === '(' && angle <= 0) break;
      i++;
    }
    if (i >= code.length) continue;
    const end = matchBracket(code, i, '(', ')');
    // The registered type is the first quoted UPPER_SNAKE literal in the call —
    // read from the ORIGINAL source, since the scan blanked string contents.
    const typeMatch = /'([A-Z][A-Z_0-9]*)'/.exec(src.slice(i, end));
    // Is the handler an inline function, or a reference to one declared elsewhere?
    // A reference is invisible to this file's walk, so it is refused outright.
    const afterComma = src.slice(i, end).replace(/^\([^,]*,\s*/, '');
    out.push({
      start: i,
      end,
      type: typeMatch ? typeMatch[1] : '<unknown>',
      inlineFn: /^(async\s*)?(\(|function\b)/.test(afterComma),
    });
  }
  return out;
}

type TokenGuard = {
  index: number;
  condition: string;
  consequent: string;
  braced: boolean;
  handler: Handler | null;
  /** `if (` occurrences inside the handler, before this guard. */
  enclosingIfsInHandler: number;
};

/** Every `if (…!token…) …` guard in `src`, with its own consequent. */
function tokenGuards(src: string): TokenGuard[] {
  const code = blankNonCode(src);
  const hs = handlers(src);
  const out: TokenGuard[] = [];
  for (const m of code.matchAll(/\bif\s*\(/g)) {
    const open = (m.index as number) + m[0].length - 1;
    const afterCond = matchBracket(code, open, '(', ')');
    const condition = src.slice(open, afterCond);
    // 🔴 THE `[^!]` IS LOAD-BEARING. Without it `hasToken: !!token` — a real
    // argument in `IframeHost`'s init gate — matches as a `!token` test, dragging
    // a lifecycle effect into the population and failing for a reason that has
    // nothing to do with a dropped request. Measured, not anticipated.
    if (!/(^|[^A-Za-z0-9_$!])!token\b/.test(condition)) continue;
    let rest = afterCond;
    while (rest < code.length && /\s/.test(code[rest])) rest++;
    const braced = code[rest] === '{';
    // Unbraced single statement — `if (!token) return;`. The `;` is located in the
    // BLANKED source so one inside a string cannot end the statement early.
    const end = braced
      ? matchBracket(code, rest, '{', '}')
      : code.indexOf(';', rest) === -1
      ? code.length
      : code.indexOf(';', rest) + 1;
    const handler = hs.find((h) => (m.index as number) >= h.start && (m.index as number) < h.end);
    const before = handler ? code.slice(handler.start, m.index as number) : '';
    out.push({
      index: m.index as number,
      condition,
      consequent: src.slice(rest, end),
      braced,
      handler: handler ?? null,
      enclosingIfsInHandler: (before.match(/\bif\s*\(/g) ?? []).length,
    });
  }
  return out;
}

function inHandler(src: string): TokenGuard[] {
  return tokenGuards(src).filter((g) => g.handler !== null);
}

/**
 * Does this consequent legally answer nothing?
 *
 * 🔴 THE EXEMPT TYPE MUST BE THE HANDLER'S OWN. Keyed on the bare string, the
 * escape hatch was wider than its docstring: any handler could buy silence by
 * passing `'REQUEST_TOKEN'` — the likeliest route being to copy that handler's
 * guard and forget to change the argument, which ALSO mislabels the telemetry.
 */
function answersOrIsExempt(g: TokenGuard): boolean {
  if (RESPONDS.test(g.consequent)) return true;
  if (!g.handler || !Object.prototype.hasOwnProperty.call(BRIDGE_NACK_EXEMPT, g.handler.type)) {
    return false;
  }
  return new RegExp(`\\breportNoToken\\s*\\(\\s*'${g.handler.type}'`).test(g.consequent);
}

describe('no host handler drops a credential-less request silently', () => {
  test.each(HOSTS)('%s: the source scan is not corrupting the file', (file) => {
    // 🔴 THE SELF-CHECK THE REGEX VERSION WOULD HAVE FAILED. If the scan mistakes
    // code for a comment (or a string for code), brackets stop balancing and a
    // handler range runs away — and every assertion below then measures a file
    // that does not exist. Both symptoms are pinned: balance, and a bound on the
    // largest handler.
    const code = blankNonCode(hostFile(file));
    const count = (ch: string) => (code.match(new RegExp(`\\${ch}`, 'g')) ?? []).length;
    expect(count('(')).toBe(count(')'));
    expect(count('{')).toBe(count('}'));
    expect(count('[')).toBe(count(']'));
    const hs = handlers(hostFile(file));
    expect(hs.length).toBeGreaterThan(0);
    expect(Math.max(...hs.map((h) => h.end - h.start))).toBeLessThan(8000);
    expect(hs.filter((h) => h.end >= code.length)).toEqual([]);
  });

  test.each(HOSTS)('%s: every handler is registered with an INLINE function', (file) => {
    // A handler hoisted into a `useCallback` and passed by reference is invisible
    // to every walk in this file — its `!token` guard lives outside the
    // registration's parentheses. Refusing the shape keeps the population
    // complete; it is a real restriction on the hosts, and a cheap one.
    const byRef = handlers(hostFile(file))
      .filter((h) => !h.inlineFn)
      .map((h) => h.type);
    expect(byRef).toEqual([]);
  });

  test.each(HOSTS)('%s: every in-handler `!token` guard ANSWERS in its own consequent', (file) => {
    const guards = inHandler(hostFile(file));
    // POSITIVE CONTROL for the parse. A walk that matched nothing would make the
    // `every` below vacuously true, and the guard would read as coverage while
    // providing none.
    expect(guards.length).toBeGreaterThan(0);
    const silent = guards
      .filter((g) => !answersOrIsExempt(g))
      .map((g) => `${g.handler?.type}: ${g.condition.replace(/\s+/g, ' ').slice(0, 60)}`);
    expect(silent).toEqual([]);
  });

  test.each(HOSTS)('%s: no in-handler `!token` guard is an UNBRACED one-liner', (file) => {
    // Belt to the population walk: the unbraced shape is how the original silent
    // drops were written, and forbidding it keeps every consequent a block a
    // future reader has to look inside.
    const unbraced = inHandler(hostFile(file))
      .filter((g) => !g.braced)
      .map((g) => `${g.handler?.type}`);
    expect(unbraced).toEqual([]);
  });

  test('lifecycle `!token` guards OUTSIDE a handler exist and are deliberately excluded', () => {
    // The exclusion is real, so it is asserted rather than assumed: if this set
    // ever empties, the filter has stopped discriminating and the in-handler
    // assertions above are being applied to the whole file by accident.
    const src = hostFile('PageBlockHost.tsx');
    expect(tokenGuards(src).length).toBeGreaterThan(inHandler(src).length);
  });

  test('the PageBlockHost population is the size the behavioural suites believe it is', () => {
    // 🔴 A LEDGER, NOT A TASTE CHECK. It fails when the set GROWS (a new handler
    // nobody has looked at) *and* when it SHRINKS (a handler deleted or its guard
    // quietly moved somewhere this parse cannot see). Either direction means the
    // behavioural coverage and the code have drifted, and the point is that a
    // human reads this line again before changing the number.
    const guards = inHandler(hostFile('PageBlockHost.tsx'));
    expect(guards).toHaveLength(31);
    // 19 route through the shared `nack` helper added with the bridge counter
    // (reply + count in one call); 11 keep a bespoke error variant that predates
    // it (the `{ok,error}` and `settlement.reply` shapes) and call
    // `reportNoToken` alongside it; 1 — REQUEST_TOKEN — counts only, because the
    // protocol has no sendable failure reply for it.
    expect(guards.filter((g) => /\bnack\s*\(/.test(g.consequent))).toHaveLength(19);
    expect(guards.filter((g) => /\breportNoToken\s*\(/.test(g.consequent))).toHaveLength(12);
    // 🔴 EVERY refusal reaches the counter — this is the relationship the metric's
    // own help text asserts ("a handler ran and refused because the block
    // credential was falsy") and the one a partial migration silently breaks.
    expect(
      guards.filter((g) => /\bnack\s*\(|\breportNoToken\s*\(/.test(g.consequent))
    ).toHaveLength(31);
  });

  test.each(HOSTS)('%s: counts a credential-less REQUEST_TOKEN UNCONDITIONALLY', (file) => {
    // 🔴 THE TWO HOSTS REGISTER THEIR HANDLERS BY HAND AND SHARE NO BRIDGE, and
    // `PageBlockHost`'s own comment says they "MUST STAY IN STEP" — so the step is
    // asserted rather than described. `REQUEST_TOKEN` is the one type whose failure
    // reply the SDK validator would drop, so the count is its ONLY observable; a
    // host that counts it only when a `requestId` happens to be present reports
    // nothing on the requestId-less shape the protocol explicitly allows.
    const guards = inHandler(hostFile(file)).filter((g) => g.handler?.type === 'REQUEST_TOKEN');
    // Selected by the HANDLER'S REGISTERED TYPE, not by the string appearing in a
    // consequent: the string spelling matched the first guard mentioning
    // REQUEST_TOKEN anywhere, so an unrelated earlier guard could satisfy the whole
    // parity test while the real handler went unexamined.
    expect(guards, `${file} has no REQUEST_TOKEN !token guard`).toHaveLength(1);
    const guard = guards[0];
    expect(guard.consequent).toMatch(/reportNoToken\('REQUEST_TOKEN'\)/);
    // No `if` inside the consequent before the report…
    expect(guard.consequent.slice(0, guard.consequent.indexOf('reportNoToken'))).not.toMatch(
      /\bif\s*\(/
    );
    // …and no `if` WRAPPING the guard either. Hoisting the old
    // `if (requestId !== undefined)` one level out restores exactly the defect
    // this test exists for, and an assertion that only reads inside the consequent
    // cannot see it. The `!token` guard must be the handler's FIRST `if`.
    expect(guard.enclosingIfsInHandler).toBe(0);
  });
});
