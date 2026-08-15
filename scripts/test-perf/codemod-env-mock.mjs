#!/usr/bin/env node
/**
 * Codemod: `vi.mock('~/env/server', …)` -> the canonical env mock.
 *
 * A separate transform from codemod-shared-mocks.mjs on purpose. That one converts CALL
 * SURFACES: it binds a vivifying node so a spy identity survives, and the value at the leaf
 * is irrelevant. `~/env/server` is a VALUE TABLE, and the two rules have nothing in common —
 * auto-vivifying `env.TRPC_ORIGINS` would satisfy no consumer and fail differently in each.
 *
 * 🔴 The classification and the rewrite are ONE PASS, deliberately.
 *
 * `--dry` prints exactly the decisions `--write` will act on, from the same analysis of the
 * same bytes. An earlier version of this work predicted from one script and rewrote with
 * another, and the two agreed on only 11 of 24 files while their TOTALS looked two apart —
 * the comparison was measuring edits to the tooling, not the tooling's accuracy. Keep the two
 * modes reading one code path; a prediction produced by different code is not a prediction.
 *
 *   node scripts/test-perf/codemod-env-mock.mjs --dry
 *   node scripts/test-perf/codemod-env-mock.mjs --dry --report .test-perf/env-plan.json
 *   node scripts/test-perf/codemod-env-mock.mjs --write --list <file-of-paths>
 */
import { readFileSync, writeFileSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const write = argv.includes('--write');
const reportPath = argv.includes('--report') ? argv[argv.indexOf('--report') + 1] : null;
const listPath = argv.includes('--list') ? argv[argv.indexOf('--list') + 1] : null;

const SPEC = '~/env/server';
const CANON = '~/__tests__/mocks/env.mock';

// ---------------------------------------------------------------- the canonical defaults
// Parsed out of env.mock.ts rather than restated, so this cannot drift from the thing it
// compares against — which is the exact failure the LOGGING and REDIS_KEYS findings were.
function loadDefaults() {
  const src = readFileSync(path.join(repoRoot, 'src/__tests__/mocks/env.mock.ts'), 'utf8');
  const start = src.indexOf('export const TEST_ENV_DEFAULTS');
  if (start === -1) throw new Error('TEST_ENV_DEFAULTS not found in env.mock.ts');
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) {
      const body = src.slice(open, i + 1).replace(/\bas\s+[A-Za-z<>[\]]+/g, '');
      return new Function(`return (${body})`)();
    }
  }
  throw new Error('unterminated TEST_ENV_DEFAULTS');
}

// ------------------------------------------------------------------- module-scope reads
// Which env keys does PRODUCTION read at import time? Those cannot be varied per file — see
// the KNOWN LIMIT in env.mock.ts — so a per-file setEnv() for one of them is a silent no-op.
//
// 🔴 Parsed, not pattern-matched. Two hand-rolled brace-depth heuristics for this same
// question disagreed by nearly 2x on the same tree (73 keys against 127) purely on where the
// "is this brace a function body" regex was anchored, and there is no way to tell from the
// outputs which one is lying. The whole refusal list hangs on this answer, so it has to be a
// real scope walk.
function moduleScopeReads(ts, src, fileName) {
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true);
  const keys = new Set();
  const isFunctionLike = (n) =>
    ts.isFunctionDeclaration(n) ||
    ts.isFunctionExpression(n) ||
    ts.isArrowFunction(n) ||
    ts.isMethodDeclaration(n) ||
    ts.isGetAccessor(n) ||
    ts.isSetAccessor(n) ||
    ts.isConstructorDeclaration(n) ||
    ts.isClassStaticBlockDeclaration(n);

  const visit = (node, insideFunction) => {
    if (
      !insideFunction &&
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'env' &&
      /^[A-Z][A-Z0-9_]*$/.test(node.name.text)
    ) {
      keys.add(node.name.text);
    }
    ts.forEachChild(node, (child) => visit(child, insideFunction || isFunctionLike(node)));
  };
  ts.forEachChild(sf, (n) => visit(n, false));
  return keys;
}

// ------------------------------------------------------------------------- test scanning
function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.next') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p.split(path.sep).join('/'));
  }
  return out;
}

/** The whole `vi.mock(…)` statement, plus the trailing semicolon and one blank line. */
function mockStatement(src) {
  const idx = src.search(new RegExp(`vi\\.mock\\(\\s*['"]${SPEC.replace('/', '\\/')}['"]`));
  if (idx === -1) return null;
  const open = src.indexOf('(', idx);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) {
      let end = i + 1;
      if (src[end] === ';') end++;
      if (src[end] === '\n') end++;
      return { text: src.slice(idx, i + 1), from: idx, to: end };
    }
  }
  return null;
}

