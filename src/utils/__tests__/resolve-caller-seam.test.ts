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
 * Known limit: comments are stripped with string-unaware regexes, so a string
 * literal containing `/*` (a glob) followed later by `*\/` could hide code
 * between them. An EXISTING call site hidden that way fails the ledger loudly;
 * only a newly added one in such a file could slip past.
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

describe('storage-resolver attribution call-site ledger', () => {
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
