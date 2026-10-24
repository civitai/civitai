#!/usr/bin/env node
/**
 * Replace byte-identical duplicate Turbopack SERVER chunks with one-line re-export stubs.
 *
 * ---------------------------------------------------------------------------
 * Why
 * ---------------------------------------------------------------------------
 * Turbopack's server build emits the same chunk content under many file names: the copies
 * differ only in their trailing `//# sourceMappingURL=<own name>.map` comment. Next preloads
 * every server entry at start, and the Turbopack Node runtime loads each chunk with
 * `require(<absolute chunk path>)`. Node's module cache is keyed by PATH, so every copy is
 * compiled separately and its source text stays on the heap for the life of the process —
 * one string per copy. On a production build roughly two thirds of the loaded chunk source
 * was such duplicates.
 *
 * ---------------------------------------------------------------------------
 * Why stubs, and not rewriting the references
 * ---------------------------------------------------------------------------
 * Chunk paths are referenced from several places: the `R.c("server/chunks/…")` lines in each
 * entry file, the `["server/chunks/…"].map(r => s.l(r))` async-loader arrays INSIDE other
 * chunks, and the `.nft.json` traces. Rewriting every reference has two problems: a
 * reference kind we did not anticipate keeps pointing at a path we changed, and rewriting
 * strings inside chunks shifts the columns their source maps describe.
 *
 * What the runtime does with a chunk makes a stub sufficient instead. Its loaders
 * (`loadRuntimeChunkPath` / `loadChunkAsync` in `[turbopack]_runtime.js`) do exactly:
 *
 *     const chunkModules = require(path.resolve(RUNTIME_ROOT, chunkPath));
 *     installCompressedModuleFactories(chunkModules, 0, moduleFactories);
 *
 * A chunk is `module.exports = [moduleId, …, factory, …]`, and the install step registers
 * factories BY MODULE ID, skipping any id that already has one. So a module's identity
 * never depended on which file path delivered it — only the heap cost did. A duplicate
 * replaced by
 *
 *     module.exports=require("./<canonical>.js");
 *
 * hands the runtime the very same array the canonical file exports (Node caches by resolved
 * path), the id-keyed install is a no-op exactly as it was before, and the duplicate's
 * source is never compiled. Every reference — known kinds and any we did not think of — still
 * names a file that exists, so nothing can 404/500 on a missing chunk.
 *
 * Grouping is per DIRECTORY: a stub only ever points at a sibling. Two identical files in the
 * same directory resolve every relative `require` and node_modules lookup identically, so the
 * substitution cannot change what the code resolves. The runtime files
 * (`[turbopack]_runtime.js`) are never touched: each one owns a module registry, and they read
 * `__filename`.
 *
 * Only files that begin `module.exports=[` (the chunk format above) are candidates; any other
 * shape is skipped and counted, so a future change of chunk format degrades to "no dedupe"
 * rather than to a stub whose assumptions no longer hold.
 *
 * Every candidate is byte-compared against its canonical (after stripping the trailing
 * sourceMappingURL comment) before it is replaced — a hash match alone never replaces a file.
 *
 * ---------------------------------------------------------------------------
 * Where it runs
 * ---------------------------------------------------------------------------
 * In the Docker builder, against `.next/standalone/.next/server` — the tree that ships. The
 * build-output gates and the source-map staging read `.next/server`, which this never touches.
 *
 * Usage:  node scripts/dedupe-server-chunks.mjs <server-dir> [--dry-run]
 * Exit:   0 = done (or nothing to do) · 1 = a stub does not resolve to a real chunk
 *         · 2 = could not run (usage, no chunks directory, no chunk files, or no file in the
 *           `module.exports=[` chunk format)
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const STUB_MARKER = '// dedupe-server-chunks: identical to ';

/** The runtime files are module registries and read `__filename`; never stub one. */
export const isRuntimeFile = (name) => name === '[turbopack]_runtime.js';

const CHUNK_PREFIX = Buffer.from('module.exports=[');

