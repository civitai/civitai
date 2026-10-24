import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import type { Edge } from './import-graph.harness';
import {
  eraseServerOnlyBlocks,
  exportTargetToPath,
  parseImports,
  REPO_ROOT,
  rel,
  resolveSpecifier,
  resolveWorkspace,
  WORKSPACE_PACKAGES,
} from './import-graph.harness';

/**
 * `_app`'s module graph must not reach server infrastructure.
 *
 * `_app.getInitialProps` runs in the BROWSER on client-side route transitions
 * (`node_modules/next/dist/docs/02-pages/04-api-reference/03-functions/get-initial-props.md`
 * lines 8 and 39). The `if (!request) return initialProps;` early return makes it
 * behaviourally server-only at RUNTIME, but the module graph is still compiled into the
 * client bundle. A `dynamic import()` does not exempt a module either — the chunk is
 * compiled, merely not fetched.
 *
 * That distinction is not intuitive, and getting it wrong is what put a Prisma client and a
 * redis client into the browser graph. Nothing reported it: the leaves were externalised by
 * `serverExternalPackages`, so the build stayed green. Only an `fs/promises` import ever
 * failed loudly enough to notice.
 *
 * The ONE construct that does keep a module out is an `if (typeof window === 'undefined') { … }`
 * block: Next defines `typeof window` at build time, so the client build drops the block and
 * the imports in it. The walk follows the client's view of each file
 * (`eraseServerOnlyBlocks`), and every edge that view drops must be listed in
 * `SERVER_ONLY_EDGES` below — so such an edge is a reviewed decision, not a quiet escape.
 */

const ENTRY = 'src/pages/_app.tsx';

/**
 * Server infrastructure: modules that open connections, read the server env, or talk to
 * another service. Deliberately a denylist of INFRA rather than a snapshot of the current
 * file list — a snapshot rots into churn, and the invariant we actually care about is
 * "no infra", not "exactly these 1198 files".
 */
const DENIED_PREFIXES = [
  'src/server/db/',
  'src/server/redis/',
  'src/server/flipt/',
  'src/server/logging/',
  'src/env/server.ts',
  'src/env/server-schema.ts',
  'src/utils/logging.ts',
  'packages/civitai-db/',
  'packages/civitai-redis/',
  'packages/civitai-clickhouse/',
  'packages/civitai-axiom/',
  'packages/civitai-telemetry/',
  // Not the whole package: most of @civitai/buzz is pure pricing/limits constants that client
  // code legitimately uses. Only the service transport and its env slice are infra.
  'packages/civitai-buzz/src/client.ts',
  'packages/civitai-buzz/src/env.ts',
];

/**
 * Violations that exist today. Each must be REMOVED from this list when fixed — the second
 * test fails on a stale entry, so the list can shrink but never silently grow. An allowlist
 * that keeps permitting a fixed violation is worse than no guard at all.
 */
const KNOWN_REACHABLE: { file: string; reason: string }[] = [
  {
    file: 'src/server/flipt/client.ts',
    reason:
      'via _app -> [dyn] feature-flags.service. Drops with the feature-flag evaluator move to ~/shared/.',
  },
  {
    file: 'src/env/server.ts',
    reason: 'sole importer in this graph is flipt/client.ts:294; drops with it.',
  },
  {
    file: 'src/env/server-schema.ts',
    reason: 'sole importer is env/server.ts; drops with it.',
  },
  {
    file: 'src/server/logging/client.ts',
    reason:
      'TWO live paths — flipt/client.ts:3 AND audit-slow-log.ts:176 (guarded, deliberate, out of scope). Evicting flipt alone does NOT clear this one.',
  },
  {
    file: 'src/server/logging/structured-log-sink.ts',
    reason:
      'via logging/client.ts; a leaf (its only import is `import type`), so it adds itself and no further edges. Drops with logging/client.',
  },
  {
    file: 'src/server/logging/server-fault-override.ts',
    reason:
      'via logging/client.ts, which consults it in classifyErrorFault. A leaf with ZERO imports (not even a type-only one), so it adds itself and no further edges; it ships a WeakSet and two pure predicates, no server infrastructure. Deliberately NOT declared inside logging/client.ts: throwers import it directly, and the unit setup mocks ~/server/logging/client WHOLESALE, so a thrower reaching through that module would get undefined under test. Drops with logging/client.',
  },
  {
    file: 'packages/civitai-axiom/src/client.ts',
    reason: 'via logging/client.ts:7; drops only when logging/client does.',
  },
  {
    file: 'packages/civitai-axiom/src/env.ts',
    reason: 'via civitai-axiom/src/client.ts; drops with it.',
  },
  {
    file: 'packages/civitai-buzz/src/client.ts',
    reason:
      'PRE-EXISTING, invisible until this guard learned to resolve unaliased workspace packages. Static chain: _app -> SignalsProviderStack -> SignalsNotifications -> shared/constants/buzz.constants.ts -> the @civitai/buzz BARREL, which `export * from ./client`. buzz.constants only needs ./account-types. Fix needs an `exports` map on @civitai/buzz (it ships none) so the import can go deep.',
  },
  {
    file: 'packages/civitai-buzz/src/env.ts',
    reason: 'same barrel chain as civitai-buzz/src/client.ts; drops with the same fix.',
  },
];

