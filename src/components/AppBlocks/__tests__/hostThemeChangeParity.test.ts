import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * THEME_CHANGE host-surface LEDGER.
 *
 * THE BUG CLASS: App Blocks has more than one host component, and they do NOT
 * share a postMessage bridge — each registers its own handlers and its own
 * host→block pushes by hand (`IframeHost.tsx` for the model slot,
 * `PageBlockHost.tsx` for `/apps/run/<slug>`). A host→block push wired into ONE
 * of them and not the other leaves half the deployed blocks stuck on their
 * mount-time theme, and every per-component test still passes: each suite is
 * scoped to one surface, so none of them ever asks "did the OTHER host get it
 * too?".
 *
 * `hostHandlerParity.ts` cannot cover this. Its INVENTORY is the block→HOST
 * request protocol (the "no handler → the block hangs" class); `THEME_CHANGE`
 * is a HOST→block push, so it is legitimately absent there.
 *
 * WHAT THIS PINS — a RELATIONSHIP, not a component. Two halves, because either
 * one alone is satisfiable by a surface that does nothing:
 *
 *   1. MEMBERSHIP. The host set is DERIVED from what a host IS — a module that
 *      IMPORTS the shared bridge hook `usePostMessage` and CALLS it, i.e. owns a
 *      `send` aimed at a block frame — not from where its file happens to sit.
 *      Discovery walks `src/` RECURSIVELY over every `.ts`/`.tsx`/`.js`/`.jsx`
 *      source, so a new host is force-enrolled whether it is a `.ts` hook, sits
 *      in a subdirectory, or lives outside `src/components/AppBlocks/`
 *      entirely. (The previous version of this file read ONE directory with a
 *      `.tsx` filter, so all three of those shapes were discovered as NOTHING
 *      and both ledger tests still passed. The claim was false; this is the fix.)
 *
 *   2. BEHAVIOUR. Every discovered host must have a `*.browser.test.tsx` that
 *      IMPORTS THAT HOST MODULE (resolved through the import specifier, so a
 *      rename or a move breaks the link) and asserts on `THEME_CHANGE`. The
 *      source grep in (1) is a text check and text cannot tell a live call from
 *      `if (false) { send('THEME_CHANGE', …) }` — only the browser suite, which
 *      renders the real host against a real frame, can. Without this half a new
 *      surface could satisfy the ledger while never pushing anything.
 *
 * SCOPE OF THE CLAIM, stated so it can be checked rather than believed: the walk
 * root is `src/` — the directory the `~` alias resolves to, and the only tree in
 * this repo that references `usePostMessage` at all (measured repo-wide; the
 * `apps/*` and `packages/*` workspaces cannot reach the hook, they have no path
 * to it). A host planted outside `src/` would still be missed; if one is ever
 * added, widen `WALK_ROOTS`.
 */

/** `<repo>/src/components/AppBlocks/__tests__` → `<repo>`. */
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const SRC_ROOT = join(REPO_ROOT, 'src');
const WALK_ROOTS = [SRC_ROOT];

/** The shared bridge hook. Owning a call to it is what MAKES a module a host. */
const BRIDGE_HOOK = 'usePostMessage';

const SOURCE_FILE = /\.[mc]?[jt]sx?$/;
const SKIP_DIRS = new Set(['node_modules', '.next', '.git', '__screenshots__', '__snapshots__']);
/** `.test.`/`.spec.` of any flavour (`.browser.test.tsx`, `.dom.test.ts`), or anything under `__tests__/`. */
const TEST_FILE = /\.(?:test|spec)\.[^.]+$|[\\/]__tests__[\\/]/;

/** Strip block + line comments so a mention inside a comment can't satisfy a grep. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Every source file under `root`, recursively. Absolute paths, sorted. */
function walkSourceFiles(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(full);
      } else if (entry.isFile() && SOURCE_FILE.test(entry.name)) {
        out.push(full);
      }
    }
  }
  return out.sort();
}

