import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { describe, expect, test } from 'vitest';
import { BRIDGE_NACK_EXEMPT } from '~/components/AppBlocks/bridgeTelemetry';

/**
 * NO HOST MESSAGE HANDLER MAY DROP A CREDENTIAL-LESS REQUEST WITHOUT ANSWERING IT.
 *
 * 🔴 WHY A STRUCTURAL GUARD AND NOT ONLY THE BEHAVIOURAL TESTS. The behavioural
 * suites (`PageBlockHostNoTokenNack.browser.test.tsx`) pin the handlers that exist
 * TODAY. The realistic regression is the THIRTY-FOURTH handler, written by copying
 * the thirty-third's opening lines, whose reviewer has no reason to know that
 * `if (!token) return;` is the one shape that must not appear in a message handler
 * — and whose defect is INVISIBLE by construction: nothing errors, nothing logs,
 * the block simply hangs to its SDK timeout class (30s default, 120s workflow,
 * 600s human-in-the-loop). That is the exact class this whole change exists to
 * close, and a per-handler test cannot cover a handler nobody has written yet.
 *
 * 🔴 IT IS A RELATIONSHIP, NOT A COUNT. Two checks over a DERIVED population, each
 * failing in both directions:
 *
 *   1. BRANCH LEVEL — every `if (!token) { … }` body in either host must RESPOND
 *      (`nack(`, `send(`, or a settlement `.reply(`). A body that only `return`s is
 *      the defect.
 *   2. CHUNK LEVEL — every `onMessage` handler that TESTS `!token` at all must
 *      contain one of those calls somewhere. This is the wider net: it also sees a
 *      one-line `if (!token) return;`, which check 1 cannot.
 *
 * Plus a MINIMUM population size, because a parse that silently matched nothing
 * would satisfy every "all of them respond" assertion vacuously — a reassuring zero
 * is indistinguishable from a probe wired to nothing.
 *
 * 🔴 WHAT IT DOES NOT CLAIM. It checks that a RESPONSE CALL is present in the
 * branch, not that the response is correct, correlated, or accepted by the SDK's
 * inbound validator. Those are behavioural claims and they live in the browser
 * suites. Read this guard as exactly as wide as that sentence.
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
 * branch that merely counts is exactly the silent drop this file exists to stop,
 * so it is only acceptable where `BRIDGE_NACK_EXEMPT` already records that no
 * reply is sendable — which today is `REQUEST_TOKEN`
 * (`isValidTokenRefreshResponse` requires a valid `WrappedToken`; the protocol has
 * no failure variant). A new handler cannot buy silence by calling
 * `reportNoToken`: it would also have to add itself to that ledger, which is a
 * reviewed edit in a file whose own tests pin the ledger's contents.
 */
const COUNTS_ONLY_FOR_EXEMPT = new RegExp(
  `\\breportNoToken\\s*\\(\\s*'(${Object.keys(BRIDGE_NACK_EXEMPT).join('|')})'`
);

function answersOrIsExempt(body: string): boolean {
  return RESPONDS.test(body) || COUNTS_ONLY_FOR_EXEMPT.test(body);
}

/**
 * Bodies of every `if (!token …) { … }` in `src`, by brace matching.
 *
 * 🔴 THE OPENER DELIBERATELY ALLOWS EXTRA CONDITIONS. `IframeHost`'s REQUEST_TOKEN
 * guard is `if (!token || !initSentRef.current)`, and an opener pinned to a bare
 * `if (!token)` matched it ZERO times — which made this file's own `every branch
 * responds` assertion pass VACUOUSLY on that host. Measured, not reasoned: the
 * minimum-population assertion is what surfaced it.
 */
function noTokenBranchBodies(src: string): string[] {
  const bodies: string[] = [];
  const opener = /if\s*\(\s*!token\b[^)]*\)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = opener.exec(src)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < src.length && depth > 0) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
      i++;
    }
    bodies.push(src.slice(start, i - 1));
  }
  return bodies;
}

