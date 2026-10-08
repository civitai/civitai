import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * SOURCE GATE: the call-site ledger for storage-resolver attribution.
 *
 * Every `resolveDownloadUrl(...)` call, and every `getFileForModelVersion(...)`
 * call (which resolves on its caller's behalf), must name a `caller` literal and
 * an `actor`. This pins the full file → [caller|actor] map, so it fails when a
 * call site is ADDED (a new resolve path nobody attributed), REMOVED, or
 * RE-POINTED at a different caller.
 *
 * The type system already refuses a call that omits the attribution; this ledger
 * is what catches a call that supplies the WRONG one, e.g. a copy-pasted
 * `caller: 'vault'` on a new path.
 *
 * The expected table is hand-typed, not derived from a scan of the same source.
 *
 * `actor` is recorded as its literal when the site passes one, or as `derived`
 * when it is computed by `resolveActorFor(...)` from the request's user.
 * `file.service.ts` forwards the attribution its own caller handed it, so its
 * resolve is recorded as `threaded` and its callers are pinned in the second
 * table instead.
 *
 * The ledger finds calls by NAME, so a call under another name is invisible to
 * it. What guarantees the attribution is PRESENT at every call, whatever its
 * shape, is the type: `ResolveOptions` makes it required. This file's job is the
 * narrower one of catching a WRONG caller, and the alias gate below catches only
 * these spellings of a renamed call:
 * - an aliased import: `import { resolveDownloadUrl as rdu }`
 * - a renamed destructure: `const { resolveDownloadUrl: rdu } = await import(…)`
 * - a computed key directly on a namespace import: `dw[k](…)`
 * - a computed key directly on a parenthesised dynamic import:
 *   `(await import(…))[k](…)`
 * A plain member call (`dw.resolveDownloadUrl(`) keeps the name and is counted by
 * the ledger.
 *
 * Known limits (each passes this suite; measured):
 * - a cast or optional chain before the computed key: `(dw as any)[k](…)`,
 *   `dw?.[k](…)`
 * - a dynamic import bound to a variable, then indexed:
 *   `const m = await import(…); (m as any)[k](…)`, or `.then((m) => m[k](…))`
 * - a renamed destructure with a default: `{ resolveDownloadUrl: rdu = x }`
 * - a guarded function passed around as a value (`const f = resolveDownloadUrl;
 *   f(…)`, or handed to a helper)
 * - comments are stripped with string-unaware regexes, so a string literal
 *   containing `/*` (a glob) followed later by `*\/` could hide code between
 *   them. An EXISTING call site hidden that way fails the ledger loudly; only a
 *   newly added one in such a file could slip past.
 * Every one needs deliberate indirection, and every one still has to pass a
 * type-checked attribution.
 */

const SRC = path.resolve(__dirname, '../..');
const SKIP_DIRS = new Set(['node_modules', '__tests__', '__screenshots__']);
const isTestFile = (name: string) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(name);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry) && !isTestFile(entry)) out.push(full);
  }
  return out;
}

const stripComments = (s: string) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/\s\/\/.*$/gm, '');

/** The text between the `(` at `open` and its matching `)`. */
function argsAt(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return src.slice(open + 1, i);
  }
  throw new Error('unbalanced call');
}

function describeCall(args: string): string {
  if (/\.\.\.attribution\b/.test(args)) return 'threaded';
  // `resolveDownloadUrl` hands its own `options` straight to `getDownloadUrlByFileId`.
  if (/,\s*options\s*$/.test(args)) return 'forwarded';
  const callers = [...args.matchAll(/\bcaller:\s*'([^']+)'/g)].map((m) => m[1]);
  const actorLiteral = [...args.matchAll(/\bactor:\s*'([^']+)'/g)].map((m) => m[1]);
  const actorDerived = /\bactor:\s*resolveActorFor\(/.test(args);
  const caller = callers.length === 1 ? callers[0] : `MISSING(${callers.length})`;
  const actor =
    actorLiteral.length === 1 && !actorDerived
      ? actorLiteral[0]
      : actorLiteral.length === 0 && actorDerived
      ? 'derived'
      : 'MISSING';
  return `${caller}|${actor}`;
}

/**
 * Every call of `fn` in `src`, described. A member call (`dw.fn(`, or
 * `(await import(...)).fn(`) counts too; only the function's own declaration
 * (`function fn(`) is skipped.
 */
function callsIn(src: string, fn: string): string[] {
  const callRe = new RegExp(`(?<![\\w$])${fn}\\(`, 'g');
  const out: string[] = [];
  const stripped = stripComments(src);
  for (const m of stripped.matchAll(callRe)) {
    if (stripped.slice(Math.max(0, m.index - 'function '.length), m.index) === 'function ')
      continue;
    out.push(describeCall(argsAt(stripped, m.index + fn.length)));
  }
  return out;
}

function scan(fn: string): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  for (const file of walk(SRC)) {
    const raw = readFileSync(file, 'utf8');
    if (!raw.includes(`${fn}(`)) continue;
    const calls = callsIn(raw, fn);
    if (calls.length) found[path.relative(SRC, file).split(path.sep).join('/')] = calls;
  }
  return found;
}