/**
 * Imports the client build drops because they sit inside an
 * `if (typeof window === 'undefined') { … }` block. Asserted EXACTLY: a new one fails until it
 * is listed here, and a removed one fails until it is deleted. Measured for this form on
 * Next 16.3.1 under both Turbopack and `--webpack`: a marker string in a module imported this
 * way was absent from every `.next/static` file, while the same module imported behind only a
 * runtime `if (!req) return` was present.
 */
const SERVER_ONLY_EDGES: { file: string; spec: string; reason: string }[] = [
  {
    file: 'src/pages/_app.tsx',
    spec: '~/server/services/settings-bootstrap.service',
    reason:
      'the per-render settings bootstrap, read in-process instead of over an HTTP request to our own `/api/user/settings`.',
  },
  {
    file: 'src/pages/_app.tsx',
    spec: '~/server/shell/shell-render',
    reason:
      'the static-shell decision and its viewer-independent seeds (flags with no user, ToS, browsing addons, liveNow), read before the bootstrap is.',
  },
];

/**
 * Breadth-first so a reported chain is the SHORTEST one, and `visited` bounds the walk to
 * one visit per file — the import graph has cycles, and an unbounded walk would hang rather
 * than fail.
 */
function walkGraph() {
  const entryAbs = path.join(REPO_ROOT, ENTRY);
  const parent = new Map<string, { from: string; dynamic: boolean } | null>([[entryAbs, null]]);
  const queue = [entryAbs];
  const parsed = new Map<string, Edge[]>();
  const serverOnly: string[] = [];

  while (queue.length) {
    const file = queue.shift()!;
    let edges = parsed.get(file);
    if (!edges) {
      let source = '';
      try {
        source = fs.readFileSync(file, 'utf8');
      } catch {
        continue; // unreadable -> leaf
      }
      const clientView = eraseServerOnlyBlocks(source, file);
      for (const spec of clientView.erased) serverOnly.push(`${rel(file)} -> ${spec}`);
      edges = parseImports(clientView.source);
      parsed.set(file, edges);
    }
    for (const edge of edges) {
      const target = resolveSpecifier(edge.spec, file);
      if (!target || parent.has(target)) continue;
      parent.set(target, { from: file, dynamic: edge.dynamic });
      queue.push(target);
    }
  }

  const chainTo = (abs: string) => {
    const hops: string[] = [];
    let cursor: string | null = abs;
    while (cursor) {
      const link = parent.get(cursor);
      hops.push(rel(cursor) + (link?.dynamic ? '   [dynamic import]' : ''));
      cursor = link ? link.from : null;
    }
    return hops.reverse();
  };

  return {
    reachable: new Set([...parent.keys()].map(rel)),
    chainTo,
    parent,
    serverOnly: serverOnly.sort(),
  };
}

const { reachable, chainTo, serverOnly } = walkGraph();
const isDenied = (file: string) => DENIED_PREFIXES.some((p) => file === p || file.startsWith(p));
const known = new Set(KNOWN_REACHABLE.map((k) => k.file));

function formatViolation(file: string): string {
  const chain = chainTo(path.join(REPO_ROOT, file));
  const lines = chain.map((hop, i) => (i === 0 ? `    ${hop}` : `      -> ${hop}`));
  return `  ${file}\n${lines.join('\n')}`;
}

describe('client view of a file (eraseServerOnlyBlocks)', () => {
  const erasedOf = (src: string) => eraseServerOnlyBlocks(src, 'x.tsx').erased;

  it('drops an import inside the exact server-only block, in either operand order', () => {
    expect(erasedOf(`if (typeof window === 'undefined') { await import('~/a'); }`)).toEqual([
      '~/a',
    ]);
    expect(erasedOf(`if ('undefined' === typeof window) { await import('~/b'); }`)).toEqual([
      '~/b',
    ]);
    // Nested deeper inside the block is still inside it.
    expect(
      erasedOf(`if (typeof window === 'undefined') { const f = async () => import('~/c'); }`)
    ).toEqual(['~/c']);
  });

  it('keeps the import in the client view of that file', () => {
    const { source } = eraseServerOnlyBlocks(
      `before();\nif (typeof window === 'undefined') {\n  await import('~/a');\n}\nafter();`,
      'x.tsx'
    );
    expect(source).not.toContain('~/a');
    expect(source).toContain('before();');
    expect(source).toContain('after();');
    expect(source.split('\n')).toHaveLength(5);
  });

  // Each of these reaches the client in at least one of the two bundlers, so the walk must
  // keep following it.
  it.each([
    [
      'an early return (webpack keeps what follows)',
      `function f() { if (typeof window !== 'undefined') return; return import('~/a'); }`,
    ],
    ['the else branch', `if (typeof window === 'undefined') { x(); } else { import('~/a'); }`],
    ['a loose comparison', `if (typeof window == 'undefined') { import('~/a'); }`],
    [
      'an aliased condition',
      `const isServer = typeof window === 'undefined'; if (isServer) { import('~/a'); }`,
    ],
    ['a runtime-only guard', `if (!req) return; await import('~/a');`],
  ])('does not drop %s', (_label, src) => {
    expect(erasedOf(src)).toEqual([]);
    expect(eraseServerOnlyBlocks(src, 'x.tsx').source).toContain('~/a');
  });
});