/**
 * Every key the mock declares, in BOTH shapes. The literal shape is obvious; the Proxy shape
 * (`if (prop === 'IS_BUILD') return true`) has no `KEY:` token at all, and a literal-only scan
 * reports ZERO keys for it — which is how seven `IS_BUILD` sites went missing from an earlier
 * count. Returns null when a value cannot be evaluated, so the caller refuses rather than
 * assuming.
 */
function declaredKeys(text) {
  const found = new Map();
  let evaluable = true;
  const record = (key, raw) => {
    const clean = raw
      .trim()
      .replace(/\s+as\s+.*$/, '')
      .replace(/[;,]$/, '');
    try {
      found.set(key, { value: new Function(`return (${clean})`)(), raw: clean });
    } catch {
      evaluable = false;
      found.set(key, { value: undefined, raw: clean, unevaluable: true });
    }
  };
  for (const m of text.matchAll(/(?:^|[{,\s])([A-Z][A-Z0-9_]{2,})\s*:\s*([^,\n}]+)/g))
    record(m[1], m[2]);
  for (const m of text.matchAll(
    /prop\s*===\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\)?\s*return\s+([^;\n]+)/g
  ))
    record(m[1], m[2]);
  return { keys: found, evaluable };
}

/**
 * `vi.mock('~/env/server', () => ({ env: mockEnv }))` — the table lives in a local, so the
 * mock call itself declares nothing and a literal scan reports zero keys. Nineteen of the
 * twenty-five sites that scan gave up on are this, in four spellings.
 *
 * Resolve the local to its object literal and hand that back to be classified normally. Only
 * a literal is accepted: if the object contains an identifier, a call, or a spread, refuse.
 * That guard is what keeps this clear of the scope trap jessica hit — a resolver that reads a
 * value without checking what the value REFERS to can lift an expression whose names do not
 * exist at the destination, and the file then throws at import and collects zero while the
 * summary reports one failed suite and no failing tests. Values that survive this check are
 * re-emitted as JSON, so there is nothing left to refer to.
 */
function resolveEnvLocal(src, ident) {
  const patterns = [
    new RegExp(`const\\s*\\{[^}]*\\b${ident}\\b[^}]*\\}\\s*=\\s*vi\\.hoisted\\s*\\(`),
    new RegExp(`const\\s+${ident}\\s*=\\s*vi\\.hoisted\\s*\\(`),
    new RegExp(`const\\s+${ident}\\s*(?::[^=]+)?=\\s*(?=\\{)`),
  ];
  for (const re of patterns) {
    const m = re.exec(src);
    if (!m) continue;
    // For a hoisted form, the table is the property named `ident` inside the returned object.
    const from = m.index + m[0].length;
    const search = /vi\.hoisted/.test(m[0]) ? new RegExp(`\\b${ident}\\s*:\\s*(?=\\{)`) : null;
    let open = src.indexOf('{', from);
    if (search) {
      const inner = search.exec(src.slice(from));
      if (!inner) continue;
      open = src.indexOf('{', from + inner.index + inner[0].length - 1);
    }
    if (open === -1) continue;
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
    }
  }
  return null;
}

/**
 * True when every value in the literal is a plain JSON-ish literal — no names to carry.
 *
 * Order matters: strip the string literals FIRST, then the property keys, and only then look
 * for identifiers. Checking before stripping strings rejects `'https://civitai.test'` as a
 * reference because a URL is full of lowercase words, which silently refused 15 of 19 sites
 * that were in fact perfectly self-contained.
 */
function isSelfContained(literal) {
  const values = literal
    .replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "''")
    .replace(/([A-Za-z_$][\w$]*)\s*:/g, ':');
  return (
    !/\.{3}|=>|\bfunction\b|\w\s*\(/.test(values) &&
    !/\b(?!true|false|null|undefined|Infinity|NaN)[A-Za-z_$][\w$]*\b/.test(values)
  );
}

