import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { COMPILED_BRANCH_WATCHLIST } from '../compiled-branch-watchlist.mjs';

/**
 * `scripts/assert-compiled-branches.mjs` is a BUILD gate: it reads the emitted server
 * source maps and fails when a watched, security-relevant branch has no representation in
 * the compiled output — the civitai#3983 shape, where two of a resolver's three `return`s
 * were absent from the shipped chunk while the TypeScript was correct.
 *
 * These cases drive it over synthetic `.next/server` trees. That is deliberate: a real
 * `next build` takes minutes, so nobody would run one per case, and the branches that
 * matter (a missing return, an unobservable control, a build with no maps) are exactly
 * the ones a healthy real build cannot produce on demand.
 *
 * 🔴 Each case must fail for ITS OWN reason, so every expectation asserts the specific
 * message that branch emits and the specific exit code, not merely "non-zero". A gate
 * with four failure branches and one generic assertion is a gate with one tested branch.
 *
 * 🔴 The healthy baseline is derived from the gate's REAL watchlist and the REAL source
 * files, never a hand-written copy. That makes the positive control meaningful in two
 * ways at once: a new watchlist entry is proven satisfiable by this suite instead of
 * breaking it, AND every entry's anchors are proven to resolve against the source they
 * name — an anchor that rotted because the code moved fails here, at PR time, rather than
 * turning the gate into an exit-2 no-op on the build host.
 *
 * 🔴 The fixtures encode REAL base64-VLQ mappings rather than a stub string, because the
 * decoder is the part of the gate most able to be silently wrong. `encodeMappings` below
 * is an independent implementation: if the gate's decoder and this encoder ever disagree,
 * the healthy case goes red.
 */

const GATE = path.resolve(__dirname, '../assert-compiled-branches.mjs');
const REPO_ROOT = path.resolve(__dirname, '../..');

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'compiled-branches-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// --------------------------------------------------------------------------------------
// A minimal, independent base64-VLQ encoder, so the fixtures exercise the gate's real
// decode path instead of a hand-written `mappings` string that happens to parse.
// --------------------------------------------------------------------------------------
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function encodeVLQ(value: number): string {
  let v = value < 0 ? (-value << 1) | 1 : value << 1;
  let out = '';
  do {
    let digit = v & 31;
    v >>>= 5;
    if (v > 0) digit |= 32;
    out += B64[digit];
  } while (v > 0);
  return out;
}

/**
 * Build a `mappings` string that places one segment per requested SOURCE line (1-based),
 * all attributed to source index 0, each on its own generated line.
 */
function encodeMappings(sourceLines: number[]): string {
  let prevSourceLine = 0;
  return sourceLines
    .map((line) => {
      const delta = line - 1 - prevSourceLine;
      prevSourceLine = line - 1;
      // [generatedColumn, sourceIndex, sourceLine, sourceColumn]
      return encodeVLQ(0) + encodeVLQ(0) + encodeVLQ(delta) + encodeVLQ(0);
    })
    .join(';');
}

/** Write one emitted chunk + its map into the fake `.next/server`. */
function chunk(name: string, sourceModule: string, mappedSourceLines: number[]) {
  const full = path.join(dir, 'server', name);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, '/* emitted */');
  writeFileSync(
    `${full}.map`,
    JSON.stringify({
      version: 3,
      // Turbopack writes paths like `[project]/src/server/x.ts`; the gate matches by
      // substring, so the fixture uses the same shape rather than a bare relative path.
      sources: [`[project]/${sourceModule}`],
      names: [],
      mappings: encodeMappings(mappedSourceLines),
    })
  );
}

/** 1-based line of the single source line containing `code`. Throws if not unique. */
function lineOf(module: string, code: string): number {
  const text = readFileSync(path.join(REPO_ROOT, module), 'utf8').split('\n');
  const hits = text.map((l, i) => (l.includes(code) ? i + 1 : 0)).filter(Boolean);
  if (hits.length !== 1) {
    throw new Error(`anchor ${JSON.stringify(code)} matched ${hits.length} lines in ${module}`);
  }
  return hits[0];
}

type Entry = (typeof COMPILED_BRANCH_WATCHLIST)[number];

/** Every anchor line an entry declares — control first, then required. */
function allLines(entry: Entry): { control: number[]; required: number[] } {
  return {
    control: entry.control.map((a) => lineOf(entry.module, a.code)),
    required: entry.required.map((a) => lineOf(entry.module, a.code)),
  };
}