/** `onMessage`-delimited chunks that TEST `!token`, with the first message type seen in each. */
function noTokenHandlerChunks(src: string): Array<{ type: string; chunk: string }> {
  const starts = [...src.matchAll(/\bonMessage[<(]/g)].map((m) => m.index as number);
  const bounds = [...starts, src.length];
  const out: Array<{ type: string; chunk: string }> = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const chunk = src.slice(bounds[i], bounds[i + 1]);
    if (!/!token\b/.test(chunk)) continue;
    const t = /'([A-Z][A-Z_0-9]*)'/.exec(chunk);
    out.push({ type: t ? t[1] : '<unnamed>', chunk });
  }
  return out;
}

describe('no host handler drops a credential-less request silently', () => {
  test.each(HOSTS)('%s: every `if (!token) { … }` branch RESPONDS', (file) => {
    const bodies = noTokenBranchBodies(hostSource(file));
    // POSITIVE CONTROL for the parse. A regex that matched nothing would make the
    // `every` below vacuously true, and the guard would read as coverage while
    // providing none.
    expect(bodies.length).toBeGreaterThan(0);
    const silent = bodies.filter((b) => !answersOrIsExempt(b));
    expect(silent).toEqual([]);
  });

  test.each(HOSTS)(
    '%s: every `onMessage` handler that tests `!token` RESPONDS somewhere',
    (file) => {
      const chunks = noTokenHandlerChunks(hostSource(file));
      expect(chunks.length).toBeGreaterThan(0);
      const silent = chunks.filter((c) => !answersOrIsExempt(c.chunk)).map((c) => c.type);
      expect(silent).toEqual([]);
    }
  );

  test('the PageBlockHost population is the size the behavioural suites believe it is', () => {
    // 🔴 A LEDGER, NOT A TASTE CHECK. It fails when the set GROWS (a new handler
    // nobody has looked at) *and* when it SHRINKS (a handler deleted or its guard
    // quietly moved somewhere this parse cannot see). Either direction means the
    // behavioural coverage and the code have drifted, and the point is that a
    // human reads this line again before changing the number.
    const bodies = noTokenBranchBodies(hostSource('PageBlockHost.tsx'));
    expect(bodies).toHaveLength(31);
    // 19 route through the shared `nack` helper added with the bridge counter
    // (reply + count in one call); 11 keep a bespoke error variant that predates
    // it (the `{ok,error}` and `settlement.reply` shapes) and call
    // `reportNoToken` alongside it; 1 — REQUEST_TOKEN — counts only, because the
    // protocol has no sendable failure reply for it.
    expect(bodies.filter((b) => /\bnack\s*\(/.test(b))).toHaveLength(19);
    expect(bodies.filter((b) => /\breportNoToken\s*\(/.test(b))).toHaveLength(12);
    // 🔴 EVERY refusal reaches the counter — this is the relationship the metric's
    // own help text asserts ("a handler ran and refused because the block
    // credential was falsy") and the one a partial migration silently breaks.
    expect(bodies.filter((b) => /\bnack\s*\(|\breportNoToken\s*\(/.test(b))).toHaveLength(31);
  });

  test('IframeHost REQUEST_TOKEN is COUNTED even though it cannot be answered', () => {
    // The one genuine dead end left, and it is the protocol's rather than this
    // host's: `isValidTokenRefreshResponse` requires a valid `WrappedToken`, so an
    // error-only `TOKEN_REFRESH_RESPONSE` is dropped at the block's own trust
    // boundary, and the union carries no failure variant. `nack` still records the
    // `no_token` outcome, so an operator can SEE it — which is the half that was
    // reachable without an SDK change. Pinned here so that if the SDK ever gains a
    // failure variant, whoever adds it finds this note.
    const bodies = noTokenBranchBodies(hostSource('IframeHost.tsx'));
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatch(/nack\('REQUEST_TOKEN'/);
  });
});
