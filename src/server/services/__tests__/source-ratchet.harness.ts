import { globSync, readFileSync, statSync } from 'fs';
import path from 'path';
import ts from 'typescript';

/**
 * Shared machinery for the source ratchets in this directory.
 *
 * A ratchet grandfathers the sites that exist today in a committed baseline and fails in BOTH
 * directions:
 *   - GROWN: a file not in the baseline, or a file whose count went up. That is a new site.
 *   - SHRUNK: a baselined file whose count went down, or which has none left. The code got
 *     better; lower the baseline in the same commit so the headroom cannot be spent later.
 * An exact baseline is also what keeps the detector honest: if it silently stops matching, every
 * baselined file reads as SHRUNK and the test goes red instead of reporting a clean repo.
 *
 * Detection is on the TypeScript AST, not on text: a name in a comment or a string is not a call
 * and never counts. Files are pre-filtered on a cheap substring before parsing.
 */

export const REPO_ROOT = path.resolve(__dirname, '../../../..');

const TEST_FILE = /(^|\/)__(tests|mocks)__\/|^src\/tests\/|\.(test|spec)\.tsx?$|\.d\.ts$/;
// Gitignored dev-only trees (see .gitignore): present on a laptop, never in CI, so counting them
// would make a local run disagree with CI.
const LOCAL_ONLY = /^src\/local\/|^src\/pages\/api\/dev-local\//;

/** Production source files (no tests, no declaration files) under the given globs, repo-relative. */
export function productionSources(globs: string[], exempt: string[] = []): string[] {
  const out = new Set<string>();
  for (const g of globs) {
    for (const rel of globSync(g, { cwd: REPO_ROOT })) {
      // Node's glob joins with the platform separator; baselines are written with `/`.
      const file = rel.replace(/\\/g, '/');
      if (TEST_FILE.test(file) || LOCAL_ONLY.test(file) || exempt.includes(file)) continue;
      if (!statSync(path.join(REPO_ROOT, file), { throwIfNoEntry: false })?.isFile()) continue;
      out.add(file);
    }
  }
  return [...out].sort();
}

export function readSource(file: string): string {
  return readFileSync(path.join(REPO_ROOT, file), 'utf8');
}

export function parse(fileName: string, text: string): ts.SourceFile {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
}

export function walk(node: ts.Node, visit: (n: ts.Node) => void) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

/** Strip parens, `as`, `!` and `satisfies` so `(sysRedis as any).expire` still reads as sysRedis. */
export function unwrap(node: ts.Expression): ts.Expression {
  let n = node;
  for (;;) {
    if (ts.isParenthesizedExpression(n) || ts.isNonNullExpression(n)) n = n.expression;
    else if (ts.isAsExpression(n) || ts.isSatisfiesExpression(n)) n = n.expression;
    else if (ts.isTypeAssertionExpression(n)) n = n.expression;
    else return n;
  }
}

/** The member name of `a.b` / `a?.b` / `a['b']`, or undefined. */
export function memberName(node: ts.Node): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression))
    return node.argumentExpression.text;
  return undefined;
}

export function memberObject(node: ts.Node): ts.Expression | undefined {
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
    return node.expression;
  return undefined;
}

export type Counts = Record<string, number>;

export function countAll(
  files: string[],
  prefilter: string | string[],
  count: (sf: ts.SourceFile, text: string) => number
): Counts {
  const needles = typeof prefilter === 'string' ? [prefilter] : prefilter;
  const out: Counts = {};
  for (const file of files) {
    const text = readSource(file);
    if (!needles.some((needle) => text.includes(needle))) continue;
    const n = count(parse(file, text), text);
    if (n > 0) out[file] = n;
  }
  return out;
}

export type RatchetDiff = { grown: string[]; shrunk: string[] };

/** Compare a measured per-file count against its baseline; each line names file, baseline and now. */
export function diffCounts(current: Counts, baseline: Counts): RatchetDiff {
  const grown: string[] = [];
  const shrunk: string[] = [];
  const files = new Set([...Object.keys(current), ...Object.keys(baseline)]);
  for (const file of [...files].sort()) {
    const now = current[file] ?? 0;
    const was = baseline[file] ?? 0;
    if (now > was) grown.push(`${file}: baseline ${was}, now ${now}`);
    else if (now < was) shrunk.push(`${file}: baseline ${was}, now ${now}`);
  }
  return { grown, shrunk };
}

export function total(counts: Counts): number {
  return Object.values(counts).reduce((a, b) => a + b, 0);
}

/** A baseline literal, printed so a shrink can be applied by pasting. */
export function formatBaseline(counts: Counts): string {
  return Object.keys(counts)
    .sort()
    .map((f) => `  '${f}': ${counts[f]},`)
    .join('\n');
}

// ── sysRedis ────────────────────────────────────────────────────────────────────────────────

export const SYS_REDIS_NAMES = ['sysRedis', 'REDIS_SYS_KEYS'] as const;