/** `{ a, b as c }` named-import bindings, per `from '…'` clause. Value imports only. */
const NAMED_IMPORT = /import\s+(type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;

/**
 * Does this (comment-stripped) source OWN a block bridge?
 *
 * Both halves are required. The import is what excludes `usePostMessage.ts`
 * itself (it DECLARES the hook, so a bare call-shaped grep matches its own
 * signature); the call is what excludes a module that merely re-exports it. A
 * `import type { usePostMessage }` is a type reference, not a bridge.
 */
function ownsBlockBridge(strippedSrc: string): boolean {
  if (!new RegExp(String.raw`\b${BRIDGE_HOOK}\s*\(`).test(strippedSrc)) return false;
  for (const match of strippedSrc.matchAll(NAMED_IMPORT)) {
    if (match[1]) continue; // `import type { … }`
    const bindings = match[2].split(',').map((b) =>
      b
        .trim()
        .split(/\s+as\s+/)[0]
        .trim()
    );
    if (bindings.includes(BRIDGE_HOOK)) return true;
  }
  return false;
}

/** Absolute paths of every non-test host surface under `roots`. */
function findHostSurfaces(roots: string[]): string[] {
  return roots
    .flatMap((root) => walkSourceFiles(root))
    .filter((file) => !TEST_FILE.test(file))
    .filter((file) => ownsBlockBridge(stripComments(readFileSync(file, 'utf8'))))
    .sort();
}

/** Repo-root-relative, POSIX separators — so the LOCATION of a host is part of the ledger. */
function repoRelative(file: string): string {
  return relative(REPO_ROOT, file).split(sep).join('/');
}

function discoverHostSurfaces(): string[] {
  return findHostSurfaces(WALK_ROOTS).map(repoRelative);
}

/**
 * Resolve an import specifier to a file on disk. Handles the two forms a host
 * can be imported by in this repo (`~/…` alias → `src/`, and relative); a bare
 * package specifier is never a first-party host, so it resolves to null.
 */
function resolveImport(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('~/')) base = join(SRC_ROOT, spec.slice(2));
  else if (spec.startsWith('.')) base = resolve(dirname(fromFile), spec);
  else return null;
  const candidates = [
    base,
    `${base}.tsx`,
    `${base}.ts`,
    join(base, 'index.tsx'),
    join(base, 'index.ts'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

const BROWSER_TESTS = WALK_ROOTS.flatMap((root) => walkSourceFiles(root)).filter((f) =>
  f.endsWith('.browser.test.tsx')
);

/** An `expect(…)` whose subject mentions THEME_CHANGE — an assertion, not a mention. */
const THEME_CHANGE_ASSERTION = /expect\([^;]{0,200}?THEME_CHANGE/;

/**
 * The browser suites that exercise THIS host's push: they must import the host
 * module ITSELF (matched on the RESOLVED path, so a rename or a move breaks the
 * link rather than silently keeping it) and assert on THEME_CHANGE.
 */
function browserTestsCovering(hostFile: string): string[] {
  return BROWSER_TESTS.filter((testFile) => {
    const src = stripComments(readFileSync(testFile, 'utf8'));
    if (!THEME_CHANGE_ASSERTION.test(src)) return false;
    return [...src.matchAll(/from\s*['"]([^'"]+)['"]/g)].some(
      (m) => resolveImport(testFile, m[1]) === hostFile
    );
  }).map(repoRelative);
}

const IFRAME_HOST = 'src/components/AppBlocks/IframeHost.tsx';
const PAGE_BLOCK_HOST = 'src/components/AppBlocks/PageBlockHost.tsx';

describe('THEME_CHANGE host-surface ledger', () => {
  it('the set of block-bridge host surfaces is exactly the two known hosts', () => {
    // A change here is not necessarily a bug — but it MUST be a decision. A new
    // host surface has to either push THEME_CHANGE (add it below) or state why
    // it does not. The paths are repo-relative because WHERE a host lives is
    // part of the claim: a host that moves is a host that moved.
    expect(discoverHostSurfaces()).toEqual([IFRAME_HOST, PAGE_BLOCK_HOST]);
  });

  it('EVERY host surface pushes THEME_CHANGE', () => {
    const missing = findHostSurfaces(WALK_ROOTS)
      .filter((file) => !/send\(\s*'THEME_CHANGE'/.test(stripComments(readFileSync(file, 'utf8'))))
      .map(repoRelative);
    expect(missing).toEqual([]);
  });

  it('EVERY host surface has a browser suite that exercises the push', () => {
    // The behavioural backstop. A source grep is satisfied by a dead branch
    // (`if (false) { send('THEME_CHANGE', …) }`) — only a suite that renders the
    // real host against a real frame can tell. This asserts one EXISTS and is
    // wired to this exact module; what it asserts is that suite's own job.
    const coverage = Object.fromEntries(
      findHostSurfaces(WALK_ROOTS).map((file) => [repoRelative(file), browserTestsCovering(file)])
    );
    const uncovered = Object.entries(coverage)
      .filter(([, tests]) => tests.length === 0)
      .map(([host]) => host);
    expect(uncovered).toEqual([]);
  });

  it('the browser-suite mapping DISCRIMINATES — it is not matching everything', () => {
    // Negative control on `resolveImport`. "Every host has coverage" would also
    // pass if the resolver said yes to every file, so pin that each host's set
    // holds ITS suite and NOT its sibling's (both suites assert on THEME_CHANGE,
    // so only the resolved import distinguishes them).
    const iframe = browserTestsCovering(join(REPO_ROOT, IFRAME_HOST));
    const page = browserTestsCovering(join(REPO_ROOT, PAGE_BLOCK_HOST));
    expect(iframe).toContain('src/components/AppBlocks/IframeHostThemeChange.browser.test.tsx');
    expect(iframe).not.toContain(
      'src/components/AppBlocks/PageBlockHostThemeChange.browser.test.tsx'
    );
    expect(page).toContain('src/components/AppBlocks/PageBlockHostThemeChange.browser.test.tsx');
    expect(page).not.toContain('src/components/AppBlocks/IframeHostThemeChange.browser.test.tsx');
  });

  it('the grep is not vacuous — it rejects a comment-only mention', () => {
    // Positive control on the STRIPPER: without it, the long explanatory comment
    // each host carries about THEME_CHANGE would satisfy the check above on a
    // host that never actually calls send().
    const commentOnly = `
      // send('THEME_CHANGE', { theme });
      /* send('THEME_CHANGE', { theme }); */
      export function FakeHost() { usePostMessage({}); return null; }
    `;
    const stripped = stripComments(commentOnly);
    expect(/send\(\s*'THEME_CHANGE'/.test(stripped)).toBe(false);
    // ...while a real call site still matches.
    expect(/send\(\s*'THEME_CHANGE'/.test(stripComments("send('THEME_CHANGE', { theme });"))).toBe(
      true
    );
  });
});

/**
 * POSITIVE CONTROL ON DISCOVERY ITSELF.
 *
 * A discovery that silently matched NOTHING would make the two ledger tests
 * above green for the wrong reason — `[]` has no member missing the push and no
 * member missing a browser suite. The exact-set assertion catches the total
 * failure; these cases catch the PARTIAL one, by driving the same walker +
 * predicate over a synthetic tree containing precisely the shapes that used to
 * be invisible: a `.ts` file, a subdirectory, and a location outside
 * `components/AppBlocks/`.
 */
describe('host discovery finds a host by SHAPE, not by filename or directory', () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'appblocks-host-ledger-'));

  afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));

  function write(relPath: string, contents: string): string {
    const full = join(fixtureRoot, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents, 'utf8');
    return full;
  }

  const bridge = (call = `usePostMessage({ iframeRef, expectedOrigin })`) => `
    import { useRef } from 'react';
    import { usePostMessage } from '~/components/AppBlocks/usePostMessage';
    export function Host() {
      const iframeRef = useRef(null);
      const { send } = ${call};
      send('THEME_CHANGE', { theme: 'dark' });
      return null;
    }
  `;

  // The three shapes the old one-directory `.tsx` readdir could not see...
  const tsHookInSubdir = write('components/AppBlocks/hosts/useBlockBridge.ts', bridge());
  const deepHost = write('components/Apps/review/nested/StrangeHost.tsx', bridge());
  const outsideAppBlocks = write('features/embeds/EmbedHost.tsx', bridge());

  // ...and the things that must STAY out.
  write(
    'components/Apps/RendersAHost.tsx',
    `import { PageBlockHost } from '~/components/AppBlocks/PageBlockHost';
     export const W = () => <PageBlockHost theme="dark" />;`
  );
  write(
    'components/AppBlocks/CommentOnly.tsx',
    `// PageBlockHost derives its transport internally (usePostMessage), so nothing is needed here.
     export const C = () => null;`
  );
  write(
    'components/AppBlocks/usePostMessage.ts',
    `export function usePostMessage(opts: unknown) { return opts; }`
  );
  // Synthetic-on-purpose: a call shape whose ONLY import of the hook is
  // type-only, so the `import type` branch of `ownsBlockBridge` is what excludes
  // it (the call grep alone would enrol it).
  write(
    'components/AppBlocks/TypeOnly.tsx',
    `import type { usePostMessage } from './usePostMessage';
     export const shape = usePostMessage({});`
  );
  write('components/AppBlocks/SomeHost.browser.test.tsx', bridge());
  write('components/AppBlocks/__tests__/someLedger.test.ts', bridge());

  it('finds a .ts hook, a nested subdirectory, and a file outside components/AppBlocks', () => {
    expect(findHostSurfaces([fixtureRoot])).toEqual(
      [deepHost, outsideAppBlocks, tsHookInSubdir].sort()
    );
  });

  it('does not enrol a wrapper, a comment, the hook itself, a type-only import, or a test', () => {
    const found = findHostSurfaces([fixtureRoot]);
    for (const notAHost of [
      'RendersAHost.tsx',
      'CommentOnly.tsx',
      'usePostMessage.ts',
      'TypeOnly.tsx',
      'SomeHost.browser.test.tsx',
      'someLedger.test.ts',
    ]) {
      expect(found.filter((f) => f.endsWith(notAHost))).toEqual([]);
    }
  });
});
