import { existsSync, readFileSync, readdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { describe, expect, it } from 'vitest';

/**
 * RELATIONSHIP GUARD — an edge-cached tRPC procedure must not vary its response
 * body by WHO is asking.
 *
 * `edgeCacheIt` (`src/server/middleware.trpc.ts`) sets `ctx.cache.edgeTTL`, which
 * `responseMeta` in `src/pages/api/trpc/[trpc].ts` turns into a
 * `Cache-Control: public, s-maxage=…` response header (it also strips `Set-Cookie`).
 * There is no authentication gate on that path: a logged-in caller's response is
 * marked publicly cacheable exactly like an anonymous one. A shared cache keyed on
 * the URL therefore stores ONE caller's body and replays it to the next caller with
 * the same URL. So a wrapped procedure whose body depends on the caller is a
 * cross-user disclosure, and the dependency is usually invisible at the call site —
 * it lives two files away in a service function.
 *
 * This file asserts a RELATIONSHIP rather than a snapshot of today's procedure
 * names:
 *
 *     wrapped(P) ∧ identityReaches(P) ∧ ¬callerAwareOptOut(P)  ⇒  P ∈ LEDGER
 *
 * and, symmetrically, every LEDGER entry must still satisfy the left-hand side —
 * so the ledger fails when the risky set GROWS *and* when an entry goes stale. Each
 * entry additionally records the FACT that makes it tolerable, and that fact is
 * re-derived here on every run rather than trusted. A name-only allowlist would let
 * the exact refactor this guard exists to catch straight through: two procedures
 * below are safe only because a service function ignores an identity value it is
 * handed, and "use the parameter that is already being passed" is the most natural
 * tidy-up imaginable.
 *
 * ── Why a source parse and not runtime router inspection ──────────────────────
 * Runtime derivation off `appRouter._def.procedures` was the first choice (it
 * cannot drift from the code) and was rejected for two independent reasons:
 *   1. `edgeCacheIt` is a factory — every call site builds a FRESH anonymous
 *      middleware via tRPC's `middleware()`. The resulting entries in
 *      `_def.middlewares` carry no identity, name or marker that separates them
 *      from `cacheIt`, `noEdgeCache` or any other middleware, so runtime
 *      inspection cannot answer "is this procedure edge-cached" at all without
 *      tagging production code.
 *   2. The second half of the relationship — "does caller identity reach the
 *      resolver" — is a question about the SOURCE of the handler and its callees.
 *      No runtime value can answer it.
 * Every router in `src/server/routers/index.ts` is also registered through
 * `lazy(() => import(…))`, so a runtime walk would have to await the whole server
 * graph (Prisma, Redis, Meilisearch, env) inside vitest to populate the map.
 *
 * Since it is a source parse, comments are stripped BEFORE any matching: a
 * commented-out `edgeCacheIt(` is not applied middleware. `image.getGenerationData`
 * and `event.getData` are the live negative-control fixtures for that, and are
 * asserted below. A grep for a call is not a count of calls.
 *
 * ── TODO: consolidate with `CACHEABLE_PROCEDURES` ─────────────────────────────
 * `src/utils/__tests__/trpc-batching.test.ts` derives a closely-related set (which
 * procedures are edge-cacheable for authed sessions) with its own copy of this
 * parsing. That derivation is currently being improved on PR #4347
 * (`zach/model-getall-edge-cache-auth-skip`), so this file deliberately keeps an
 * independent copy rather than importing from it — touching that file here would
 * make this a stacked change. ONE RULE, ONE PLACE: once #4347 lands, hoist the
 * shared primitives (`stripTsComments`, `procedureBlocks`, the router key map, the
 * `edgeCacheIt` derivation) into a single test helper module and have both
 * consumers read from it. Note while doing so that this file's derivation is the
 * WIDER of the two — see `edgeCacheAliases`; the batching one misses hoisted
 * `const x = edgeCacheIt(…)` aliases and therefore does not see either
 * `leaderboard` procedure.
 */

const SRC = resolve(__dirname, '../..');
const ROUTERS_DIR = join(SRC, 'server/routers');

// ─────────────────────────────────────────────────────────────────────────────
// Parsing primitives. Exported shape kept small; each is unit-tested against
// synthetic fixtures below (negative control AND positive control) before any of
// them is pointed at the real tree.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Remove `//` and block comments, preserving newlines (line-oriented splitting
 * downstream is unaffected) and string/template contents (so `//` inside a URL
 * literal cannot swallow the rest of the line).
 */
export function stripTsComments(src: string): string {
  type Mode = 'code' | 'line' | 'block' | 'single' | 'double' | 'template';
  let mode: Mode = 'code';
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const c2 = src[i + 1];
    if (mode === 'code') {
      if (c === '/' && c2 === '/') {
        mode = 'line';
        i += 2;
        continue;
      }
      if (c === '/' && c2 === '*') {
        mode = 'block';
        i += 2;
        continue;
      }
      if (c === "'") mode = 'single';
      else if (c === '"') mode = 'double';
      else if (c === '`') mode = 'template';
      out += c;
      i += 1;
      continue;
    }
    if (mode === 'line') {
      if (c === '\n') {
        mode = 'code';
        out += c;
      }
      i += 1;
      continue;
    }
    if (mode === 'block') {
      if (c === '*' && c2 === '/') {
        mode = 'code';
        i += 2;
        continue;
      }
      if (c === '\n') out += c;
      i += 1;
      continue;
    }
    if (c === '\\') {
      out += c + (c2 ?? '');
      i += 2;
      continue;
    }
    if (
      (mode === 'single' && c === "'") ||
      (mode === 'double' && c === '"') ||
      (mode === 'template' && c === '`')
    ) {
      mode = 'code';
    }
    out += c;
    i += 1;
  }
  return out;
}

const readSource = (file: string) => stripTsComments(readFileSync(file, 'utf8'));

/** Split a router file into top-level procedure blocks keyed by name (2-space indent). */
export function procedureBlocks(content: string): Array<{ name: string; block: string }> {
  const lines = content.split('\n');
  const starts: number[] = [];
  lines.forEach((l, i) => {
    if (/^ {2}[a-zA-Z_]\w*:\s/.test(l)) starts.push(i);
  });
  return starts.map((start, idx) => {
    const end = idx + 1 < starts.length ? starts[idx + 1] : lines.length;
    return {
      name: /^ {2}([a-zA-Z_]\w*):/.exec(lines[start])![1],
      block: lines.slice(start, end).join('\n'),
    };
  });
}