/** 1 when the file names `sysRedis` or `REDIS_SYS_KEYS` as an identifier (import or use), else 0. */
export function sysRedisConsumer(sf: ts.SourceFile): number {
  let hit = false;
  walk(sf, (n) => {
    if (ts.isIdentifier(n) && (SYS_REDIS_NAMES as readonly string[]).includes(n.text)) hit = true;
  });
  return hit ? 1 : 0;
}

/**
 * Methods that put a TTL on a key, compared lower-cased (node-redis accepts both `expire` and
 * `EXPIRE`). `set` is handled separately: it counts only when its options carry a TTL.
 */
export const TTL_METHODS = new Set([
  'expire',
  'pexpire',
  'expireat',
  'pexpireat',
  'setex',
  'psetex',
  'getex',
  'hexpire',
  'hpexpire',
  'hexpireat',
  'hpexpireat',
  'setnxkeepttlwithex',
  'hsetmultiwithexpire',
]);
const TTL_OPTION_KEYS = new Set(['EX', 'PX', 'EXAT', 'PXAT', 'expiration']);

/**
 * Does this expression evaluate to the sys client, or something built from it (`.packed`, a
 * `.multi()` pipeline, a step of a chained pipeline), or a local bound to one of those?
 */
function rootsAtSysRedis(expr: ts.Expression, aliases: Set<string>): boolean {
  const e = unwrap(expr);
  if (ts.isIdentifier(e)) return e.text === 'sysRedis' || aliases.has(e.text);
  if (ts.isCallExpression(e)) return rootsAtSysRedis(e.expression, aliases);
  const obj = memberObject(e);
  return obj ? rootsAtSysRedis(obj, aliases) : false;
}

/** Locals initialised from the sys client (`const tx = sysRedis.multi()`), to a fixed point. */
function sysRedisAliases(sf: ts.SourceFile): Set<string> {
  const aliases = new Set<string>();
  for (let grew = true; grew; ) {
    grew = false;
    walk(sf, (n) => {
      if (
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.initializer &&
        !aliases.has(n.name.text) &&
        rootsAtSysRedis(n.initializer, aliases)
      ) {
        aliases.add(n.name.text);
        grew = true;
      }
    });
  }
  return aliases;
}

function setCarriesTtl(call: ts.CallExpression): boolean {
  const opts = call.arguments[2];
  if (!opts) return false;
  const o = unwrap(opts);
  // An options value we cannot read (a variable, a call, a spread) counts: fail closed.
  if (!ts.isObjectLiteralExpression(o)) return true;
  return o.properties.some((p) => {
    if (ts.isSpreadAssignment(p)) return true;
    const name =
      p.name && (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name))
        ? p.name.text
        : undefined;
    return !!name && TTL_OPTION_KEYS.has(name);
  });
}

/** TTL'd writes on the sys client: `set` with EX/PX/EXAT/PXAT, `expire`, `setEx`, … */
export function ttlSysRedisWrites(
  sf: ts.SourceFile,
  onHit?: (call: ts.CallExpression, method: string) => void
): number {
  const aliases = sysRedisAliases(sf);
  let n = 0;
  walk(sf, (node) => {
    if (!ts.isCallExpression(node)) return;
    const callee = unwrap(node.expression);
    const method = memberName(callee);
    const obj = memberObject(callee);
    if (!method || !obj || !rootsAtSysRedis(obj, aliases)) return;
    const m = method.toLowerCase();
    if (TTL_METHODS.has(m) || (m === 'set' && setCarriesTtl(node))) {
      n += 1;
      onHit?.(node, m);
    }
  });
  return n;
}

// ── AbortSignal.timeout ─────────────────────────────────────────────────────────────────────

/** `AbortSignal.timeout(…)` calls, including `globalThis.AbortSignal.timeout(…)`. */
export function rawAbortTimeouts(sf: ts.SourceFile): number {
  let n = 0;
  walk(sf, (node) => {
    if (!ts.isCallExpression(node)) return;
    const callee = unwrap(node.expression);
    if (memberName(callee) !== 'timeout') return;
    const obj = unwrap(memberObject(callee)!);
    if ((ts.isIdentifier(obj) && obj.text === 'AbortSignal') || memberName(obj) === 'AbortSignal')
      n += 1;
  });
  return n;
}

// ── dbWrite reads ───────────────────────────────────────────────────────────────────────────

export const PRISMA_READS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
]);

/** `// primary: <reason>` — the reason must be non-empty. */
export const PRIMARY_MARK = /\/\/\s*primary:\s*\S/;

/**
 * Is the read at `pos` marked? The mark sits on the read's own line, or in the run of `//` comment
 * lines directly above it.
 */
export function hasPrimaryMark(text: string, sf: ts.SourceFile, pos: number): boolean {
  const lines = text.split('\n');
  let line = sf.getLineAndCharacterOfPosition(pos).line;
  if (PRIMARY_MARK.test(lines[line])) return true;
  for (line -= 1; line >= 0 && /^\s*\/\//.test(lines[line]); line -= 1) {
    if (PRIMARY_MARK.test(lines[line])) return true;
  }
  return false;
}

