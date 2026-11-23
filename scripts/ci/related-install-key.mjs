#!/usr/bin/env node
// The installed-tree cache key's view of the workspace manifests (lint.yml, `related-tests` and
// `related-cache`).
//
//   node scripts/ci/related-install-key.mjs <out-file>
//       Writes one canonical text of every pnpm WORKSPACE MEMBER's package.json (the members
//       pnpm-workspace.yaml's `packages:` selects, its `!` exclusions applied), each with its
//       `version` removed and its keys sorted. The cache key hashes that file instead of the raw
//       manifests: a release bumps `version` on most commits to `main` and changes nothing an
//       install produces, so hashing the raw files made most of those commits a new 485 MB cache
//       entry and a miss on every PR behind them. An excluded package (the Go apps, whose
//       package.json carries only a release version) is not installed at all, so it is left out.
//
// The cached paths follow the same `packages:` includes (cachePaths): lint.yml's list is checked
// against them by scripts/__tests__/related-install-key.test.ts, so a new workspace include that
// would install a node_modules outside the cached paths fails there.
//
// Node built-ins only: it runs before setup-node, on the runner's own node.

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * pnpm-workspace.yaml's `packages:` list, as { includes, excludes }. A line-based read of the one
 * key this file needs (no YAML dependency: this runs before the install); a form it does not
 * know throws rather than be skipped.
 */
export function parseWorkspace(text) {
  const includes = [];
  const excludes = [];
  let inPackages = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').replace(/^\s*#.*$/, '');
    if (!line.trim()) continue;
    if (/^\S/.test(line)) {
      inPackages = /^packages:\s*$/.test(line);
      continue;
    }
    if (!inPackages) continue;
    const m = /^\s+-\s+(['"]?)(.+?)\1\s*$/.exec(line);
    if (!m) throw new Error(`pnpm-workspace.yaml: cannot read packages entry: ${raw.trim()}`);
    if (m[2].startsWith('!')) excludes.push(m[2].slice(1));
    else includes.push(m[2]);
  }
  return { includes, excludes };
}

/** Workspace member dirs under `root`: '.' or '<dir>/*' includes, minus exact excludes. */
export function memberDirs(root, { includes, excludes }, list = (d) => readdirSync(d)) {
  const out = [];
  for (const inc of includes) {
    if (inc === '.') out.push('.');
    else if (/^[\w.-]+(\/[\w.-]+)*\/\*$/.test(inc)) {
      const parent = inc.slice(0, -2);
      for (const name of list(join(root, parent)).sort()) out.push(`${parent}/${name}`);
    } else throw new Error(`pnpm-workspace.yaml: unsupported packages pattern: ${inc}`);
  }
  const ex = new Set(excludes);
  return out.filter((d) => !ex.has(d));
}

/** The node_modules paths an install of these includes writes, for the cache's path list. */
export function cachePaths({ includes }) {
  return includes.map((inc) => (inc === '.' ? 'node_modules' : `${inc}/node_modules`));
}

/** The cachePaths a cache path list is missing (lint.yml's list is checked with this). */
export function missingCachePaths(ws, listed) {
  const have = new Set(listed.map((l) => l.trim()).filter(Boolean));
  return cachePaths(ws).filter((p) => !have.has(p));
}

/** `value` with object keys sorted, recursively (arrays keep their order). */
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortKeys(value[k])])
    );
  return value;
}

/**
 * The canonical text for the key: [{ dir, manifest }] (manifest: the parsed package.json), sorted
 * by dir, `version` dropped, keys sorted. Pure.
 */
export function manifestKeyText(manifests) {
  return `${[...manifests]
    .sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0))
    .map(({ dir, manifest }) => {
      const { version: _v, ...rest } = manifest;
      return `${dir}\t${JSON.stringify(sortKeys(rest))}`;
    })
    .join('\n')}\n`;
}

/** Read the members' manifests from a tree. `read(path)` returns a file's text or null. */
export function readManifests(root, ws, { list, read }) {
  return memberDirs(root, ws, list)
    .map((dir) => ({ dir, text: read(dir === '.' ? 'package.json' : `${dir}/package.json`) }))
    .filter((m) => m.text !== null)
    .map(({ dir, text }) => ({ dir, manifest: JSON.parse(text) }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2];
  if (!out) {
    console.error('usage: related-install-key.mjs <out-file>');
    process.exit(2);
  }
  const root = process.cwd();
  const ws = parseWorkspace(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8'));
  const manifests = readManifests(root, ws, {
    list: (d) => readdirSync(d),
    read: (p) => (existsSync(join(root, p)) ? readFileSync(join(root, p), 'utf8') : null),
  });
  writeFileSync(out, manifestKeyText(manifests));
  console.log(`${manifests.length} workspace manifest(s), versions stripped, into ${out}`);
}