/** True when the file begins `module.exports=[` — the Turbopack server chunk format. */
export const isChunkFormat = (buf) => buf.subarray(0, CHUNK_PREFIX.length).equals(CHUNK_PREFIX);

/** Content of the stub that replaces a duplicate of `canonicalName` (a sibling file). */
export function stubFor(canonicalName) {
  const spec = JSON.stringify(`./${canonicalName}`);
  return `${STUB_MARKER}${canonicalName}\nmodule.exports=require(${spec});\n`;
}

const STUB_RE =
  /^\/\/ dedupe-server-chunks: identical to ([^\n]+)\nmodule\.exports=require\(("[^\n]+")\);\n$/;

/** If `buf` is a stub written by this script, the canonical sibling's file name; else null. */
export function parseStub(buf) {
  if (buf.length > 4096) return null;
  const m = STUB_RE.exec(buf.toString('utf8'));
  if (!m) return null;
  const spec = JSON.parse(m[2]);
  if (spec !== `./${m[1]}`) return null;
  return m[1];
}

/**
 * The chunk bytes with a trailing `//# sourceMappingURL=…` comment removed — the only part
 * that differs between Turbopack's duplicate copies. Only a comment at the very END of the
 * file is stripped; one anywhere else is content.
 */
export function normalise(buf) {
  // latin1 maps bytes 1:1 to code units, so indices are byte offsets.
  const s = buf.toString('latin1');
  const m = /\n\/\/# sourceMappingURL=[^\n]*\n*$/.exec(s);
  return m ? buf.subarray(0, m.index) : buf;
}

function listChunkFiles(dir, out = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) listChunkFiles(p, out);
    else if (ent.isFile() && ent.name.endsWith('.js')) out.push(p);
  }
  return out;
}

function writeAtomic(path, content) {
  const tmp = `${path}.dedupe-tmp`;
  writeFileSync(tmp, content, { mode: statSync(path).mode });
  renameSync(tmp, path);
}

/**
 * Verify every stub under `chunksDir`: its target must be a sibling that exists and is a real
 * chunk (not another stub, not a runtime file). Returns a list of problems (empty = healthy).
 */
export function verifyStubs(chunksDir) {
  const problems = [];
  for (const file of listChunkFiles(chunksDir)) {
    const target = parseStub(readFileSync(file));
    if (target === null) continue;
    const targetPath = join(dirname(file), target);
    const rel = relative(chunksDir, file);
    if (target.includes('/') || target.includes('\\')) {
      problems.push(`${rel}: stub target ${target} is not a sibling`);
    } else if (!existsSync(targetPath)) {
      problems.push(`${rel}: stub target ${target} does not exist`);
    } else if (isRuntimeFile(target)) {
      problems.push(`${rel}: stub target ${target} is a runtime file`);
    } else if (parseStub(readFileSync(targetPath)) !== null) {
      problems.push(`${rel}: stub target ${target} is itself a stub`);
    }
  }
  return problems;
}

/**
 * Group and stub duplicate chunks under `<serverDir>/chunks`. Returns a summary; throws
 * `DedupeError` with `exitCode` 2 when there is nothing to observe and 1 when the result
 * does not verify.
 */
