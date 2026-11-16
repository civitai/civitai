#!/usr/bin/env node
// Which ports a change touches: the changed files intersected with each port's Node and Go
// dependencies, plus any port whose manifest entry changed. See ports/README.md.
//
//   node scripts/ports/touched.mjs --base <ref>     files changed in <ref>...HEAD
//   node scripts/ports/touched.mjs <file> [...]     the files given
//
// The dependencies are not stored anywhere: this computes them from source on every run
// (node-deps.mjs: runtime imports from the entry symbol; go-deps.mjs: `go list -deps`, so Go must be
// on PATH for the Go half). With --base it computes them at HEAD and again at the merge base, in a
// temporary `git worktree` it removes afterwards, so a port is still reported when the change
// removes the very file that made it a dependency.
//
// Report-only: a port whose dependencies cannot be computed is listed under `errors` and the
// exit code stays 0. Exit 2 only when the script itself cannot run (bad arguments, git failing).
// Prints a JSON object to stdout:
//   { "ports": [{ "id", "service", "status", "manifest": bool, "node": [files], "go": [files] }],
//     "changedFiles": <count>, "errors": [messages] }
// With $GITHUB_STEP_SUMMARY set it also appends a table and the files per port there.
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { computeGoDeps } from './go-deps.mjs';
import { MANIFEST, serviceDir } from './manifest.mjs';
import { computeNodeDeps, loadPathAliases, loadSubmodules, trackedFiles } from './node-deps.mjs';

// What withDeps adds to a port; not part of its manifest entry.
const DEP_KEYS = ['nodeDeps', 'goDeps'];

/**
 * The manifest's ports with `nodeDeps` / `goDeps` computed from the tree at `root`.
 * Returns `{ ports, errors }`; a port whose deps fail is kept with what could be computed.
 * `label` prefixes the error messages (e.g. `HEAD`, `base`).
 */
export function withDeps(root, manifest, { goList, label = '' } = {}) {
  const errors = [];
  const at = (port) => `${label ? `${label}: ` : ''}port ${port.id}`;
  let ctx = null;
  const ports = (manifest.ports ?? []).map((port) => {
    const out = { ...port, nodeDeps: [], goDeps: [] };
    if (port.nodeEntry) {
      try {
        ctx ??= {
          aliases: loadPathAliases(root),
          submodules: loadSubmodules(root),
          tracked: trackedFiles(root),
        };
        out.nodeDeps = computeNodeDeps(root, port.nodeEntry, ctx);
      } catch (e) {
        errors.push(`${at(port)}: Node deps: ${e.message}`);
      }
    }
    try {
      const roots = port.goRoots ?? [...new Set(port.goHandler.map((f) => path.posix.dirname(f)))];
      out.goDeps = computeGoDeps(root, serviceDir(port.service), roots, port.goHandler, goList);
    } catch (e) {
      errors.push(`${at(port)}: Go deps: ${e.message}`);
    }
    return out;
  });
  return { ports, errors };
}

const handFields = (port) => {
  const copy = { ...port };
  for (const k of DEP_KEYS) delete copy[k];
  return JSON.stringify(copy, Object.keys(copy).sort());
};

/**
 * @param manifests manifests with deps (withDeps) whose ports are reported: HEAD, and the base so
 *   a removed dep still counts
 * @param changed repo-relative changed paths
 * @param base the base manifest, for detecting hand-edited port entries (optional)
 */