/**
 * Module-level `const x = edgeCacheIt({…})` aliases. `leaderboard.router.ts` hoists
 * its middleware this way and then `.use(leaderboardEdgeCache)` — a derivation that
 * only looks for a literal `edgeCacheIt(` inside the procedure block is blind to
 * every procedure in that file.
 */
export function edgeCacheAliases(content: string): Set<string> {
  const names = new Set<string>();
  const re = /(?:const|let|var)\s+(\w+)\s*(?::[^=]+)?=\s*edgeCacheIt\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) names.add(m[1]);
  return names;
}

export function procedureWrapsEdgeCache(block: string, aliases: Set<string>): boolean {
  if (block.includes('edgeCacheIt(')) return true;
  for (const a of aliases) {
    if (new RegExp(`\\.use\\(\\s*${a}\\s*\\)`).test(block)) return true;
  }
  return false;
}

/**
 * A caller-aware opt-out: something applied UPSTREAM of the resolver that zeroes the
 * edge TTL based on who is calling. Four spellings exist today:
 *   - `noEdgeCache({ authedOnly: true })` — skips caching for logged-in callers.
 *   - `noEdgeCache()`                     — blanket; kills edge caching outright.
 *   - a local middleware `.use(name)` whose `cache.skip` VALUE is read off `ctx.user`
 *     (`model.router.ts`'s `skipEdgeCache` once #4347 lands).
 *   - a local middleware `.use(name)` that sets a CONSTANT `cache.skip` behind an
 *     identity GUARD — `if (!ctx.user?.isModerator) return next();` then
 *     `next({ ctx: { …, cache: { …ctx.cache, skip: true } } })`. This is
 *     `leaderboard.router.ts`'s `skipEdgeCacheForModerators` (#4377), and it is the
 *     spelling this derivation was originally blind to: the identity never appears in
 *     the `skip:` expression, so an expression-only test reads it as input-derived and
 *     silently leaves a FIXED procedure in the ledger as "not safe". Both branches are
 *     required; neither is a superset of the other.
 *
 * DELIBERATELY NOT counted as opt-outs:
 *   - `ctx.cache.skip = …` assigned inside the RESOLVER. Since #4368 landed,
 *     `edgeCacheIt` re-reads `skip` AFTER `next()`, so — unlike on the `main` this
 *     guard was first written against — such an assignment now does take effect.
 *     It is still not counted, for the same reason as `canCache` below: at every live
 *     site it is conditional on something other than caller identity
 *     (`homeBlock.getHomeBlock`'s Announcement branch is the instance), so counting it
 *     would exempt every OTHER input shape, which stays caller-varying.
 *   - `ctx.cache.canCache = false` inside the resolver. That one DOES take effect
 *     (it is read after `next()`), but at every live site it is CONDITIONAL on
 *     something other than caller identity, so it is a mitigation, not an opt-out.
 *     Treating a conditional as an opt-out would silently exempt the caller-varying
 *     path it does not cover.
 */
export function callerAwareOptOut(block: string, routerContent: string): string | null {
  if (/noEdgeCache\(\s*\{\s*authedOnly/.test(block)) return 'noEdgeCache({authedOnly})';
  if (/noEdgeCache\(\s*\)/.test(block)) return 'noEdgeCache()';
  // A locally-defined middleware referenced only by name.
  const useRe = /\.use\(\s*([A-Za-z_]\w*)\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = useRe.exec(block))) {
    const name = m[1];
    const defRe = new RegExp(`(?:const|let|var)\\s+${name}\\s*(?::[^=]+)?=\\s*middleware\\(`);
    const def = defRe.exec(routerContent);
    if (!def) continue;
    const body = balancedFrom(routerContent, def.index + def[0].length - 1);
    if (!body) continue;
    // Only an identity-derived `skip` counts. `model.router.ts`'s `skipEdgeCache`
    // computes it from the INPUT (`favorites || hidden`), which does not make the
    // response caller-independent for every other input shape.
    const skip = /\bskip\s*:\s*([^,}]+)/.exec(body);
    if (!skip) continue;
    if (IDENTITY_EXPR_RE.test(skip[1])) return `${name} (skip from ctx identity)`;
    // The identity can instead sit in a GUARD that decides whether the skip is
    // reached at all (`skipEdgeCacheForModerators`). Deliberately narrow: identity
    // must appear inside an `if (…)` CONDITION, not merely somewhere in the body —
    // a middleware that skips on input while logging `ctx.user` must NOT be exempted,
    // because a false opt-out silently removes a procedure from the ledger.
    if (/\bif\s*\([^)]*\bctx\s*\??\.\s*(?:user|features|session)\b/.test(body))
      return `${name} (skip gated on ctx identity)`;
  }
  return null;
}

/** Text of the balanced bracket group that starts at `open`, inclusive. */
function balancedFrom(src: string, open: number): string | null {
  const pairs: Record<string, string> = { '(': ')', '{': '}', '[': ']' };
  if (!pairs[src[open]]) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return null;
}

/** The `.query(…)` / `.mutation(…)` argument — the resolver, inline or by name. */
export function terminalResolver(block: string): { kind: string; text: string } | null {
  const m = /\.\s*(query|mutation)\s*\(/.exec(block);
  if (!m) return null;
  const group = balancedFrom(block, m.index + m[0].length - 1);
  if (!group) return null;
  return { kind: m[1], text: group.slice(1, -1).trim() };
}

/** `name -> absolute file` for every named import in a file. */
export function importMap(content: string, fromFile: string): Record<string, string> {
  const map: Record<string, string> = {};
  const re = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    const spec = m[2];
    let p: string | null = null;
    if (spec.startsWith('~/')) p = join(SRC, spec.slice(2));
    else if (spec.startsWith('.')) p = resolve(dirname(fromFile), spec);
    if (!p) continue;
    const cand = [`${p}.ts`, `${p}.tsx`, join(p, 'index.ts')].find(existsSync);
    if (!cand) continue;
    for (const raw of m[1].split(',')) {
      const n = raw.trim().replace(/^type\s+/, '');
      if (!n) continue;
      const parts = n.split(/\s+as\s+/);
      map[(parts[1] ?? parts[0]).trim()] = cand;
    }
  }
  return map;
}

