#!/usr/bin/env node
// Which ports a change touches: the changed files intersected with each port's nodeDeps and goDeps,
// plus any port whose hand-written manifest fields changed. See ports/README.md.
//
//   node scripts/ports/touched.mjs --base <ref>     files changed in <ref>...HEAD
//   node scripts/ports/touched.mjs <file> [...]     the files given
//
// Prints a JSON object to stdout:
//   { "ports": [{ "id", "service", "status", "manifest": bool, "node": [files], "go": [files] }],
//     "ids": [port ids], "changedFiles": <count> }
// With $GITHUB_OUTPUT set it also writes the step outputs `ids` (JSON array), `count` and
// `touched` (the whole object, compact), and a table to $GITHUB_STEP_SUMMARY.
// --base reads the manifest at both <ref> and HEAD, so a port is still reported when the change
// removes the very file that made it a dependency.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { GENERATED_KEYS, MANIFEST } from './manifest.mjs';

const handFields = (port) => {
  const copy = { ...port };
  for (const k of GENERATED_KEYS) delete copy[k];
  return JSON.stringify(copy, Object.keys(copy).sort());
};

/**
 * @param heads manifests whose ports are reported (HEAD, and the base so a removed dep still counts)
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

function main(argv) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const head = JSON.parse(readFileSync(path.join(root, MANIFEST), 'utf8'));
  let changed;
  let base = null;
  const bi = argv.indexOf('--base');
  if (bi !== -1) {
    const ref = argv[bi + 1];
    if (!ref) {
      console.error('usage: touched.mjs --base <ref> | <file>...');
      return 2;
    }
    // --no-renames: a rename is its old path deleted and its new path added; both can be deps.
    changed = execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', `${ref}...HEAD`], {
      cwd: root,
      encoding: 'utf8',
    })
      .split('\0')
      .filter(Boolean);
    const baseText = gitShow(root, ref, MANIFEST);
    base = baseText ? JSON.parse(baseText) : { ports: [] };
  } else {
    changed = argv;
  }
  const ports = portsTouched(base ? [head, base] : [head], changed, base);
  const result = { ports, ids: ports.map((p) => p.id), changedFiles: changed.length };
  console.log(JSON.stringify(result, null, 2));

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `ids=${JSON.stringify(result.ids)}\ncount=${ports.length}\ntouched=${JSON.stringify(
        result
      )}\n`
    );
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = ports.map(
      (p) =>
        `| \`${p.id}\` | ${p.service} | ${p.status} | ${p.node.length} | ${p.go.length} | ${
          p.manifest ? 'yes' : ''
        } |`
    );
    const body = ports.length
      ? [
          '| Port | Service | Status | Node deps changed | Go deps changed | Manifest entry changed |',
          '|---|---|---|---|---|---|',
          ...rows,
        ].join('\n')
      : 'This change touches no ported endpoint.';
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Node→Go ports touched\n\n${body}\n`);
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