const GUARDED = ['resolveDownloadUrl', 'getDownloadUrlByFileId', 'getFileForModelVersion'];
const GUARDED_MODULE = String.raw`['"][^'"]*(?:delivery-worker|file\.service)['"]`;

/** Every way `src` reaches a guarded function under a name the ledger cannot see. */
function aliasViolationsIn(src: string): string[] {
  const code = stripComments(src);
  const out: string[] = [];
  const names = GUARDED.join('|');
  for (const m of code.matchAll(new RegExp(`\\b(${names})\\s+as\\s+([\\w$]+)`, 'g'))) {
    if (m[1] !== m[2]) out.push(`imports ${m[1]} as ${m[2]}`);
  }
  for (const m of code.matchAll(new RegExp(`\\b(${names})\\s*:\\s*([\\w$]+)\\s*[,}]`, 'g'))) {
    if (m[1] !== m[2]) out.push(`destructures ${m[1]} as ${m[2]}`);
  }
  for (const m of code.matchAll(
    new RegExp(`import\\s+\\*\\s+as\\s+([\\w$]+)\\s+from\\s+${GUARDED_MODULE}`, 'g')
  )) {
    if (new RegExp(`(?<![\\w$.])${m[1].replace('$', '\\$')}\\s*\\[`).test(code))
      out.push(`indexes namespace ${m[1]} by a computed key`);
  }
  if (new RegExp(`import\\(\\s*${GUARDED_MODULE}\\s*\\)\\s*\\)\\s*\\[`).test(code))
    out.push('indexes a dynamic import by a computed key');
  return out;
}