/**
 * Source text of a top-level `const`/`function` declaration, from the declaration
 * keyword through the end of its body. The lookahead is what keeps an arrow
 * function's PARAMETER LIST from being mistaken for the whole declaration — an
 * earlier version stopped at the closing `)` of `async ({ ctx, input }: {…})` and
 * so reported every controller handler as identity-free.
 */
export function findFunctionSource(file: string, name: string): string | null {
  const content = readSource(file);
  const pats = [
    new RegExp(`(?:export\\s+)?(?:const|let|var)\\s+${name}\\s*(?::[^=]*?)?=\\s*`),
    // 🔴 LOOKAHEAD, not a consuming class. Consuming the `(` starts the scan below one
    // level deep: the parameter list's `)` drives depth to -1 while `seen` is still
    // false, so the very next `{` reads as "balanced" and the declaration is cut off at
    // the opening brace of its own body. Every `function`-declared callee then looks
    // like it uses nothing.
    new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*(?=[<(])`),
  ];
  for (const re of pats) {
    const m = re.exec(content);
    if (!m) continue;
    let depth = 0;
    let seen = false;
    let end = content.length;
    for (let i = m.index + m[0].length; i < content.length; i++) {
      const c = content[i];
      if (c === '(' || c === '{' || c === '[') {
        depth++;
        seen = true;
      } else if (c === ')' || c === '}' || c === ']') {
        depth--;
      } else continue;
      if (seen && depth === 0) {
        let j = i + 1;
        while (j < content.length && /\s/.test(content[j])) j++;
        // Still inside the declaration: an arrow body, a return-type annotation,
        // a generic argument list, or the block body of a `function`.
        if (
          content.slice(j, j + 2) === '=>' ||
          content[j] === ':' ||
          content[j] === '(' ||
          content[j] === '{' ||
          content[j] === '<'
        )
          continue;
        end = i + 1;
        break;
      }
    }
    return content.slice(m.index, end);
  }
  return null;
}

// `ctx.user` / `ctx?.user` / `ctx.features` / `ctx.session` — the context fields that
// carry WHO is asking. `ctx.cache`, `ctx.req`, `ctx.ip` etc. are deliberately absent:
// they are not caller identity. Keep this list in step with `Context` in
// `src/server/createContext.ts` when a new identity-bearing field is added.
const IDENTITY_EXPR_RE = /\bctx\s*\??\.\s*(user|features|session)\b/;
const IDENTITY_EXPR_RE_G = /\bctx\s*\??\.\s*(user|features|session)\b/g;

export type IdentitySite = { expr: string; index: number };

export function identitySites(text: string): IdentitySite[] {
  const out: IdentitySite[] = [];
  IDENTITY_EXPR_RE_G.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IDENTITY_EXPR_RE_G.exec(text))) out.push({ expr: `ctx.${m[1]}`, index: m.index });
  return out;
}

const CONTROL_KEYWORDS = new Set([
  'if',
  'for',
  'while',
  'switch',
  'return',
  'catch',
  'await',
  'typeof',
]);

/** Name of the function whose argument list encloses `index`, or null. */
export function enclosingCallee(text: string, index: number): string | null {
  let depth = 0;
  for (let i = index; i >= 0; i--) {
    const c = text[i];
    if (c === ')') depth++;
    else if (c === '(') {
      if (depth === 0) {
        const m = /([A-Za-z_$][\w$]*)\s*$/.exec(text.slice(0, i));
        return m ? m[1] : null;
      }
      depth--;
    }
  }
  return null;
}

export type Forward = { callee: string; prop: string; expr: string };

/**
 * Identity values handed to a named callee as an object property —
 * `getHomeBlockById({ ...input, user: ctx.user })`. Requires BOTH a property key
 * immediately before the identity expression AND a non-keyword callee identifier,
 * so `if (!ctx.user?.isModerator)` is not mistaken for a forward.
 *
 * Returns the forwards plus the identity sites that are NOT forwards: a DIRECT use
 * of identity inside the resolver itself, which no fact about a callee can excuse.
 */
export function analyzeIdentityUse(text: string): { forwards: Forward[]; directUses: number } {
  const forwards: Forward[] = [];
  let directUses = 0;
  for (const site of identitySites(text)) {
    const before = text.slice(0, site.index);
    const key = /([A-Za-z_$][\w$]*)\s*:\s*$/.exec(before);
    const callee = enclosingCallee(text, site.index);
    if (key && callee && !CONTROL_KEYWORDS.has(callee)) {
      forwards.push({ callee, prop: key[1], expr: site.expr });
    } else {
      directUses += 1;
    }
  }
  return { forwards, directUses };
}

/** First parameter's shape. */
export function paramShape(
  fnSource: string
):
  | { kind: 'destructured'; keys: string[]; rest: string | null }
  | { kind: 'named'; name: string }
  | { kind: 'unknown' } {
  const open = fnSource.indexOf('(');
  if (open === -1) return { kind: 'unknown' };
  const params = balancedFrom(fnSource, open);
  if (!params) return { kind: 'unknown' };
  const inner = params.slice(1, -1).trim();
  if (inner.startsWith('{')) {
    const pat = balancedFrom(inner, 0);
    if (!pat) return { kind: 'unknown' };
    const body = pat.slice(1, -1);
    const keys: string[] = [];
    let rest: string | null = null;
    let depth = 0;
    let cur = '';
    for (const c of body) {
      if (c === '{' || c === '[' || c === '(') depth++;
      if (c === '}' || c === ']' || c === ')') depth--;
      if (c === ',' && depth === 0) {
        cur = '';
        continue;
      }
      cur += c;
      if (depth === 0 && /^\s*\.\.\.\s*([A-Za-z_$][\w$]*)\s*$/.test(cur)) {
        rest = /\.\.\.\s*([A-Za-z_$][\w$]*)/.exec(cur)![1];
      }
    }
    for (const part of splitTopLevel(body)) {
      const t = part.trim();
      if (!t || t.startsWith('...')) continue;
      const m = /^([A-Za-z_$][\w$]*)/.exec(t);
      if (m) keys.push(m[1]);
    }
    return { kind: 'destructured', keys, rest };
  }
  const m = /^([A-Za-z_$][\w$]*)/.exec(inner);
  return m ? { kind: 'named', name: m[1] } : { kind: 'unknown' };
}

function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const c of s) {
    if (c === '{' || c === '[' || c === '(' || c === '<') depth++;
    else if (c === '}' || c === ']' || c === ')' || c === '>') depth--;
    if (c === ',' && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

/**
 * Everything after the first parameter list — the return-type annotation and body.
 *
 * 🔴 Whichever of `=>` and `{` comes FIRST delimits the body. Taking `=>` whenever one
 * exists anywhere in the remainder is wrong for a `function` declaration, which has no
 * arrow of its own: the first `=>` is then some arrow callback INSIDE the body, and
 * everything before it — potentially the identity use you are looking for — is sliced
 * off. That produced a silent 'ignores' verdict for `getLeaderboard`, which does branch
 * on `input.isModerator`; the ledger caught it only because the fact was pinned.
 */
export function functionBody(fnSource: string): string {
  const open = fnSource.indexOf('(');
  if (open === -1) return fnSource;
  const params = balancedFrom(fnSource, open);
  if (!params) return fnSource;
  const rest = fnSource.slice(open + params.length);
  const arrow = rest.indexOf('=>');
  const brace = rest.indexOf('{');
  if (arrow !== -1 && (brace === -1 || arrow < brace)) return rest.slice(arrow + 2);
  if (brace !== -1) return rest.slice(brace);
  return rest;
}

export type CalleeVerdict = 'uses' | 'ignores' | 'unknown';

/**
 * Does `fnSource` actually USE the property `prop` of the object it is handed?
 *
 * "Binds" is not the question — `getUserCreator` destructures `isModerator` and then
 * never references it, and a guard that stopped at the destructuring pattern would
 * score that as a use. `unknown` is returned rather than guessed whenever a rest
 * element could still be carrying the value into somewhere this parse cannot follow;
 * a ledger entry may not claim safety on an `unknown`.
 */
export function calleeUsesProp(fnSource: string, prop: string): CalleeVerdict {
  const shape = paramShape(fnSource);
  const body = functionBody(fnSource);
  const ref = new RegExp(`\\b${prop}\\b`);
  if (shape.kind === 'destructured') {
    if (shape.keys.includes(prop)) return ref.test(body) ? 'uses' : 'ignores';
    // Not named in the pattern: it can only survive through a rest element.
    if (shape.rest && new RegExp(`\\b${shape.rest}\\b`).test(body)) return 'unknown';
    return 'ignores';
  }
  if (shape.kind === 'named') {
    const p = shape.name;
    if (new RegExp(`\\b${p}\\s*\\??\\.\\s*${prop}\\b`).test(body)) return 'uses';
    if (new RegExp(`\\.\\.\\.\\s*${p}\\b`).test(body)) return 'unknown';
    return 'ignores';
  }
  return 'unknown';
}

// ─────────────────────────────────────────────────────────────────────────────
// Derivation over the real tree
// ─────────────────────────────────────────────────────────────────────────────

export type Derived = {
  path: string;
  file: string;
  optOut: string | null;
  identity: string[];
  forwards: Array<Forward & { verdict: CalleeVerdict; resolved: boolean }>;
  directUses: number;
};

function routerKeyMap(): Record<string, string> {
  // Comment-aware for the same reason as the `edgeCacheIt(` scan: a commented-out
  // `lazy()` registration is not a registered router and must not mint a key.
  const index = readSource(join(ROUTERS_DIR, 'index.ts'));
  const map: Record<string, string> = {};
  const re = /(\w+):\s*lazy\(\(\)\s*=>\s*import\(['"]([^'"]+)['"]\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(index))) {
    const base = m[2].split('/').pop()!;
    map[base.endsWith('.ts') ? base : `${base}.ts`] = m[1];
  }
  return map;
}

export function deriveEdgeCachedProcedures(): { all: Derived[]; missingKey: string[] } {
  const fileToKey = routerKeyMap();
  const all: Derived[] = [];
  const missingKey: string[] = [];

  for (const file of readdirSync(ROUTERS_DIR)) {
    if (!file.endsWith('.router.ts')) continue;
    const path = join(ROUTERS_DIR, file);
    const content = readSource(path);
    const aliases = edgeCacheAliases(content);
    if (!content.includes('edgeCacheIt(')) continue;
    const key = fileToKey[file];
    if (!key) {
      missingKey.push(file);
      continue;
    }
    const imports = importMap(content, path);

    for (const { name, block } of procedureBlocks(content)) {
      if (!procedureWrapsEdgeCache(block, aliases)) continue;
      const term = terminalResolver(block);
      let handlerText = term?.text ?? '';
      let handlerFile = path;
      if (term && /^[A-Za-z_]\w*$/.test(term.text)) {
        // Imported controller handler, or one declared in the router file itself.
        const f = imports[term.text];
        const fn = f ? findFunctionSource(f, term.text) : findFunctionSource(path, term.text);
        if (fn) {
          handlerText = fn;
          handlerFile = f ?? path;
        }
      }
      const { forwards, directUses } = analyzeIdentityUse(handlerText);
      const handlerImports = importMap(readSource(handlerFile), handlerFile);
      const resolvedForwards = forwards.map((fw) => {
        const target = handlerImports[fw.callee];
        const src = target
          ? findFunctionSource(target, fw.callee)
          : findFunctionSource(handlerFile, fw.callee);
        return {
          ...fw,
          resolved: !!src,
          verdict: src ? calleeUsesProp(src, fw.prop) : ('unknown' as CalleeVerdict),
        };
      });
      all.push({
        path: `${key}.${name}`,
        file,
        optOut: callerAwareOptOut(block, content),
        // Every identity expression the resolver touches, forwarded or not.
        identity: [...new Set(identitySites(handlerText).map((s) => s.expr))].sort(),
        forwards: resolvedForwards,
        directUses,
      });
    }
  }
  return { all, missingKey };
}

/** wrapped ∧ identity-reaching ∧ no caller-aware opt-out. */
const isRisky = (d: Derived) => d.identity.length > 0 && !d.optOut;

// ─────────────────────────────────────────────────────────────────────────────
// THE LEDGER
//
// Every entry is an explicit, justified exception to "an edge-cached procedure must
// not vary by caller". `fact` is re-derived on every run and compared, so an entry
// cannot survive the code changing underneath it.
//
//   status 'callee-ignores-identity'
//     A SAFETY claim: the resolver forwards an identity value into a service
//     function that drops it on the floor, and uses identity nowhere else.
//     Enforced mechanically — every forward must be `resolved` with verdict
//     'ignores', and `directUses` must be 0. Bind that parameter in the callee and
//     this entry goes red.
//
//   status 'accepted-variance'
//     NOT a safety claim. The response demonstrably varies by caller and this guard
//     is recording that, not blessing it. `why` states the variance, `closes` states
//     what would retire the entry. The mechanical content is the fact snapshot: the
//     exact identity surface is pinned, so any change to how identity is used here
//     — widening it, adding a field — turns the entry red and forces a re-read.
// ─────────────────────────────────────────────────────────────────────────────

type LedgerEntry = {
  identity: string[];
  /** callee|prop|verdict, sorted — re-derived and compared on every run. */
  forwards: string[];
  directUses: number;
} & (
  | { status: 'callee-ignores-identity'; why: string }
  | { status: 'accepted-variance'; why: string; closes: string }
);

const LEDGER: Record<string, LedgerEntry> = {
  'homeBlock.getHomeBlock': {
    status: 'callee-ignores-identity',
    why:
      'getHomeBlocksByIdHandler forwards `user: ctx.user` into getHomeBlockById, whose ' +
      'parameter pattern destructures only `{ id, domain }` — the SessionUser is dropped at ' +
      'the boundary and never reaches a query. (Its type still declares `user?: SessionUser` ' +
      'with a comment claiming it is "passed down to getHomeBlockData"; that comment is stale, ' +
      'which is exactly how this becomes a leak the day somebody tidies it up.) The stake is ' +
      'wider than the edge header: getHomeBlockById returns via getHomeBlockCached, which ' +
      'stores the result in Redis under a key of type:identifier:domain carrying no user ' +
      'segment, so identity reaching that path would cross callers even with edgeCacheIt ' +
      'removed. Note also that the ctx.cache.skip assigned in this handler is scoped to the ' +
      'Announcement branch: since #4368 landed, edgeCacheIt re-reads `skip` after the resolver ' +
      'so that assignment now takes effect, but it is conditional on the block TYPE, not on ' +
      'the caller, so every other block type stays edge-cached and this entry still stands.',
    identity: ['ctx.user'],
    forwards: ['getHomeBlockById|user|ignores'],
    directUses: 0,
  },
  'leaderboard.getLeadboardLegends': {
    status: 'callee-ignores-identity',
    why:
      'The inline resolver forwards `isModerator: ctx?.user?.isModerator ?? false` into ' +
      'getLeaderboardLegends, which takes the whole object as `input` and never reads ' +
      '`input.isModerator` — its SQL filters on id and domain only. Sibling ' +
      'leaderboard.getLeaderboard forwards the same value into a function that DOES branch on ' +
      'it, so this pair is one edit away from diverging.',
    identity: ['ctx.user'],
    forwards: ['getLeaderboardLegends|isModerator|ignores'],
    directUses: 0,
  },
  // `leaderboard.getLeaderboard` was here as `accepted-variance` ("PRE-EXISTING, NOT
  // SAFE": the resolver forwards `isModerator` into getLeaderboard, which appends
  // `AND l.public = true` only for a non-moderator, so two callers get different
  // bodies from one URL under public cache headers). #4377 closed it with an upstream
  // `skipEdgeCacheForModerators`, so the procedure now carries a caller-aware opt-out
  // and `isRisky` no longer selects it. The entry is removed rather than restated:
  // leaving it would have this guard assert "we accepted this" about an exposure that
  // is fixed. Its stated closing condition named only two spellings, and #4377 used a
  // third — which is why `callerAwareOptOut` grew the guard branch above in the same
  // change. If the opt-out is ever removed, the derivation puts the procedure back in
  // `risky` and the `unledgered` assertion fails until someone re-reads this.
  'user.getCreator': {
    status: 'accepted-variance',
    why:
      'PRE-EXISTING, NOT SAFE. getUserCreatorHandler masks a moderator-only field directly in ' +
      'the resolver — `if (!ctx.user?.isModerator) user.excludeFromLeaderboards = false` — so ' +
      'the body differs between a moderator and everyone else. (Its OTHER identity use, ' +
      'forwarding isModerator into getUserCreator, is inert: that service destructures the ' +
      'parameter and never references it. Note "destructured" is not "used" — the ledger ' +
      'records the verdict `ignores` for it, and only the direct use above is real.)',
    closes:
      'Remove this entry when the excludeFromLeaderboards masking moves out of the ' +
      'edge-cached path, or the procedure applies noEdgeCache({ authedOnly: true }). ' +
      'Checked by: this test failing as a stale entry.',
    identity: ['ctx.user'],
    forwards: ['getUserCreator|isModerator|ignores'],
    directUses: 1,
  },
  'model.getAll': {
    status: 'accepted-variance',
    why:
      'PRE-EXISTING, NOT SAFE, and known: the branch that adds an authed opt-out here is open ' +
      'as PR #4347. getModelsInfiniteHandler reads two feature flags off ctx.features and ' +
      'forwards `user: ctx.user` into getModelsWithImagesAndModelVersions, which uses it. The ' +
      'local `skipEdgeCache` middleware is NOT a caller-aware opt-out — it derives `skip` from ' +
      'the INPUT (favorites/hidden), leaving every other input shape caller-varying. ' +
      '`ctx.cache.canCache = false` in the handler does take effect but is conditional on a ' +
      'private model having appeared, so it covers one path, not the class.',
    closes:
      'Remove this entry when #4347 lands an authed opt-out on model.getAll. Checked by: ' +
      'this test failing as a stale entry once the opt-out is derivable.',
    identity: ['ctx.features', 'ctx.user'],
    forwards: ['getModelsWithImagesAndModelVersions|user|uses'],
    directUses: 2,
  },
};

const fmtForwards = (d: Derived) =>
  d.forwards.map((f) => `${f.callee}|${f.prop}|${f.verdict}`).sort();

// ─────────────────────────────────────────────────────────────────────────────
// Instrument tests. Every primitive gets a negative control (must not match) and a
// positive control (must match) on a synthetic fixture, BEFORE it is trusted over
// the real tree. A derivation that has only ever been watched return "nothing" is
// indistinguishable from one wired to nothing.
// ─────────────────────────────────────────────────────────────────────────────

describe('parsing primitives (instrument validation)', () => {
  it('stripTsComments ignores a commented-out edgeCacheIt but keeps a real one', () => {
    const commented = [
      '  getGenerationData: publicProcedure',
      '    // .use(',
      '    //   edgeCacheIt({ ttl: CacheTTL.day })',
      '    // )',
      '    /* .use(edgeCacheIt({ ttl: 1 })) */',
      '    .query(({ input }) => f(input)),',
    ].join('\n');
    expect(commented.includes('edgeCacheIt(')).toBe(true); // a grep IS fooled
    expect(stripTsComments(commented).includes('edgeCacheIt(')).toBe(false);

    const real = '  getAll: publicProcedure\n    .use(edgeCacheIt({ ttl: 1 }))\n';
    expect(stripTsComments(real).includes('edgeCacheIt(')).toBe(true);
  });

  it('stripTsComments does not treat // inside a string as a comment', () => {
    expect(stripTsComments(`const u = 'https://x/y'; edgeCacheIt({});`)).toContain('edgeCacheIt(');
  });

  it('stripTsComments preserves line count', () => {
    const src = 'a\n// c\n/* b\n b */\nd\n';
    expect(stripTsComments(src).split('\n').length).toBe(src.split('\n').length);
  });

  it('edgeCacheAliases finds a hoisted middleware const, and procedureWrapsEdgeCache uses it', () => {
    const content = 'const lbCache = edgeCacheIt({ ttl: 1 });\n';
    const aliases = edgeCacheAliases(content);
    expect([...aliases]).toEqual(['lbCache']);
    // POSITIVE: an aliased .use is wrapping…
    expect(procedureWrapsEdgeCache('  x: p\n    .use(lbCache)\n    .query(f),', aliases)).toBe(
      true
    );
    // NEGATIVE: …and an unrelated .use is not.
    expect(procedureWrapsEdgeCache('  y: p\n    .use(other)\n    .query(f),', aliases)).toBe(false);
  });

  it('terminalResolver extracts an inline arrow and a named handler', () => {
    expect(terminalResolver('  a: p.query(({ input }) => g(input)),')!.text).toBe(
      '({ input }) => g(input)'
    );
    expect(terminalResolver('  a: p\n    .use(m)\n    .query(myHandler),')!.text).toBe('myHandler');
  });

  it('callerAwareOptOut recognises a CONSTANT skip behind an identity guard (#4377)', () => {
    // The spelling the expression-only test was blind to. `skip: true` carries no
    // identity; the identity is in the early return that decides whether the skip is
    // reached. Verbatim shape of leaderboard.router.ts's skipEdgeCacheForModerators.
    const gatedSkip =
      'const modSkip = middleware(({ ctx, next }) => {\n' +
      '  if (!ctx.cache || !ctx.user?.isModerator) return next();\n' +
      '  return next({ ctx: { ...ctx, cache: { ...ctx.cache, skip: true } } });\n' +
      '});';
    expect(callerAwareOptOut('.use(modSkip)', gatedSkip)).toBe(
      'modSkip (skip gated on ctx identity)'
    );

    // NEGATIVE CONTROL, and the one that matters: identity present in the body but NOT
    // in any condition, with the skip taken from the input. A body-wide identity test
    // would exempt this, dropping a caller-varying procedure out of the ledger — the
    // failure direction that loses coverage silently. It must stay null.
    const logsIdentity =
      'const noisySkip = middleware(({ input, ctx, next }) => {\n' +
      '  logger.info({ userId: ctx.user?.id });\n' +
      '  return next({ ctx: { ...ctx, cache: { ...ctx.cache, skip: input.favorites } } });\n' +
      '});';
    expect(callerAwareOptOut('.use(noisySkip)', logsIdentity)).toBe(null);

    // A guard on something that is NOT identity is not an opt-out either.
    const inputGuard =
      'const inputSkip = middleware(({ input, next }) => {\n' +
      '  if (!input.favorites) return next();\n' +
      '  return next({ ctx: { cache: { skip: true } } });\n' +
      '});';
    expect(callerAwareOptOut('.use(inputSkip)', inputGuard)).toBe(null);
  });

  it('the real leaderboard router is derived as opted-out, not as risky', () => {
    // Binds the unit above to the live tree: if #4377's middleware is removed or
    // renamed, this fails here rather than silently re-listing the procedure.
    const content = readFileSync(join(SRC, 'server/routers/leaderboard.router.ts'), 'utf8');
    const derived = deriveEdgeCachedProcedures().all.find(
      (d) => d.path === 'leaderboard.getLeaderboard'
    );
    expect(content).toContain('skipEdgeCacheForModerators');
    expect({ found: !!derived, optOut: derived?.optOut }).toEqual({
      found: true,
      optOut: 'skipEdgeCacheForModerators (skip gated on ctx identity)',
    });
  });

  it('callerAwareOptOut recognises all three spellings and rejects an input-derived skip', () => {
    expect(callerAwareOptOut('.use(noEdgeCache({ authedOnly: true }))', '')).toBe(
      'noEdgeCache({authedOnly})'
    );
    expect(callerAwareOptOut('.use(noEdgeCache())', '')).toBe('noEdgeCache()');
    // POSITIVE: a local middleware whose `skip` comes from ctx identity IS an opt-out…
    const identitySkip =
      'const mySkip = middleware(async ({ ctx, next }) => next({ ctx: { cache: { ...ctx.cache, skip: !!ctx.user } } }));';
    expect(callerAwareOptOut('.use(mySkip)', identitySkip)).toBe('mySkip (skip from ctx identity)');
    // NEGATIVE: …and one whose `skip` comes from the INPUT is not (this is the live
    // shape in model.router.ts, and treating it as an opt-out would exempt model.getAll).
    const inputSkip =
      'const inSkip = middleware(async ({ input, ctx, next }) => next({ ctx: { cache: { ...ctx.cache, skip: input.favorites } } }));';
    expect(callerAwareOptOut('.use(inSkip)', inputSkip)).toBe(null);
    expect(callerAwareOptOut('.use(unrelated)', '')).toBe(null);
  });

  it('analyzeIdentityUse separates a forward from a direct use', () => {
    const fwd = 'const r = await getThing({ ...input, user: ctx.user });';
    expect(analyzeIdentityUse(fwd)).toEqual({
      forwards: [{ callee: 'getThing', prop: 'user', expr: 'ctx.user' }],
      directUses: 0,
    });
    const direct = 'if (!ctx.user?.isModerator) out.secret = null;';
    expect(analyzeIdentityUse(direct)).toEqual({ forwards: [], directUses: 1 });
    const assigned = 'const slim = ctx.features.someFlag;';
    expect(analyzeIdentityUse(assigned).directUses).toBe(1);
    // Nothing at all: the zero must be reachable AND distinguishable from the above.
    expect(analyzeIdentityUse('return getThing(input);')).toEqual({ forwards: [], directUses: 0 });
  });

  it('calleeUsesProp distinguishes ignored / used / destructured-but-unused / unknown', () => {
    // Dropped at the boundary — the homeBlock shape.
    expect(
      calleeUsesProp('const f = async ({ id, domain }) => { return q(id, domain); }', 'user')
    ).toBe('ignores');
    // Destructured AND referenced.
    expect(
      calleeUsesProp(
        'const f = async ({ id, isModerator }) => { return q(id, isModerator); }',
        'isModerator'
      )
    ).toBe('uses');
    // Destructured and NEVER referenced — "binds" is not "uses"; the getUserCreator shape.
    expect(
      calleeUsesProp('const f = async ({ id, isModerator }) => { return q(id); }', 'isModerator')
    ).toBe('ignores');
    // Whole-object param, dotted access — the getLeaderboard shape.
    expect(
      calleeUsesProp('function f(input) { return q(input.id, input.isModerator); }', 'isModerator')
    ).toBe('uses');
    // Whole-object param, never dotted — the getLeaderboardLegends shape.
    expect(calleeUsesProp('function f(input) { return q(input.id); }', 'isModerator')).toBe(
      'ignores'
    );
    // 🔴 The same shape, but with an arrow callback sitting AFTER the identity use inside
    // a `function` body. A body-slicer that jumps to the first `=>` starts reading past
    // `input.isModerator` and returns 'ignores' for a function that plainly uses it. The
    // fixtures above cannot see that bug — none of them contains an arrow — which is why
    // this one is here and why it is written with the arrow LAST.
    expect(
      calleeUsesProp(
        'function f(input) { const q = raw(!input.isModerator ? "AND public" : ""); return rows.map((r) => r.id); }',
        'isModerator'
      )
    ).toBe('uses');
    // A rest element could still be carrying it: refuse to answer rather than guess.
    expect(calleeUsesProp('const f = async ({ id, ...rest }) => { return q(rest); }', 'user')).toBe(
      'unknown'
    );
    expect(calleeUsesProp('function f(input) { return q({ ...input }); }', 'isModerator')).toBe(
      'unknown'
    );
  });

  it('findFunctionSource captures the BODY, not just the parameter list', () => {
    // Regression: a scan that stops when brackets first balance ends at the closing
    // `)` of the annotated parameter list, so every controller handler reads as
    // identity-free and the whole guard passes vacuously.
    const file = join(SRC, 'server/controllers/home-block.controller.ts');
    const src = findFunctionSource(file, 'getHomeBlocksByIdHandler');
    expect(src).toBeTruthy();
    expect(src!).toContain('getHomeBlockById');
    expect(functionBody(src!)).toContain('getHomeBlockById');
  });

  it('findFunctionSource handles a `function` declaration, not just a const arrow', () => {
    // The const-arrow control above cannot see a bug in the OTHER pattern, and the
    // `calleeUsesProp` fixtures pass source text in directly so they skip this function
    // entirely. Both were green while every `function`-declared service read as
    // identity-free. `getLeaderboard` is the real-tree positive control: it plainly
    // branches on `input.isModerator`, so an 'ignores' here means the body was truncated.
    const file = join(SRC, 'server/services/leaderboard.service.ts');
    const src = findFunctionSource(file, 'getLeaderboard');
    expect(src).toBeTruthy();
    expect(functionBody(src!)).toContain('input.isModerator');
    expect(calleeUsesProp(src!, 'isModerator')).toBe('uses');
    // NEGATIVE control in the same file: its sibling takes the same object and does not
    // read that field, so a parse that simply matched everything would fail here.
    const legends = findFunctionSource(file, 'getLeaderboardLegends');
    expect(legends).toBeTruthy();
    expect(calleeUsesProp(legends!, 'isModerator')).toBe('ignores');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The derivation, over the real tree
// ─────────────────────────────────────────────────────────────────────────────

describe('edgeCacheIt derivation', () => {
  const { all, missingKey } = deriveEdgeCachedProcedures();

  it('resolves every edgeCacheIt router to an appRouter key', () => {
    // Otherwise a whole router is silently unexamined.
    expect(missingKey).toEqual([]);
  });

  it('derives a non-empty, plausible set', () => {
    expect(all.length).toBeGreaterThan(20);
    const paths = all.map((d) => d.path);
    expect(paths).toContain('user.getCreator');
    expect(paths).toContain('homeBlock.getHomeBlock');
    // The alias case: invisible to a plain `edgeCacheIt(`-in-block substring test.
    expect(paths).toContain('leaderboard.getLeaderboard');
    expect(new Set(paths).size).toBe(paths.length); // no duplicates
  });

  it('does NOT derive a procedure whose edgeCacheIt is commented out', () => {
    // Negative-control fixtures that live in the tree. Both files DO contain the
    // literal text; neither procedure applies the middleware.
    for (const [file, path] of [
      ['image.router.ts', 'image.getGenerationData'],
      ['event.router.ts', 'event.getData'],
    ] as const) {
      const raw = readFileSync(join(ROUTERS_DIR, file), 'utf8');
      expect(raw.includes('edgeCacheIt(')).toBe(true); // the words are there…
      expect(all.map((d) => d.path)).not.toContain(path); // …but not applied
    }
    // POSITIVE control for the pair: the comment-aware strip must not have stopped
    // seeing edgeCacheIt in those files altogether, which would make the two
    // assertions above pass for the wrong reason.
    expect(all.map((d) => d.path)).toContain('image.getResources');
    expect(all.map((d) => d.path)).toContain('event.getTeamScores');
  });

  it('cross-checks the derived count against an independent whole-file parse', () => {
    // Second, differently-built parse: count `.use(` applications of edgeCacheIt (or a
    // hoisted alias) across all router files WITHOUT the procedure-block splitter, so a
    // bug in `procedureBlocks` cannot hide behind itself. A grep for `edgeCacheIt(` is
    // NOT this number — it counts the alias definition and every commented-out call.
    let applications = 0;
    let rawTextualHits = 0;
    for (const file of readdirSync(ROUTERS_DIR)) {
      if (!file.endsWith('.router.ts')) continue;
      rawTextualHits += (
        readFileSync(join(ROUTERS_DIR, file), 'utf8').match(/edgeCacheIt\(/g) ?? []
      ).length;
      const content = readSource(join(ROUTERS_DIR, file));
      // One regex only: `\s*` already spans newlines, so adding a second
      // newline-specific pattern double-counts every multi-line application.
      applications += (content.match(/\.use\(\s*edgeCacheIt\(/g) ?? []).length;
      for (const alias of edgeCacheAliases(content)) {
        applications += (content.match(new RegExp(`\\.use\\(\\s*${alias}\\s*\\)`, 'g')) ?? [])
          .length;
      }
    }
    // The raw text over-counts (commented-out calls + the hoisted alias definition);
    // report it so a future reader can see the gap rather than trusting one number.
    expect(rawTextualHits).toBeGreaterThan(applications);
    expect(applications).toBe(all.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The relationship + the ledger
// ─────────────────────────────────────────────────────────────────────────────

describe('an edge-cached procedure must not vary its body by caller', () => {
  const { all } = deriveEdgeCachedProcedures();
  const risky = all.filter(isRisky);

  it('finds a non-empty risky set (the guard is not wired to nothing)', () => {
    // A reassuring zero here would be indistinguishable from a broken derivation.
    expect(risky.length).toBeGreaterThan(0);
    // …and a non-empty CLEAN set, or the identity detector is matching everything.
    expect(all.length - risky.length).toBeGreaterThan(0);
  });

  it('every wrapped, identity-reaching, non-opted-out procedure is in the ledger', () => {
    const unledgered = risky.filter((d) => !LEDGER[d.path]).map((d) => d.path);
    expect(unledgered).toEqual([]);
  });

  it('no ledger entry is stale (the ledger fails when it SHRINKS too)', () => {
    const riskyPaths = new Set(risky.map((d) => d.path));
    const stale = Object.keys(LEDGER).filter((p) => !riskyPaths.has(p));
    expect(stale).toEqual([]);
  });

  it('each ledger entry’s recorded facts still hold', () => {
    for (const d of risky) {
      const entry = LEDGER[d.path];
      if (!entry) continue;
      expect({ path: d.path, identity: d.identity }).toEqual({
        path: d.path,
        identity: entry.identity,
      });
      expect({ path: d.path, forwards: fmtForwards(d) }).toEqual({
        path: d.path,
        forwards: [...entry.forwards].sort(),
      });
      expect({ path: d.path, directUses: d.directUses }).toEqual({
        path: d.path,
        directUses: entry.directUses,
      });
    }
  });

  it('a ‘callee-ignores-identity’ entry really is one', () => {
    // The load-bearing assertion. These entries are the ones whose safety is an
    // ACCIDENT — a service function that drops an identity value it is handed. Bind
    // it and this must go red, which is the whole reason this file exists.
    for (const [path, entry] of Object.entries(LEDGER)) {
      if (entry.status !== 'callee-ignores-identity') continue;
      const d = all.find((x) => x.path === path);
      expect(
        d,
        `${path} is ledgered as callee-ignores-identity but is no longer derived`
      ).toBeTruthy();
      expect(
        { path, directUses: d!.directUses },
        `${path} claims its identity is only forwarded, but the resolver uses identity directly`
      ).toEqual({ path, directUses: 0 });
      expect(
        d!.forwards.length,
        `${path} claims a callee ignores identity but forwards none`
      ).toBeGreaterThan(0);
      for (const fw of d!.forwards) {
        expect(
          { path, callee: fw.callee, prop: fw.prop, resolved: fw.resolved, verdict: fw.verdict },
          `${path}: ${fw.callee} must be resolvable and must IGNORE the ${fw.prop} it is handed — ` +
            `if it now uses it, this procedure serves one caller’s body to another and the ` +
            `entry can no longer claim safety`
        ).toEqual({ path, callee: fw.callee, prop: fw.prop, resolved: true, verdict: 'ignores' });
      }
    }
  });

  it('every ‘accepted-variance’ entry states why and how it closes', () => {
    // Not a safety claim — so the mechanical requirement is that it carries a closing
    // condition, per the repo rule against filing an object nobody can close.
    for (const [path, entry] of Object.entries(LEDGER)) {
      if (entry.status !== 'accepted-variance') continue;
      expect({ path, hasWhy: entry.why.length > 40 }).toEqual({ path, hasWhy: true });
      expect({ path, hasCloses: entry.closes.length > 40 }).toEqual({ path, hasCloses: true });
    }
  });

  it('at least one entry of each status exists (both branches are reachable)', () => {
    const statuses = new Set(Object.values(LEDGER).map((e) => e.status));
    expect([...statuses].sort()).toEqual(['accepted-variance', 'callee-ignores-identity']);
  });
});