export function dedupeServerChunks(serverDir, { dryRun = false } = {}) {
  const chunksDir = join(serverDir, 'chunks');
  if (!existsSync(chunksDir)) throw new DedupeError(2, `no chunks directory at ${chunksDir}`);
  const files = listChunkFiles(chunksDir).sort();
  if (files.length === 0) throw new DedupeError(2, `no .js chunk files under ${chunksDir}`);

  // key = `${directory}\0${sha256 of normalised bytes}` → sorted file paths.
  const groups = new Map();
  let existingStubs = 0;
  let otherFormat = 0;
  let runtimeFiles = 0;
  for (const file of files) {
    if (isRuntimeFile(basename(file))) {
      runtimeFiles++;
      continue;
    }
    const buf = readFileSync(file);
    if (parseStub(buf) !== null) {
      existingStubs++;
      continue;
    }
    // Only files that BEGIN `module.exports=[` (the chunk format this design was checked
    // against) are candidates. Anything else is left alone, so a future chunk format is
    // skipped rather than stubbed on an assumption. This is a prefix check, not a proof
    // that the file has no path-dependent load-time behaviour.
    if (!isChunkFormat(buf)) {
      otherFormat++;
      continue;
    }
    const hash = createHash('sha256').update(normalise(buf)).digest('hex');
    const key = `${dirname(file)}\0${hash}`;
    const group = groups.get(key);
    if (group) group.push(file);
    else groups.set(key, [file]);
  }

  if (files.length === runtimeFiles) {
    throw new DedupeError(2, `no .js chunk files besides the runtime files under ${chunksDir}`);
  }
  // Every non-runtime file in an unrecognised format means Turbopack's output changed shape:
  // the script can no longer see its input, so it must not report a quiet "nothing to do".
  // A PARTIAL change (some files skipped) still exits 0 and shows only in the skipped count —
  // deliberately, so one legitimate non-array file cannot fail every build.
  if (groups.size === 0 && existingStubs === 0 && otherFormat > 0) {
    throw new DedupeError(
      2,
      `none of the ${otherFormat} chunk files under ${chunksDir} begins "module.exports=[" — ` +
        'the chunk format changed; re-check the design in this script before adapting it'
    );
  }

  let stubbed = 0;
  let bytesReplaced = 0;
  for (const group of groups.values()) {
    if (group.length < 2) continue; // no duplicates: skip re-reading the file
    const [canonical, ...duplicates] = group; // `files` is sorted, so the canonical is deterministic
    const canonicalBytes = normalise(readFileSync(canonical));
    for (const dup of duplicates) {
      const buf = readFileSync(dup);
      // Byte-compare, never trust the hash alone. Defence in depth: only a sha256 collision
      // reaches the `continue`, so no fixture can exercise it.
      if (!normalise(buf).equals(canonicalBytes)) continue;
      if (!dryRun) writeAtomic(dup, stubFor(basename(canonical)));
      stubbed++;
      bytesReplaced += buf.length;
    }
  }

  const summary = {
    chunkFiles: files.length - runtimeFiles,
    runtimeFiles,
    distinct: groups.size, // per directory: identical content in two directories counts twice
    existingStubs,
    otherFormat,
    stubbed,
    bytesReplaced,
    dryRun,
  };
  // Also under --dry-run: a dangling stub already on disk must never read as healthy.
  const problems = verifyStubs(chunksDir);
  if (problems.length) {
    throw new DedupeError(1, `stub verification failed:\n  ${problems.join('\n  ')}`, summary);
  }
  return summary;
}

export class DedupeError extends Error {
  constructor(exitCode, message, summary) {
    super(message);
    this.exitCode = exitCode;
    this.summary = summary;
  }
}

function main(argv) {
  const args = argv.filter((a) => a !== '--dry-run');
  const dryRun = args.length !== argv.length;
  if (args.length !== 1) {
    console.error('usage: node scripts/dedupe-server-chunks.mjs <server-dir> [--dry-run]');
    return 2;
  }
  try {
    const s = dedupeServerChunks(args[0], { dryRun });
    const mib = (s.bytesReplaced / 2 ** 20).toFixed(1);
    console.log(
      `dedupe-server-chunks: ${s.chunkFiles} chunk files, ${s.distinct} distinct contents ` +
        `(per directory), ${dryRun ? 'would stub' : 'stubbed'} ${s.stubbed} duplicates ` +
        `(${mib} MiB), ${s.existingStubs} already stubbed, ${s.otherFormat} skipped ` +
        `(not a module.exports=[ chunk), ${s.runtimeFiles} runtime files left alone`
    );
    return 0;
  } catch (err) {
    if (err instanceof DedupeError) {
      console.error(`dedupe-server-chunks: ${err.message}`);
      return err.exitCode;
    }
    throw err;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