// ------------------------------------------------------------------------------ the pass
function classify(file, src, defaults, moduleScopeKeys) {
  const st = mockStatement(src);
  if (!st) return null;

  if (/importOriginal/.test(st.text))
    return { file, action: 'refuse', reason: 'importOriginal spread' };
  if (/vi\.fn|vi\.hoisted/.test(st.text))
    return {
      file,
      action: 'refuse',
      reason: 'factory contains a spy — env is a value table, so this is doing something else too',
    };

  let { keys } = declaredKeys(st.text);
  if (!keys.size) {
    const ident = (/env:\s*new Proxy\(\s*([A-Za-z_$][\w$]*)/.exec(st.text) ??
      /env:\s*([A-Za-z_$][\w$]*)\s*[,}]/.exec(st.text))?.[1];
    if (!ident) return { file, action: 'refuse', reason: 'no keys found — read by hand' };
    const literal = ident && resolveEnvLocal(src, ident);
    if (!literal)
      return { file, action: 'refuse', reason: `could not resolve the env table local "${ident}"` };
    if (!isSelfContained(literal))
      return {
        file,
        action: 'refuse',
        reason: `env table local "${ident}" is not a self-contained literal`,
      };
    keys = declaredKeys(literal).keys;
    if (!keys.size)
      return { file, action: 'refuse', reason: `env table local "${ident}" declares no keys` };
  }

  const unevaluable = [...keys].filter(([, v]) => v.unevaluable).map(([k]) => k);
  if (unevaluable.length)
    return {
      file,
      action: 'refuse',
      reason: `value not statically evaluable: ${unevaluable.join(', ')}`,
    };

  const redundant = [];
  const overrides = [];
  const blocked = [];
  for (const [key, { value }] of keys) {
    if (JSON.stringify(value) === JSON.stringify(defaults[key])) redundant.push(key);
    else if (moduleScopeKeys.has(key)) blocked.push(key);
    else overrides.push([key, value]);
  }

  if (blocked.length)
    return {
      file,
      action: 'refuse',
      reason: `read at module scope in production, so a per-file override is a silent no-op: ${blocked.join(
        ', '
      )}`,
      blocked,
    };
  if (!overrides.length) return { file, action: 'drop', redundant, st };
  return { file, action: 'setEnv', overrides, redundant, st };
}

function apply(src, plan) {
  if (plan.action === 'drop') return src.slice(0, plan.st.from) + src.slice(plan.st.to);
  // setEnv: replace the mock with a beforeEach that layers the non-default values.
  const body = plan.overrides.map(([k, v]) => `  ${k}: ${JSON.stringify(v)},`).join('\n');
  const call = `beforeEach(() => {\n  setEnv({\n${body}\n  });\n});\n`;
  let out = src.slice(0, plan.st.from) + call + src.slice(plan.st.to);
  if (!new RegExp(`from '${CANON}'`).test(out)) {
    const firstImport = out.search(/^import .*$/m);
    const line = `import { setEnv } from '${CANON}';\n`;
    out =
      firstImport === -1 ? line + out : out.slice(0, firstImport) + line + out.slice(firstImport);
  }
  if (!/\bbeforeEach\b[^\n]*from 'vitest'/.test(out) && /from 'vitest'/.test(out))
    out = out.replace(/import \{([^}]*)\} from 'vitest'/, (m, g) =>
      /\bbeforeEach\b/.test(g) ? m : `import {${g.replace(/\s*$/, '')}, beforeEach } from 'vitest'`
    );
  return out;
}

function main() {
  const ts = createRequire(import.meta.url)('typescript');
  const defaults = loadDefaults();

  const prod = walk(path.join(repoRoot, 'src')).filter(
    (f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && !f.includes('__tests__')
  );
  const moduleScopeKeys = new Set();
  for (const f of prod) {
    const src = readFileSync(f, 'utf8');
    if (src.includes('env.')) for (const k of moduleScopeReads(ts, src, f)) moduleScopeKeys.add(k);
  }

  const only = listPath
    ? new Set(
        readFileSync(path.resolve(repoRoot, listPath), 'utf8')
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)
      )
    : null;

  const tests = walk(path.join(repoRoot, 'src')).filter((f) => /\.test\.tsx?$/.test(f));
  const plans = [];
  for (const abs of tests) {
    const rel = path.relative(repoRoot, abs).split(path.sep).join('/');
    if (only && !only.has(rel)) continue;
    const src = readFileSync(abs, 'utf8');
    if (!src.includes(SPEC)) continue;
    const plan = classify(rel, src, defaults, moduleScopeKeys);
    if (!plan) continue;
    plans.push(plan);
    if (write && plan.action !== 'refuse') writeFileSync(abs, apply(src, plan));
  }

  const by = (a) => plans.filter((p) => p.action === a);
  console.log(
    `${write ? 'WROTE' : 'DRY'} — ${plans.length} sites, ${
      moduleScopeKeys.size
    } module-scope keys\n`
  );
  console.log(`  drop   (every declared key already the canonical default) : ${by('drop').length}`);
  console.log(
    `  setEnv (non-default values, none read at module scope)    : ${by('setEnv').length}`
  );
  console.log(
    `  refuse                                                    : ${by('refuse').length}`
  );
  console.log('');
  const reasons = {};
  for (const p of by('refuse')) {
    const k = p.reason.replace(/: .*/, '');
    (reasons[k] ??= []).push(p.file);
  }
  for (const [k, fl] of Object.entries(reasons).sort((a, b) => b[1].length - a[1].length))
    console.log(`  ${String(fl.length).padStart(4)}  ${k}`);

  if (reportPath) {
    writeFileSync(
      path.resolve(repoRoot, reportPath),
      JSON.stringify(
        plans.map(({ st, ...rest }) => rest),
        null,
        1
      )
    );
    console.log(`\nplan -> ${reportPath}`);
  }
}

main();