/** Unmarked `dbWrite.<model>.find*|count|aggregate|groupBy(…)` reads. */
export function unmarkedPrimaryReads(sf: ts.SourceFile, text: string): number {
  let n = 0;
  walk(sf, (node) => {
    if (!ts.isCallExpression(node)) return;
    const callee = unwrap(node.expression);
    const method = memberName(callee);
    if (!method || !PRISMA_READS.has(method)) return;
    const model = unwrap(memberObject(callee)!);
    const client = memberObject(model);
    if (!client) return;
    const c = unwrap(client);
    if (!ts.isIdentifier(c) || c.text !== 'dbWrite') return;
    if (!hasPrimaryMark(text, sf, c.getStart(sf))) n += 1;
  });
  return n;
}

// ── Feature flags registered twice ──────────────────────────────────────────────────────────

export const FLIPT_ENUM_FILE = 'src/server/flipt/client.ts';
export const FEATURE_FLAGS_FILE = 'src/server/services/feature-flags.service.ts';

/** Member name → key of `enum FLIPT_FEATURE_FLAGS`. A member we cannot read is a key in `unread`. */
export function fliptEnumKeys(text: string) {
  const sf = parse(FLIPT_ENUM_FILE, text);
  const keys = new Map<string, string>();
  const unread: string[] = [];
  let found = false;
  walk(sf, (n) => {
    if (!ts.isEnumDeclaration(n) || n.name.text !== 'FLIPT_FEATURE_FLAGS') return;
    found = true;
    for (const m of n.members) {
      const name = m.name.getText(sf);
      if (m.initializer && ts.isStringLiteralLike(m.initializer))
        keys.set(name, m.initializer.text);
      else unread.push(name);
    }
  });
  return { found, keys, unread };
}

/**
 * Every `fliptKey:` value in feature-flags.service.ts, resolved to its string. A value may be a
 * literal, `FLIPT_FEATURE_FLAGS.X`, or an imported `export const X = '…'`. Anything else is
 * returned in `unresolved`, so a new value shape turns the guard red instead of hiding a key.
 * Only `fliptKey: <value>` properties are read; `{ fliptKey }` shorthand and a quoted
 * `'fliptKey':` name are not.
 */
export function fliptKeysOfFeatureFlags(text: string, enumKeys: Map<string, string>) {
  const sf = parse(FEATURE_FLAGS_FILE, text);
  const imports = new Map<string, string>();
  walk(sf, (n) => {
    if (!ts.isImportDeclaration(n) || !ts.isStringLiteral(n.moduleSpecifier)) return;
    const bindings = n.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) return;
    for (const el of bindings.elements)
      imports.set(el.name.text, (el.propertyName ?? el.name).text + '@' + n.moduleSpecifier.text);
  });
  const resolveImported = (local: string): string | undefined => {
    const ref = imports.get(local);
    if (!ref) return undefined;
    const [exported, spec] = ref.split('@');
    if (!spec.startsWith('~/')) return undefined;
    const base = path.join(REPO_ROOT, 'src', spec.slice(2));
    for (const file of [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
      if (!statSync(file, { throwIfNoEntry: false })?.isFile()) continue;
      const other = parse(file, readFileSync(file, 'utf8'));
      let value: string | undefined;
      walk(other, (n) => {
        if (
          ts.isVariableDeclaration(n) &&
          ts.isIdentifier(n.name) &&
          n.name.text === exported &&
          n.initializer &&
          ts.isStringLiteralLike(unwrap(n.initializer))
        )
          value = (unwrap(n.initializer) as ts.StringLiteralLike).text;
      });
      return value;
    }
    return undefined;
  };

  const keys: string[] = [];
  const unresolved: string[] = [];
  walk(sf, (n) => {
    if (!ts.isPropertyAssignment(n) || n.name.getText(sf) !== 'fliptKey') return;
    const v = unwrap(n.initializer);
    let key: string | undefined;
    if (ts.isStringLiteralLike(v)) key = v.text;
    else if (ts.isPropertyAccessExpression(v) && v.expression.getText(sf) === 'FLIPT_FEATURE_FLAGS')
      key = enumKeys.get(v.name.text);
    else if (ts.isIdentifier(v)) key = resolveImported(v.text);
    if (key === undefined) unresolved.push(v.getText(sf));
    else keys.push(key);
  });
  return { keys, unresolved };
}

/** Keys registered BOTH in the Flipt enum and as a `fliptKey`, sorted. */
export function dualRegisteredFlags(enumText: string, flagsText: string) {
  const e = fliptEnumKeys(enumText);
  const f = fliptKeysOfFeatureFlags(flagsText, e.keys);
  const enumValues = new Set(e.keys.values());
  const dual = [...new Set(f.keys.filter((k) => enumValues.has(k)))].sort();
  return { dual, enum: e, flags: f };
}