/**
 * The healthy baseline: for every watchlist entry, one chunk that maps every anchor line
 * it declares. `omitRequired` drops specific required anchors so a case can express "this
 * one branch is missing" without hand-writing the rest of the list.
 */
function healthyBaseline(opts: { skipEntryId?: string } = {}) {
  COMPILED_BRANCH_WATCHLIST.forEach((entry, i) => {
    if (entry.id === opts.skipEntryId) return;
    const { control, required } = allLines(entry);
    chunk(`chunks/healthy-${i}.js`, entry.module, [...control, ...required]);
  });
}

const run = (extra: string[] = []) =>
  spawnSync(process.execPath, [GATE, '--next-dir', dir, '--repo-root', REPO_ROOT, ...extra], {
    encoding: 'utf8',
  });
const output = (r: ReturnType<typeof run>) => `${r.stdout}${r.stderr}`;

// --------------------------------------------------------------------------------------

describe('assert-compiled-branches', () => {
  it('the watchlist is non-empty and every anchor resolves to exactly one source line', () => {
    // The gate is worth nothing if its entries no longer point at real code. This asserts
    // it directly rather than leaving it to the exit-2 branch on a build host.
    expect(COMPILED_BRANCH_WATCHLIST.length).toBeGreaterThan(0);
    for (const entry of COMPILED_BRANCH_WATCHLIST) {
      expect(entry.control.length, `${entry.id} must declare a control anchor`).toBeGreaterThan(0);
      expect(entry.required.length, `${entry.id} must declare required anchors`).toBeGreaterThan(0);
      expect(() => allLines(entry)).not.toThrow();
    }
  });

  it('passes when every watched branch is represented in the output', () => {
    healthyBaseline();
    const r = run();
    expect(output(r)).toContain('every watched branch is represented');
    expect(r.status).toBe(0);
  });

  it('reports the number of chunks each module was emitted into (the scan observed something)', () => {
    // Positive control on the instrument: a zero here would be indistinguishable from a
    // scan wired to nothing, so the count must move with the fixture.
    const entry = COMPILED_BRANCH_WATCHLIST[0];
    const { control, required } = allLines(entry);
    healthyBaseline({ skipEntryId: entry.id });
    chunk('chunks/copy-a.js', entry.module, [...control, ...required]);
    chunk('chunks/ssr/copy-b.js', entry.module, [...control, ...required]);
    const r = run();
    expect(r.status).toBe(0);
    expect(output(r)).toContain('emitted into 2 chunk(s)');
  });

  it('decodes NEGATIVE source-line deltas (segments emitted out of source order)', () => {
    // 🔴 This case exists because a mutation survived without it. Every other fixture
    // lists its source lines ascending, so every encoded delta is non-negative and the
    // decoder's sign branch is never reached — breaking it left the suite fully green.
    // Real maps reorder freely (the minifier hoists and merges), so negative deltas are
    // the common case in the output this gate actually reads.
    const entry = COMPILED_BRANCH_WATCHLIST[0];
    const { control, required } = allLines(entry);
    const descending = [...control, ...required].sort((a, b) => b - a);
    expect(descending[0]).toBeGreaterThan(descending[descending.length - 1]); // a real negative delta

    healthyBaseline({ skipEntryId: entry.id });
    chunk('chunks/reordered.js', entry.module, descending);

    const r = run();
    expect(output(r)).toContain('every watched branch is represented');
    expect(r.status).toBe(0);
  });

  it('FAILS (exit 1) naming the branch when a required anchor has no mapping', () => {
    const entry = COMPILED_BRANCH_WATCHLIST[0];
    const { control, required } = allLines(entry);
    healthyBaseline({ skipEntryId: entry.id });
    // control mapped, first required anchor deliberately absent
    chunk('chunks/truncated.js', entry.module, [...control, ...required.slice(1)]);

    const r = run();
    expect(r.status).toBe(1);
    const out = output(r);
    expect(out).toContain('A SECURITY-RELEVANT BRANCH IS ABSENT FROM THE COMPILED OUTPUT');
    expect(out).toContain(`MISSING  line ${required[0]}: ${entry.required[0].code}`);
    // and it must NOT claim the still-present ones are missing
    expect(out).not.toContain(`MISSING  line ${required[1] ?? -1}:`);
  });

  it('--warn-only downgrades a violation to exit 0 but still prints the whole report', () => {
    const entry = COMPILED_BRANCH_WATCHLIST[0];
    const { control, required } = allLines(entry);
    healthyBaseline({ skipEntryId: entry.id });
    chunk('chunks/truncated.js', entry.module, [...control, ...required.slice(1)]);

    const r = run(['--warn-only']);
    expect(r.status).toBe(0);
    const out = output(r);
    expect(out).toContain('A SECURITY-RELEVANT BRANCH IS ABSENT FROM THE COMPILED OUTPUT');
    expect(out).toContain(`MISSING  line ${required[0]}`);
    expect(out).toContain('--warn-only is set');
  });

  it('--warn-only does NOT downgrade "could not run" — a blind gate still fails', () => {
    // The whole point of exit 2 is that it is not a verdict about the code. Letting
    // --warn-only swallow it would turn a gate that stopped looking into a gate that
    // reports health, which is the failure mode this file exists to prevent.
    mkdirSync(path.join(dir, 'server', 'chunks'), { recursive: true });
    writeFileSync(path.join(dir, 'server', 'chunks', 'lonely.js'), '/* no map */');
    const r = run(['--warn-only']);
    expect(r.status).toBe(2);
    expect(output(r)).toContain('found no .js.map');
  });

  it('REFUSES (exit 2) rather than reporting a violation when the control anchor is unmapped', () => {
    // A module the build never emitted makes every anchor unmapped. That is a broken
    // input, not N violations — and reporting it as violations is how a gate gets
    // dismissed as noisy and then ignored.
    const entry = COMPILED_BRANCH_WATCHLIST[0];
    const { required } = allLines(entry);
    healthyBaseline({ skipEntryId: entry.id });
    chunk('chunks/no-control.js', entry.module, required);

    const r = run();
    expect(r.status).toBe(2);
    const out = output(r);
    expect(out).toContain('CANNOT OBSERVE');
    expect(out).not.toContain('A SECURITY-RELEVANT BRANCH IS ABSENT');
  });

  it('REFUSES (exit 2) when the build emitted no source maps at all', () => {
    mkdirSync(path.join(dir, 'server', 'chunks'), { recursive: true });
    writeFileSync(path.join(dir, 'server', 'chunks', 'lonely.js'), '/* no map */');
    const r = run();
    expect(r.status).toBe(2);
    expect(output(r)).toContain('found no .js.map');
  });

  it('REFUSES (exit 2) when there is no server output to read', () => {
    const r = spawnSync(
      process.execPath,
      [GATE, '--next-dir', path.join(dir, 'does-not-exist'), '--repo-root', REPO_ROOT],
      { encoding: 'utf8' }
    );
    expect(r.status).toBe(2);
    expect(output(r)).toContain('no server output at');
  });

  it('REFUSES (exit 2) when an anchor matches no line in the module it names', () => {
    healthyBaseline();
    const wl = path.join(dir, 'wl-missing.mjs');
    writeFileSync(
      wl,
      `export const COMPILED_BRANCH_WATCHLIST = [{
         id: 'synthetic', module: 'scripts/compiled-branch-watchlist.mjs', why: 'test',
         control: [{ code: 'COMPILED_BRANCH_WATCHLIST', why: 'c' }],
         required: [{ code: 'this string is not in that file at all', why: 'r' }],
       }];`
    );
    const r = run(['--watchlist', wl]);
    expect(r.status).toBe(2);
    expect(output(r)).toContain('no line contains this anchor');
  });

  it('REFUSES (exit 2) when an anchor is ambiguous', () => {
    // An anchor matching several lines would silently check whichever one it landed on.
    healthyBaseline();
    const wl = path.join(dir, 'wl-ambiguous.mjs');
    writeFileSync(
      wl,
      `export const COMPILED_BRANCH_WATCHLIST = [{
         id: 'synthetic', module: 'scripts/compiled-branch-watchlist.mjs', why: 'test',
         control: [{ code: 'COMPILED_BRANCH_WATCHLIST', why: 'c' }],
         required: [{ code: ' * ', why: 'r' }],
       }];`
    );
    const r = run(['--watchlist', wl]);
    expect(r.status).toBe(2);
    expect(output(r)).toContain('anchor is ambiguous');
  });

  it('ignores chunks whose maps do not carry the watched module', () => {
    // Attribution is by source map, so unrelated chunks must neither satisfy nor break an
    // entry. Without this, a build with many chunks could mask a real miss.
    healthyBaseline();
    const entry = COMPILED_BRANCH_WATCHLIST[0];
    const { control, required } = allLines(entry);
    chunk('chunks/unrelated.js', 'src/some/other/module.ts', [...control, ...required]);
    const r = run();
    expect(r.status).toBe(0);
    expect(output(r)).toContain(`emitted into 1 chunk(s)`);
  });
});
