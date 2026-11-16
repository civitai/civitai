#!/usr/bin/env node
// Regenerates the generated parts of ports/manifest.json (nodeDeps, goDeps) and the
// `@ported-to-go` markers in Node source, and validates the manifest. See ports/README.md.
//
//   node scripts/ports/generate.mjs           write the generated fields and markers
//   node scripts/ports/generate.mjs --check   write nothing; exit 1 if anything is stale or invalid
//
// Needs `typescript` and `ajv` from node_modules and `go` on PATH. Light: it parses imports
// (no type-checking) and runs `go list` (no build).
// Exit: 0 up to date / written, 1 invalid or stale, 2 could not run.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { computeGoDeps } from './go-deps.mjs';
import {
  GENERATED_KEYS,
  MANIFEST,
  SCHEMA,
  readJson,
  schemaErrors,
  semanticErrors,
  serializeManifest,
  serviceDir,
} from './manifest.mjs';
import { TAG, applyMarkers, stripMarkers } from './markers.mjs';
import { computeNodeDeps } from './node-deps.mjs';

/** Tracked files under src/ and packages/ that mention the marker tag. */
export function filesMentioningTag(root) {
  try {
    const out = execFileSync('git', ['grep', '-l', '-z', '-F', TAG, '--', 'src', 'packages'], {
      cwd: root,
      encoding: 'utf8',
    });
    return out.split('\0').filter(Boolean);
  } catch (e) {
    if (e.status === 1) return []; // git grep: no match
    throw e;
  }
}

/**
 * Everything the generator would write, without writing it.
 * Returns `{ errors, manifestText, files: Map<rel, { before, after }> }`.
 */
export function plan(root, { flagSources, markerFiles, goList } = {}) {
  const manifestBefore = readFileSync(path.join(root, MANIFEST), 'utf8');
  const manifest = JSON.parse(manifestBefore);
  const errors = [];

  const ports = manifest.ports ?? [];
  for (const port of ports) {
    try {
      port.nodeDeps = port.nodeEntry ? computeNodeDeps(root, port.nodeEntry) : [];
    } catch (e) {
      errors.push(`port ${port.id}: ${e.message}`);
    }
    try {
      const dir = serviceDir(port.service);
      const roots = port.goRoots ?? [...new Set(port.goHandler.map((f) => path.posix.dirname(f)))];
      port.goDeps = computeGoDeps(root, dir, roots, port.goHandler, goList);
    } catch (e) {
      errors.push(`port ${port.id}: ${e.message}`);
    }
  }

  errors.push(...schemaErrors(manifest, readJson(root, SCHEMA)).map((e) => `schema ${e}`));
  if (errors.length === 0) errors.push(...semanticErrors(root, manifest, flagSources));

  const files = new Map();
  if (errors.length === 0) {
    const byFile = new Map();
    for (const port of ports) {
      if (!port.nodeEntry) continue;
      if (!byFile.has(port.nodeEntry.file)) byFile.set(port.nodeEntry.file, []);
      byFile.get(port.nodeEntry.file).push(port);
    }
    const candidates = new Set([...(markerFiles ?? filesMentioningTag(root)), ...byFile.keys()]);
    for (const rel of [...candidates].sort()) {
      const before = readFileSync(path.join(root, rel), 'utf8');
      const { malformed } = stripMarkers(before);
      for (const line of malformed)
        errors.push(`${rel}:${line}: mentions ${TAG} outside a generated marker block; remove it`);
      try {
        const after = applyMarkers(before, rel, byFile.get(rel) ?? []);
        if (after !== before) files.set(rel, { before, after });
      } catch (e) {
        errors.push(e.message);
      }
    }
  }
  return { errors, manifest, manifestBefore, manifestAfter: serializeManifest(manifest), files };
}

/** Human-readable differences between the committed and the generated state. */
export function describeDrift(result) {
  const lines = [];
  const before = JSON.parse(result.manifestBefore);
  const beforeById = new Map((before.ports ?? []).map((p) => [p.id, p]));
  for (const port of result.manifest.ports) {
    const old = beforeById.get(port.id) ?? {};
    for (const key of GENERATED_KEYS) {
      const was = new Set(old[key] ?? []);
      const now = new Set(port[key]);
      const added = [...now].filter((f) => !was.has(f));
      const removed = [...was].filter((f) => !now.has(f));
      if (added.length || removed.length)
        lines.push(
          `${MANIFEST}: port ${port.id} ${key}: +${added.length} -${removed.length}` +
            [
              ...added.slice(0, 5).map((f) => `\n    + ${f}`),
              ...removed.slice(0, 5).map((f) => `\n    - ${f}`),
            ].join('')
        );
    }
  }
  if (lines.length === 0 && result.manifestAfter !== result.manifestBefore)
    lines.push(`${MANIFEST}: not in generated form (key order or formatting)`);
  for (const [rel, { before, after }] of result.files) {
    const was = new Map(stripMarkers(before).found.map((m) => [m.id, m.text]));
    const now = new Map(stripMarkers(after).found.map((m) => [m.id, m.text]));
    for (const [id, text] of now) {
      if (!was.has(id)) lines.push(`${rel}: missing marker for port ${id}`);
      else if (was.get(id) !== text) lines.push(`${rel}: stale marker for port ${id}`);
    }
    for (const id of was.keys())
      if (!now.has(id)) lines.push(`${rel}: marker for ${id}, which is not a port of this file`);
    if (lines.every((l) => !l.startsWith(`${rel}:`)))
      lines.push(`${rel}: marker on the wrong line`);
  }
  return lines;
}

function main(argv) {
  const check = argv.includes('--check');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  let result;
  try {
    result = plan(root);
  } catch (e) {
    console.error(`ports: could not run: ${e.stack ?? e}`);
    return 2;
  }
  if (result.errors.length) {
    for (const e of result.errors) console.error(`::error::${e}`);
    console.error(`ports: ${result.errors.length} error(s); nothing written.`);
    return 1;
  }
  const drift = describeDrift(result);
  if (check) {
    if (drift.length === 0) {
      console.log(
        `ports: ${MANIFEST} and markers are up to date (${result.manifest.ports.length} ports).`
      );
      return 0;
    }
    for (const l of drift) console.error(`::error::${l}`);
    console.error('ports: stale. Run `node scripts/ports/generate.mjs` and commit the result.');
    return 1;
  }
  if (result.manifestAfter !== result.manifestBefore)
    writeFileSync(path.join(root, MANIFEST), result.manifestAfter);
  for (const [rel, { after }] of result.files) writeFileSync(path.join(root, rel), after);
  for (const l of drift) console.log(`updated ${l}`);
  console.log(
    `ports: ${drift.length ? 'written' : 'already up to date'} (${
      result.manifest.ports.length
    } ports).`
  );
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
