#!/usr/bin/env node
// Validates ports/manifest.json and regenerates the `@ported-to-go` markers in Node source. The
// manifest itself is hand-written; the ports' dependency lists are computed in CI by
// scripts/ports/touched.mjs and are not stored. See ports/README.md.
//
//   node scripts/ports/generate.mjs           validate, then write the markers
//   node scripts/ports/generate.mjs --check   write nothing; exit 1 if invalid or a marker is stale
//
// Needs `typescript` and `ajv` from node_modules. It parses source and type-checks nothing.
// Exit: 0 up to date / written, 1 invalid or stale (nothing written), 2 could not run.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MANIFEST, SCHEMA, readJson, schemaErrors, semanticErrors } from './manifest.mjs';
import { TAG, applyMarkers, stripMarkers } from './markers.mjs';

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
 * Returns `{ errors, manifest, files: Map<rel, { before, after }> }`.
 */
export function plan(root, { flagSources, markerFiles, now } = {}) {
  const manifest = JSON.parse(readFileSync(path.join(root, MANIFEST), 'utf8'));
  const errors = [];
  const ports = manifest.ports ?? [];

  errors.push(...schemaErrors(manifest, readJson(root, SCHEMA)).map((e) => `schema ${e}`));
  if (errors.length === 0) errors.push(...semanticErrors(root, manifest, flagSources, now));

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
      if (malformed.length) {
        for (const line of malformed)
          errors.push(
            `${rel}:${line}: mentions ${TAG} outside an intact generated marker block; restore or remove it by hand`
          );
        continue;
      }
      try {
        const after = applyMarkers(before, rel, byFile.get(rel) ?? []);
        if (after !== before) files.set(rel, { before, after });
      } catch (e) {
        errors.push(e.message);
      }
    }
  }
  return { errors, manifest, files };
}

/** Human-readable differences between the committed and the generated markers. */
export function describeDrift(result) {
  const lines = [];
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

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** The CLI. `root` is injectable for tests. Returns the exit code. */
export function main(argv, root = REPO_ROOT) {
  const check = argv.includes('--check');
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
        `ports: ${MANIFEST} is valid and its markers are up to date (${result.manifest.ports.length} ports).`
      );
      return 0;
    }
    for (const l of drift) console.error(`::error::${l}`);
    console.error('ports: stale. Run `node scripts/ports/generate.mjs` and commit the result.');
    return 1;
  }
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