export function portsTouched(manifests, changed, base = null) {
  const changedSet = new Set(changed);
  const baseById = new Map((base?.ports ?? []).map((p) => [p.id, p]));
  const byId = new Map();
  for (const m of manifests) {
    for (const port of m.ports ?? []) {
      const entry = byId.get(port.id) ?? {
        id: port.id,
        service: port.service,
        status: port.status,
        manifest: false,
        node: new Set(),
        go: new Set(),
      };
      for (const f of port.nodeDeps ?? []) if (changedSet.has(f)) entry.node.add(f);
      for (const f of port.goDeps ?? []) if (changedSet.has(f)) entry.go.add(f);
      if (base && changedSet.has(MANIFEST)) {
        const was = baseById.get(port.id);
        if (!was || handFields(was) !== handFields(port)) entry.manifest = true;
      }
      byId.set(port.id, entry);
    }
  }
  return [...byId.values()]
    .filter((e) => e.manifest || e.node.size || e.go.size)
    .map((e) => ({ ...e, node: [...e.node].sort(), go: [...e.go].sort() }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const git = (root, args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 << 20 });

function gitShow(root, ref, rel) {
  try {
    return execFileSync('git', ['show', `${ref}:${rel}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

/** Deps of the base manifest, computed in a temporary worktree of `rev`. */
function baseWithDeps(root, rev, manifest) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ports-base-'));
  try {
    git(root, ['worktree', 'add', '--detach', '--quiet', dir, rev]);
    return withDeps(dir, manifest, { label: `base ${rev.slice(0, 10)}` });
  } finally {
    try {
      git(root, ['worktree', 'remove', '--force', dir]);
    } catch {
      // never added; nothing to unregister
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

export function summary(result) {
  const { ports, errors, changedFiles } = result;
  const out = [`### Node→Go ports touched\n`, `${changedFiles} changed file(s).\n`];
  if (ports.length === 0) out.push('This change touches no ported endpoint.\n');
  else {
    out.push(
      '| Port | Service | Status | Node deps changed | Go deps changed | Manifest entry changed |',
      '|---|---|---|---|---|---|',
      ...ports.map(
        (p) =>
          `| \`${p.id}\` | ${p.service} | ${p.status} | ${p.node.length} | ${p.go.length} | ${
            p.manifest ? 'yes' : ''
          } |`
      ),
      ''
    );
    const LIMIT = 30;
    for (const p of ports) {
      const files = [...p.node, ...p.go];
      if (files.length === 0) continue;
      out.push(
        `<details><summary><code>${p.id}</code>: ${files.length} changed file(s)</summary>\n`,
        ...files.slice(0, LIMIT).map((f) => `- \`${f}\``),
        ...(files.length > LIMIT ? [`- … and ${files.length - LIMIT} more`] : []),
        '\n</details>\n'
      );
    }
  }
  if (errors.length)
    out.push(
      '**Could not compute every dependency list** (report-only; this does not fail CI):\n',
      ...errors.map((e) => `- ${e.split('\n')[0]}`),
      ''
    );
  return `${out.join('\n')}\n`;
}

function main(argv) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const headManifest = JSON.parse(readFileSync(path.join(root, MANIFEST), 'utf8'));
  let changed;
  let base = null;
  let baseDeps = null;
  const bi = argv.indexOf('--base');
  if (bi !== -1) {
    const ref = argv[bi + 1];
    if (!ref) {
      console.error('usage: touched.mjs --base <ref> | <file>...');
      return 2;
    }
    const rev = git(root, ['merge-base', ref, 'HEAD']).trim();
    // --no-renames: a rename is its old path deleted and its new path added; both can be deps.
    changed = git(root, ['diff', '--name-only', '--no-renames', '-z', rev, 'HEAD'])
      .split('\0')
      .filter(Boolean);
    const baseText = gitShow(root, rev, MANIFEST);
    base = baseText ? JSON.parse(baseText) : { ports: [] };
    baseDeps = base.ports?.length ? baseWithDeps(root, rev, base) : { ports: [], errors: [] };
  } else {
    changed = argv;
  }
  const headDeps = withDeps(root, headManifest, { label: 'HEAD' });
  const sides = baseDeps ? [headDeps, baseDeps] : [headDeps];
  const ports = portsTouched(
    sides.map((d) => ({ ports: d.ports })),
    changed,
    base
  );
  const errors = sides.flatMap((d) => d.errors);
  for (const e of errors) console.error(`::warning::${e.split('\n')[0]}`);
  const result = { ports, changedFiles: changed.length, errors };
  console.log(JSON.stringify(result, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary(result));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(`ports: could not run: ${e.stack ?? e}`);
    process.exitCode = 2;
  }
}