describe('storage-resolver attribution call-site ledger', () => {
  // The ledgers match by name; this is what makes "by name" complete.
  it('no file reaches a guarded function under another name', () => {
    const violations: string[] = [];
    const examined: string[] = [];
    for (const file of walk(SRC)) {
      const raw = readFileSync(file, 'utf8');
      if (!GUARDED.some((n) => raw.includes(n)) && !/delivery-worker|file\.service/.test(raw))
        continue;
      const rel = path.relative(SRC, file).split(path.sep).join('/');
      examined.push(rel);
      for (const v of aliasViolationsIn(raw)) violations.push(`${rel}: ${v}`);
    }
    // Positive control for the pre-filter: a filter that skips everything would
    // report no violations. `file.service.ts` both defines a guarded function and
    // imports the resolver module; `bountyEntry.service.ts` imports
    // `file.service` WITHOUT naming a guarded function, so it is examined only
    // because the filter admits a file matching EITHER test, not just both.
    expect(examined, 'the alias gate pre-filter skipped a known importer').toEqual(
      expect.arrayContaining([
        'server/services/file.service.ts',
        'server/services/bountyEntry.service.ts',
      ])
    );
    expect(examined.length, 'the alias gate examined too few files').toBeGreaterThanOrEqual(30);
    expect(
      violations,
      'a guarded resolve function is reached under a name the call-site ledger cannot see; ' +
        'import it under its own name so the ledger counts the call'
    ).toEqual([]);
  });

  it('the alias gate sees every shape it claims to', () => {
    const src = [
      `import { resolveDownloadUrl as rdu, isStorageResolverEnabled } from '~/utils/delivery-worker';`,
      `import { getFileForModelVersion } from '~/server/services/file.service';`,
      `import * as dw from '~/utils/delivery-worker';`,
      `const { getDownloadUrlByFileId: wire } = await import('~/utils/delivery-worker');`,
      `await dw[k](1, u);`,
      `await (await import('~/utils/delivery-worker'))[k](1, u);`,
      `// import { resolveDownloadUrl as commented } from '~/utils/delivery-worker';`,
    ].join('\n');
    expect(aliasViolationsIn(src)).toEqual([
      'imports resolveDownloadUrl as rdu',
      'destructures getDownloadUrlByFileId as wire',
      'indexes namespace dw by a computed key',
      'indexes a dynamic import by a computed key',
    ]);
    // Negative control: the ordinary shapes the ledger already counts are not flagged.
    expect(
      aliasViolationsIn(
        [
          `import { resolveDownloadUrl } from '~/utils/delivery-worker';`,
          `import * as dw from '~/utils/delivery-worker';`,
          `await dw.resolveDownloadUrl(1, u, n, { caller: 'vault', actor: 'user' });`,
          `const { resolveDownloadUrl: resolveDownloadUrl } = x;`,
        ].join('\n')
      )
    ).toEqual([]);
  });

  it('every resolveDownloadUrl call names its caller and actor', () => {
    expect(scan('resolveDownloadUrl')).toEqual({
      'pages/api/download/vault/[vaultItemId].ts': ['vault|derived'],
      'pages/api/internal/get-presigned-url.ts': ['internal-presigned|internal'],
      'pages/api/mod/training-data/resolve.ts': ['training-data|derived'],
      'server/controllers/model.controller.ts': ['link|derived', 'link|derived'],
      'server/services/file.service.ts': ['threaded'],
      'server/services/model3d.service.ts': ['model3d|derived'],
      'server/services/orchestrator/orchestrator.service.ts': [
        'orchestrator-preflight|internal',
        'orchestrator-preflight|internal',
      ],
      'server/services/wildcard-set-provisioning.service.ts': ['wildcard|internal'],
    });
  });

  it('every getFileForModelVersion call names the caller it resolves for', () => {
    expect(scan('getFileForModelVersion')).toEqual({
      'pages/api/download/models/[modelVersionId].ts': ['download-route|derived'],
      'pages/api/v1/model-files/[id]/tensor-metadata.ts': ['other|derived'],
      'server/services/csam.service-new.ts': ['other|internal'],
      'server/services/csam.service.ts': ['other|internal'],
      'server/services/wildcard-pack.service.ts': ['wildcard|derived'],
    });
  });

  // Calling the wire layer directly would bypass the two ledgers above, so its
  // only call site is pinned too: `resolveDownloadUrl` forwarding its own options.
  it('getDownloadUrlByFileId is called only by resolveDownloadUrl, forwarding its options', () => {
    expect(scan('getDownloadUrlByFileId')).toEqual({
      'utils/delivery-worker.ts': ['forwarded'],
    });
  });

  // Positive control for the scanner itself: a ledger that read `{}` would pass
  // nothing above, but a scanner that matched nothing must not be able to agree
  // with a hand-typed table by accident, so prove it parses each call shape.
  it('the scanner reads every shape the ledger relies on', () => {
    expect(describeCall(`1, u, n, { caller: 'vault', actor: resolveActorFor(user) }`)).toBe(
      'vault|derived'
    );
    expect(describeCall(`1, u, undefined, { caller: 'wildcard', actor: 'internal' }`)).toBe(
      'wildcard|internal'
    );
    expect(describeCall(`1, u, n, { direct, ...attribution }`)).toBe('threaded');
    expect(describeCall(`1, u, n`)).toBe('MISSING(0)|MISSING');
    expect(describeCall(`fileId, fileName, options`)).toBe('forwarded');
  });

  it('the scanner sees member calls and skips only the declaration', () => {
    const src = [
      `export async function resolveDownloadUrl(a: number) {}`,
      `await dw.resolveDownloadUrl(1, u, n, { caller: 'vault', actor: 'user' });`,
      `await (await import('x')).resolveDownloadUrl(1, u, n);`,
      `// resolveDownloadUrl(1, u, n) in a comment is not a call`,
      `await resolveDownloadUrl(1, u, n, { caller: 'link', actor: resolveActorFor(user) });`,
    ].join('\n');
    expect(callsIn(src, 'resolveDownloadUrl')).toEqual([
      'vault|user',
      'MISSING(0)|MISSING',
      'link|derived',
    ]);
  });
});
