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
 * 600s human-in-the-loop). That is the exact class this whole change exists to
 * close, and a per-handler test cannot cover a handler nobody has written yet.
 *
 * 🔴 THE POPULATION IS EVERY `if` GUARD WHOSE CONDITION TESTS `!token`, AND THE
 * ASSERTION IS ABOUT ITS OWN CONSEQUENT. An earlier revision of this file tested
 * for a response ANYWHERE IN THE ENCLOSING `onMessage` CHUNK, and that was
 * satisfied for the wrong reason by every handler on earth: a handler's SUCCESS
 * path always contains a `send('<X>_RESULT', …)`. Measured against a replication
 * of that parse, a planted new handler with a bare `if (!token) return;` plus a
 * normal success path scored `silentChunks: []` and left all four ledger numbers
 * unmoved — i.e. the guard could not see the exact regression it exists for.
 *
 * So the walk is a real paren/brace match: find each `if (`, match its condition,
 * and take its CONSEQUENT — the braced block, or the single statement when there
 * are no braces. A one-line `if (!token) return;` is therefore IN the population
 * and fails, which is what closes that mutant.
 *
 * Guards OUTSIDE any `onMessage` handler are excluded: the hosts legitimately test
 * `!token` in lifecycle effects (init gating, status escalation), where there is no
 * request to answer.
 *
 * Plus a MINIMUM population size, because a parse that silently matched nothing
 * would satisfy every "all of them respond" assertion vacuously — a reassuring zero
 * is indistinguishable from a probe wired to nothing.
 *
 * 🔴 WHAT IT DOES NOT CLAIM. It checks that a RESPONSE CALL is present in the
 * consequent, not that the response is correct, correlated, or accepted by the
 * SDK's inbound validator. Those are behavioural claims and they live in the
 * browser suites. Read this guard as exactly as wide as that sentence.
 */

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const HOSTS = ['PageBlockHost.tsx', 'IframeHost.tsx'] as const;