describe('workspace export resolution', () => {
  // Every manifest ships flat string targets today, so the conditions form is unexercised by
  // the walk above. It still has to be handled here rather than in review: `path.join` throws
  // on a non-string, and this resolver runs at MODULE SCOPE, so the first package to adopt
  // `{ "import": ..., "require": ... }` would fail COLLECTION — which reports as no tests
  // rather than as red.
  it('reads a path out of a conditional export instead of throwing', () => {
    expect(exportTargetToPath({ import: './src/a.ts', require: './dist/a.cjs' })).toBe(
      './src/a.ts'
    );
    // `import` wins over `default`: `default` conventionally points at a built artifact, and
    // walking that instead of source is how a resolver goes blind while looking successful.
    expect(exportTargetToPath({ default: './dist/b.cjs', import: './src/b.ts' })).toBe(
      './src/b.ts'
    );
    expect(exportTargetToPath('./src/d.ts')).toBe('./src/d.ts');
    expect(exportTargetToPath(undefined)).toBeNull();
    expect(exportTargetToPath({ types: './a.d.ts' })).toBeNull();
  });

  it('resolves a wildcard-only subpath, spelled the way the repo actually spells it', () => {
    // Must be a subpath with NO exact key, or this passes on the exact branch and never
    // reaches the wildcard code — `./utils` has one, so it proved nothing.
    // `@civitai/ui` maps `./hooks/*` at `./src/lib/hooks/*`, and every real call site writes
    // the EMITTED name (`.svelte.js`) against a `.svelte.ts` source.
    expect(
      Object.keys(WORKSPACE_PACKAGES.find((p) => p.name === '@civitai/ui')!.exports),
      'pick a subpath with no exact key or this test is vacuous'
    ).not.toContain('./hooks/is-mobile.svelte.js');

    const resolved = resolveWorkspace('@civitai/ui/hooks/is-mobile.svelte.js');
    expect(
      resolved,
      'a wildcard subpath must resolve, not become a silent external leaf'
    ).not.toBeNull();
    expect(resolved!.replace(/\\/g, '/')).toContain(
      'packages/civitai-ui/src/lib/hooks/is-mobile.svelte.ts'
    );
  });
});

describe('no server infrastructure in the _app client graph', () => {
  it('walks a non-trivial graph', () => {
    // Guards the guard: an alias-resolution or entry-path breakage would empty the graph and
    // make every assertion below pass vacuously.
    expect(reachable.size).toBeGreaterThan(1000);
  });

  it('does not reach server infrastructure', () => {
    const violations = [...reachable].filter((f) => isDenied(f) && !known.has(f)).sort();
    if (violations.length) {
      throw new Error(
        `${violations.length} server-infrastructure module(s) reachable from ${ENTRY}.\n\n` +
          `A dynamic import() does NOT exempt a module — the chunk is still compiled into the\n` +
          `client bundle. Move the work behind an API route, or import the value from ~/shared/.\n\n` +
          violations.map(formatViolation).join('\n\n') +
          `\n`
      );
    }
  });

  it('drops exactly the reviewed server-only edges', () => {
    expect(
      serverOnly,
      "an import inside `if (typeof window === 'undefined') { … }` is skipped by this walk — list it in SERVER_ONLY_EDGES, or delete a stale entry"
    ).toEqual(SERVER_ONLY_EDGES.map((e) => `${e.file} -> ${e.spec}`).sort());
  });

  it('has no stale KNOWN_REACHABLE entries', () => {
    const fixed = KNOWN_REACHABLE.filter((k) => !reachable.has(k.file));
    if (fixed.length) {
      throw new Error(
        `${fixed.length} KNOWN_REACHABLE entr(ies) are no longer reachable — delete them from\n` +
          `${path.basename(
            __filename
          )} so the guard tightens instead of silently re-permitting them:\n\n` +
          fixed.map((k) => `  ${k.file}\n    (${k.reason})`).join('\n\n') +
          `\n`
      );
    }
  });
});
