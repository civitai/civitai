import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { normalise, parseStub, stubFor } from '../dedupe-server-chunks.mjs';

/**
 * `scripts/dedupe-server-chunks.mjs` replaces duplicate Turbopack server chunks (same bytes
 * apart from the trailing sourceMappingURL comment) with a one-line stub that re-exports the
 * canonical sibling. These cases drive the CLI over synthetic `.next/server` trees shaped
 * like the real output: `module.exports=[id, factory, …]` chunks, an entry file that loads
 * them with `R.c("server/chunks/…")`, and a chunk whose async loader lists chunk paths for
 * `s.l(…)`.
 *
 * The load-bearing claim is behavioural, not textual: after the run, requiring a duplicate's
 * path must hand back THE SAME module array as the canonical (so its source is never
 * compiled), while every referenced path still loads. That is asserted by loading the tree
 * in a child Node process, never by reading the stub's text.
 */

const SCRIPT = path.resolve(__dirname, '../dedupe-server-chunks.mjs');

let root: string; // plays the role of `.next`
let server: string; // `.next/server`

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'dedupe-chunks-'));
  server = path.join(root, 'server');
  mkdirSync(path.join(server, 'chunks', 'ssr'), { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const chunk = (name: string, body: string) =>
  `module.exports=[${body}];\n\n//# sourceMappingURL=${name}.map\n`;

function write(rel: string, content: string) {
  const p = path.join(server, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content);
}
const read = (rel: string) => readFileSync(path.join(server, rel), 'utf8');

function run(...args: string[]) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/** Load `rels` (relative to `.next`) in a fresh Node process; report identity + factory ids. */
function loadInChild(rels: string[]) {
  const src = `
    const path = require('path');
    const root = ${JSON.stringify(root)};
    const arrays = ${JSON.stringify(rels)}.map((r) => require(path.resolve(root, r)));
    const ids = arrays.map((a) => a.filter((x) => typeof x === 'number'));
    const same = arrays.map((a) => arrays.indexOf(a));
    // Run every factory once so a broken chunk throws here.
    const vals = arrays.map((a) => a.filter((x) => typeof x === 'function').map((f) => f()));
    process.stdout.write(JSON.stringify({ ids, same, vals }));
  `;
  const r = spawnSync(process.execPath, ['-e', src], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`child failed: ${r.stderr}`);
  return JSON.parse(r.stdout) as { ids: number[][]; same: number[]; vals: string[][] };
}

/** A small tree with every reference kind the real build uses. */
function seedRealisticTree() {
  // Three copies of one chunk (only the sourceMappingURL differs), plus an unrelated chunk.
  write('chunks/_b2._.js', chunk('_b2._.js', `101,()=>"shared"`));
  write('chunks/_a1._.js', chunk('_a1._.js', `101,()=>"shared"`));
  write('chunks/_c3._.js', chunk('_c3._.js', `101,()=>"shared"`));
  write('chunks/_other._.js', chunk('_other._.js', `202,()=>"other"`));
  // A chunk whose async loader names a duplicate by path (the `s.l` reference kind).
  write(
    'chunks/_loader._.js',
    chunk(
      '_loader._.js',
      `303,()=>JSON.stringify(["server/chunks/_c3._.js","server/chunks/_other._.js"])`
    )
  );
  // An entry file referencing chunks via R.c (the entry reference kind).
  write(
    'pages/api/x.js',
    [
      'var R=require("../../chunks/[turbopack]_runtime.js")("server/pages/api/x.js")',
      'R.c("server/chunks/_b2._.js")',
      'R.c("server/chunks/_loader._.js")',
      'module.exports=R.m(303)',
      '',
    ].join('\n')
  );
}

describe('dedupe-server-chunks', () => {
  it('reports the bytes the stubs replaced', () => {
    const big = `1,()=>"${'a'.repeat(3 * 2 ** 20)}"`; // ~3 MiB per copy
    write('chunks/_a._.js', chunk('_a._.js', big));
    write('chunks/_b._.js', chunk('_b._.js', big));
    write('chunks/_c._.js', chunk('_c._.js', big));

    const r = run(server);

    expect(r.code).toBe(0);
    expect(r.out).toContain('stubbed 2 duplicates (6.0 MiB)');
  });

  it('stubs files identical apart from the sourceMappingURL to the first sibling by name', () => {
    seedRealisticTree();
    const before = read('chunks/_a1._.js');

    const r = run(server);

    expect(r.code).toBe(0);
    expect(r.out).toContain('stubbed 2 duplicates');
    expect(read('chunks/_a1._.js')).toBe(before); // canonical untouched
    expect(parseStub(readFileSync(path.join(server, 'chunks/_b2._.js')))).toBe('_a1._.js');
    expect(parseStub(readFileSync(path.join(server, 'chunks/_c3._.js')))).toBe('_a1._.js');
  });

  it('every referenced duplicate path loads, and loads the canonical module array itself', () => {
    seedRealisticTree();
    const refs = [
      'server/chunks/_a1._.js',
      'server/chunks/_b2._.js', // R.c reference from the entry
      'server/chunks/_c3._.js', // s.l reference inside a chunk
      'server/chunks/_other._.js',
    ];

    // Control: before the run, each duplicate path is a separately compiled array.
    const pre = loadInChild(refs);
    expect(pre.same).toEqual([0, 1, 2, 3]);

    expect(run(server).code).toBe(0);

    const post = loadInChild(refs);
    // One array object for all three copies — the duplicate source was never compiled.
    expect(post.same).toEqual([0, 0, 0, 3]);
    expect(post.ids).toEqual([[101], [101], [101], [202]]);
    expect(post.vals).toEqual([['shared'], ['shared'], ['shared'], ['other']]);
  });

  it('does not group files whose content differs anywhere but the trailing comment', () => {
    write('chunks/_a._.js', chunk('_a._.js', `1,()=>"x"`));
    write('chunks/_b._.js', chunk('_b._.js', `1,()=>"y"`));
    // A sourceMappingURL comment that is NOT at the end of the file is content.
    write('chunks/_c._.js', `module.exports=[1,()=>"x"];\n//# sourceMappingURL=_c._.js.map\n0;\n`);
    write('chunks/_d._.js', `module.exports=[1,()=>"x"];\n//# sourceMappingURL=_d._.js.map\n1;\n`);
    const snapshot = ['_a', '_b', '_c', '_d'].map((n) => read(`chunks/${n}._.js`));

    const r = run(server);

    expect(r.code).toBe(0);
    expect(r.out).toContain('stubbed 0 duplicates');
    expect(['_a', '_b', '_c', '_d'].map((n) => read(`chunks/${n}._.js`))).toEqual(snapshot);
  });

  it('never groups across directories and never touches a runtime file', () => {
    const body = chunk('x', `7,()=>"same"`);
    write('chunks/_a._.js', body);
    write('chunks/ssr/_a._.js', body);
    write('chunks/[turbopack]_runtime.js', body);

    const r = run(server);

    expect(r.code).toBe(0);
    expect(r.out).toContain('stubbed 0 duplicates');
    expect(read('chunks/ssr/_a._.js')).toBe(body);
    expect(read('chunks/[turbopack]_runtime.js')).toBe(body);
  });

  it('is idempotent: a second run changes nothing', () => {
    seedRealisticTree();
    expect(run(server).code).toBe(0);
    const names = ['_a1', '_b2', '_c3', '_other', '_loader'];
    const afterFirst = names.map((n) => read(`chunks/${n}._.js`));

    const second = run(server);

    expect(second.code).toBe(0);
    expect(second.out).toContain('stubbed 0 duplicates');
    expect(second.out).toContain('2 already stubbed');
    expect(names.map((n) => read(`chunks/${n}._.js`))).toEqual(afterFirst);
  });

  it('--dry-run reports the duplicates and writes nothing', () => {
    seedRealisticTree();
    const before = read('chunks/_b2._.js');

    const r = run(server, '--dry-run');

    expect(r.code).toBe(0);
    expect(r.out).toContain('would stub 2 duplicates');
    expect(read('chunks/_b2._.js')).toBe(before);
  });

  it('fails loudly (exit 1) when a stub points at a chunk that does not exist', () => {
    write('chunks/_real._.js', chunk('_real._.js', `1,()=>"x"`));
    write('chunks/_dangling._.js', stubFor('_missing._.js'));

    const r = run(server);

    expect(r.code).toBe(1);
    expect(r.err).toContain('_dangling._.js: stub target _missing._.js does not exist');
  });

  it('fails loudly (exit 1) when a stub points at another stub', () => {
    write('chunks/_real._.js', chunk('_real._.js', `1,()=>"x"`));
    write('chunks/_s1._.js', stubFor('_real._.js'));
    write('chunks/_s2._.js', stubFor('_s1._.js'));

    const r = run(server);

    expect(r.code).toBe(1);
    expect(r.err).toContain('_s2._.js: stub target _s1._.js is itself a stub');
  });

  it('exits 2 when there is nothing to observe', () => {
    expect(run(path.join(root, 'nope')).code).toBe(2);
    expect(run(server).code).toBe(2); // chunks/ exists but holds no .js files
    expect(run().code).toBe(2);
  });

  it('exits 2 when the only .js files are runtime files', () => {
    write('chunks/[turbopack]_runtime.js', 'module.exports=()=>({});\n');
    write('chunks/_a._.cjs', chunk('_a._.cjs', `1,()=>"x"`));

    const r = run(server);

    expect(r.code).toBe(2);
    expect(r.err).toContain('no .js chunk files besides the runtime files');
  });

  it('exits 2 with usage on an extra positional argument, even over a valid tree', () => {
    write('chunks/_a._.js', chunk('_a._.js', `1,()=>"x"`));

    const r = run(server, 'extra');

    expect(r.code).toBe(2);
    expect(r.err).toContain('usage:');
  });

  it('dedupes inside nested directories, each against its own in-directory canonical', () => {
    write('chunks/ssr/_0unique._.js', chunk('_0unique._.js', `1,()=>"u"`));
    write('chunks/ssr/_x1._.js', chunk('_x1._.js', `2,()=>"ssr"`));
    write('chunks/ssr/_x2._.js', chunk('_x2._.js', `2,()=>"ssr"`));
    write('chunks/ssr/route/_y1._.js', chunk('_y1._.js', `3,()=>"deep"`));
    write('chunks/ssr/route/_y2._.js', chunk('_y2._.js', `3,()=>"deep"`));

    const r = run(server);

    expect(r.code).toBe(0);
    expect(r.out).toContain(
      '5 chunk files, 3 distinct contents (per directory), stubbed 2 duplicates'
    );
    expect(parseStub(readFileSync(path.join(server, 'chunks/ssr/_x2._.js')))).toBe('_x1._.js');
    expect(parseStub(readFileSync(path.join(server, 'chunks/ssr/route/_y2._.js')))).toBe(
      '_y1._.js'
    );
    const post = loadInChild([
      'server/chunks/ssr/_x1._.js',
      'server/chunks/ssr/_x2._.js',
      'server/chunks/ssr/route/_y1._.js',
      'server/chunks/ssr/route/_y2._.js',
    ]);
    expect(post.same).toEqual([0, 0, 2, 2]);
    expect(post.vals).toEqual([['ssr'], ['ssr'], ['deep'], ['deep']]);
  });

  it('a unique chunk sorting first neither becomes a canonical nor hides later duplicates', () => {
    write('chunks/_0first._.js', chunk('_0first._.js', `1,()=>"first"`));
    write('chunks/_1dup._.js', chunk('_1dup._.js', `2,()=>"dup"`));
    write('chunks/_2dup._.js', chunk('_2dup._.js', `2,()=>"dup"`));
    const first = read('chunks/_0first._.js');

    const r = run(server);

    expect(r.code).toBe(0);
    expect(r.out).toContain(
      '3 chunk files, 2 distinct contents (per directory), stubbed 1 duplicates'
    );
    expect(read('chunks/_0first._.js')).toBe(first);
    expect(parseStub(readFileSync(path.join(server, 'chunks/_2dup._.js')))).toBe('_1dup._.js');
  });

  // Windows chmod only toggles the read-only bit, so 0o640 reads back as 0o666 there.
  it.skipIf(process.platform === 'win32')(
    'keeps the duplicate file mode when it writes the stub',
    () => {
      write('chunks/_a._.js', chunk('_a._.js', `1,()=>"x"`));
      write('chunks/_b._.js', chunk('_b._.js', `1,()=>"x"`));
      chmodSync(path.join(server, 'chunks/_b._.js'), 0o640);

      expect(run(server).code).toBe(0);

      expect(parseStub(readFileSync(path.join(server, 'chunks/_b._.js')))).toBe('_a._.js');
      expect(statSync(path.join(server, 'chunks/_b._.js')).mode & 0o777).toBe(0o640);
    }
  );

  it.each([
    ['a runtime file', '[turbopack]_runtime.js', 'is a runtime file'],
    ['a non-sibling path', 'ssr/_real._.js', 'is not a sibling'],
    ['a backslash path', 'ssr\\_real._.js', 'is not a sibling'],
    ['itself', '_bad._.js', 'is itself a stub'],
  ])('fails loudly (exit 1) when a stub points at %s', (_label, target, message) => {
    write('chunks/_real._.js', chunk('_real._.js', `1,()=>"x"`));
    write('chunks/ssr/_real._.js', chunk('_real._.js', `1,()=>"y"`));
    write('chunks/[turbopack]_runtime.js', 'module.exports=()=>({});\n');
    write('chunks/_bad._.js', stubFor(target));

    const r = run(server);

    expect(r.code).toBe(1);
    expect(r.err).toContain(`_bad._.js: stub target ${target} ${message}`);
  });

  it('leaves identical files that are not module.exports=[ chunks alone', () => {
    const body = 'globalThis.x=1;\nmodule.exports=[1,()=>"x"];\n';
    // Near misses a format change would plausibly produce: the `[` is part of the check.
    const objectBody = 'module.exports={a:1};\n';
    const fnBody = 'module.exports=()=>[1];\n';
    write('chunks/_a._.js', body);
    write('chunks/_b._.js', body);
    write('chunks/_c._.js', objectBody);
    write('chunks/_d._.js', objectBody);
    write('chunks/_e._.js', fnBody);
    write('chunks/_f._.js', fnBody);
    write('chunks/_real._.js', chunk('_real._.js', `1,()=>"r"`));
    // Not a .js file: not counted, not touched.
    write('chunks/_real._.js.map', '{}');

    const r = run(server);

    expect(r.code).toBe(0);
    expect(r.out).toContain('7 chunk files, 1 distinct contents');
    expect(r.out).toContain('stubbed 0 duplicates');
    expect(r.out).toContain('6 skipped (not a module.exports=[ chunk)');
    expect(read('chunks/_b._.js')).toBe(body);
    expect(read('chunks/_d._.js')).toBe(objectBody);
    expect(read('chunks/_f._.js')).toBe(fnBody);
  });

  it.each([1, 2])('exits 2 when none of %i files is in the module.exports=[ chunk format', (n) => {
    for (let i = 0; i < n; i++) write(`chunks/_${i}._.js`, 'globalThis.x=1;\n');
    write('chunks/[turbopack]_runtime.js', 'module.exports=()=>({});\n');

    const r = run(server);

    expect(r.code).toBe(2);
    expect(r.err).toContain(`none of the ${n} chunk files`);
    expect(read('chunks/_0._.js')).toBe('globalThis.x=1;\n');
  });

  it('reports runtime files separately from chunk files', () => {
    write('chunks/_a._.js', chunk('_a._.js', `1,()=>"x"`));
    write('chunks/[turbopack]_runtime.js', 'module.exports=()=>({});\n');
    write('chunks/ssr/[turbopack]_runtime.js', 'module.exports=()=>({});\n');

    const r = run(server);

    expect(r.code).toBe(0);
    expect(r.out).toContain('1 chunk files, 1 distinct contents');
    expect(r.out).toContain('2 runtime files left alone');
  });

  it('--dry-run still fails (exit 1) on a dangling stub already on disk', () => {
    write('chunks/_real._.js', chunk('_real._.js', `1,()=>"x"`));
    write('chunks/_dangling._.js', stubFor('_missing._.js'));

    const r = run(server, '--dry-run');

    expect(r.code).toBe(1);
    expect(r.err).toContain('_dangling._.js: stub target _missing._.js does not exist');
  });

  it('parseStub accepts only the exact stub shape', () => {
    expect(parseStub(Buffer.from(stubFor('_a._.js')))).toBe('_a._.js');
    // Marker text whose require() names a different file is not one of our stubs.
    const mismatched = stubFor('_a._.js').replace('"./_a._.js"', '"./_b._.js"');
    expect(parseStub(Buffer.from(mismatched))).toBeNull();
    // A real chunk that merely begins with the marker text is content.
    expect(parseStub(Buffer.from(`${stubFor('_a._.js')}module.exports=[1,()=>1];\n`))).toBeNull();
  });

  it('normalise strips only a trailing sourceMappingURL comment', () => {
    const b = (s: string) => Buffer.from(s, 'latin1');
    expect(normalise(b('A;\n//# sourceMappingURL=a.js.map\n')).toString()).toBe('A;');
    expect(normalise(b('A;\n//# sourceMappingURL=a.js.map')).toString()).toBe('A;');
    expect(normalise(b('A;\n//# sourceMappingURL=a.js.map\nB;\n')).toString()).toBe(
      'A;\n//# sourceMappingURL=a.js.map\nB;\n'
    );
  });
});