/** Strip block + line comments so a `!token` inside prose cannot enter the population. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function hostSource(file: string): string {
  return stripComments(
    readFileSync(join(REPO_ROOT, 'src', 'components', 'AppBlocks', file), 'utf8')
  );
}

/** A call that puts something on the wire for the block, rather than swallowing the request. */
const RESPONDS = /\bnack\s*\(|\bsend\s*\(|\.reply\s*\(/;

/**
 * The ONE legal way to answer nothing: count the refusal and say why, for a type
 * whose failure reply the SDK's own validator would drop.
 *
 * 🔴 IT IS KEYED ON THE EXEMPTION LEDGER, NOT ON THE WORD `reportNoToken`. A
 * consequent that merely counts is exactly the silent drop this file exists to
 * stop, so it is only acceptable where `BRIDGE_NACK_EXEMPT` already records that no
 * reply is sendable — which today is `REQUEST_TOKEN`
 * (`isValidTokenRefreshResponse` requires a valid `WrappedToken`; the protocol has
 * no failure variant). A new handler cannot buy silence by calling
 * `reportNoToken`: it would also have to add itself to that ledger, which is a
 * reviewed edit in a file whose own tests pin the ledger's contents.
 */
const COUNTS_ONLY_FOR_EXEMPT = new RegExp(
  `\\breportNoToken\\s*\\(\\s*'(${Object.keys(BRIDGE_NACK_EXEMPT).join('|')})'`
);

function answersOrIsExempt(consequent: string): boolean {
  return RESPONDS.test(consequent) || COUNTS_ONLY_FOR_EXEMPT.test(consequent);
}

/** Index just past the `)` that closes the `(` at `open`. */
function matchParen(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return src.length;
}

/** Index just past the `}` that closes the `{` at `open`. */
function matchBrace(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return src.length;
}

type TokenGuard = { index: number; condition: string; consequent: string; braced: boolean };

/** Every `if (…!token…) …` guard in `src`, with its own consequent. */
function tokenGuards(src: string): TokenGuard[] {
  const out: TokenGuard[] = [];
  for (const m of src.matchAll(/\bif\s*\(/g)) {
    const open = (m.index as number) + m[0].length - 1;
    const afterCond = matchParen(src, open);
    const condition = src.slice(open, afterCond);
    // 🔴 THE `[^!]` IS LOAD-BEARING. Without it `hasToken: !!token` — a real
    // argument in `IframeHost`'s init gate — matches as a `!token` test, dragging
    // a lifecycle effect into the population and failing for a reason that has
    // nothing to do with a dropped request. Measured, not anticipated.
    if (!/(^|[^A-Za-z0-9_$!])!token\b/.test(condition)) continue;
    let rest = afterCond;
    while (rest < src.length && /\s/.test(src[rest])) rest++;
    if (src[rest] === '{') {
      out.push({
        index: m.index as number,
        condition,
        consequent: src.slice(rest, matchBrace(src, rest)),
        braced: true,
      });
    } else {
      // Unbraced single statement — `if (!token) return;`. This is the shape the
      // previous revision could not see.
      const end = src.indexOf(';', rest);
      out.push({
        index: m.index as number,
        condition,
        consequent: src.slice(rest, end === -1 ? src.length : end + 1),
        braced: false,
      });
    }
  }
  return out;
}

/**
 * [start, end) byte ranges of every `onMessage(...)` CALL.
 *
 * 🔴 EACH RANGE IS THE CALL'S OWN PARENTHESES, not "from this `onMessage` to the
 * next". The next-match spelling bleeds: everything after the FINAL registration
 * runs to EOF, so lifecycle effects far below it were classified as handler code.
 * Paren-matching the call bounds each handler to its actual body.
 *
 * The generic argument (`onMessage<{ requestId?: unknown }>(`) is skipped by
 * tracking angle depth, so the `(` found is the call's, never one inside the type.
 */
function handlerRanges(src: string): Array<[number, number]> {
  const bounds: Array<[number, number]> = [];
  for (const m of src.matchAll(/\bonMessage\s*[<(]/g)) {
    let i = (m.index as number) + 'onMessage'.length;
    let angle = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === '<') angle++;
      else if (c === '>') angle--;
      else if (c === '(' && angle === 0) break;
      i++;
    }
    if (i >= src.length) continue;
    bounds.push([i, matchParen(src, i)]);
  }
  return bounds;
}

function guardsInsideHandlers(src: string): TokenGuard[] {
  const ranges = handlerRanges(src);
  return tokenGuards(src).filter((g) => ranges.some(([a, b]) => g.index >= a && g.index < b));
}

describe('no host handler drops a credential-less request silently', () => {
  test.each(HOSTS)('%s: every in-handler `!token` guard ANSWERS in its own consequent', (file) => {
    const guards = guardsInsideHandlers(hostSource(file));
    // POSITIVE CONTROL for the parse. A walk that matched nothing would make the
    // `every` below vacuously true, and the guard would read as coverage while
    // providing none.
    expect(guards.length).toBeGreaterThan(0);
    const silent = guards
      .filter((g) => !answersOrIsExempt(g.consequent))
      .map((g) => g.condition.replace(/\s+/g, ' ').slice(0, 80));
    expect(silent).toEqual([]);
  });

  test.each(HOSTS)('%s: no in-handler `!token` guard is an UNBRACED one-liner', (file) => {
    // Belt to the braces the population walk already handles: the unbraced shape is
    // how the original nineteen silent drops were written, and forbidding it keeps
    // the consequent a block a future reader has to look inside.
    const unbraced = guardsInsideHandlers(hostSource(file))
      .filter((g) => !g.braced)
      .map((g) => g.condition.replace(/\s+/g, ' ').slice(0, 80));
    expect(unbraced).toEqual([]);
  });

  test('lifecycle `!token` guards OUTSIDE a handler exist and are deliberately excluded', () => {
    // The exclusion is real, so it is asserted rather than assumed: if this set
    // ever empties, the filter has stopped discriminating and the in-handler
    // assertions above are being applied to the whole file by accident.
    const src = hostSource('PageBlockHost.tsx');
    expect(tokenGuards(src).length).toBeGreaterThan(guardsInsideHandlers(src).length);
  });

  test('the PageBlockHost population is the size the behavioural suites believe it is', () => {
    // 🔴 A LEDGER, NOT A TASTE CHECK. It fails when the set GROWS (a new handler
    // nobody has looked at) *and* when it SHRINKS (a handler deleted or its guard
    // quietly moved somewhere this parse cannot see). Either direction means the
    // behavioural coverage and the code have drifted, and the point is that a
    // human reads this line again before changing the number.
    const guards = guardsInsideHandlers(hostSource('PageBlockHost.tsx'));
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

  test('BOTH hosts count a credential-less REQUEST_TOKEN, unconditionally', () => {
    // 🔴 THE TWO HOSTS REGISTER THEIR HANDLERS BY HAND AND SHARE NO BRIDGE, and
    // `PageBlockHost`'s own comment says they "MUST STAY IN STEP" — so the step is
    // asserted rather than described. `REQUEST_TOKEN` is the one type whose failure
    // reply the SDK validator would drop, so the count is its ONLY observable; a
    // host that counts it only when a `requestId` happens to be present reports
    // nothing on the requestId-less shape the protocol explicitly allows.
    for (const file of HOSTS) {
      const guard = guardsInsideHandlers(hostSource(file)).find((g) =>
        /REQUEST_TOKEN/.test(g.consequent)
      );
      expect(guard, `${file} has no REQUEST_TOKEN !token guard`).toBeDefined();
      expect(guard!.consequent).toMatch(/reportNoToken\('REQUEST_TOKEN'\)/);
      // No `if` between the guard's opening brace and the report — the count is
      // unconditional.
      expect(guard!.consequent.slice(0, guard!.consequent.indexOf('reportNoToken'))).not.toMatch(
        /\bif\s*\(/
      );
    }
  });
});
