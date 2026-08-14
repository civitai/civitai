import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WATCHLIST } from '../server-graph-watchlist.mjs';

/**
 * `scripts/check-server-graph-singletons.mjs` is a BUILD gate: it reads the emitted
 * server source maps to count how many runtime modules a source file became, and fails
 * when a module that must be a process-wide singleton is emitted with private state.
 *
 * These cases drive it against synthetic `.next/server` trees. That is deliberate — the
 * only alternative is a real `next build` (minutes), so nobody would run one per case,
 * and the branches that matter (a copy missing its globalThis pin, a singleton emitted
 * twice, a scan that observed nothing) are exactly the ones a healthy real build cannot
 * produce on demand.
 *
 * 🔴 Each case must fail for ITS OWN reason, so every expectation below asserts the
 * specific message that branch emits, not merely a non-zero exit. A gate with three
 * failure branches and one generic assertion is a gate with one tested branch.
 *
 * 🔴 The healthy baseline is derived from the gate's REAL watchlist, never a hand-written
 * copy of it. When this file kept its own list, adding a third watchlist entry made the
 * POSITIVE CONTROL go red — the new entry matched none of the fixture's chunks, so the
 * gate's "this rule examined NOTHING" branch fired on the case that is supposed to pass.
 * Deriving the fixture means a new entry is proven SATISFIABLE by this suite rather than
 * breaking it, and no future addition can silently un-test a branch.
 */

const GATE = path.resolve(__dirname, '../check-server-graph-singletons.mjs');

const SINK_MODULE = 'src/server/logging/structured-log-sink.ts';
const SINK_KEY = '__civitaiStructuredLogSink';
const OTEL_MODULE = 'packages/civitai-telemetry/src/otel-logs.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'graph-gate-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Write one emitted chunk + its source map into the fake `.next/server`.
 * `sources` are the source modules the bundler inlined into that chunk; `code` is the
 * emitted JS the gate greps for a globalThis pin.
 */
function chunk(name: string, sources: string[], code: string) {
  const serverDir = path.join(dir, 'server', path.dirname(name));
  mkdirSync(serverDir, { recursive: true });
  const base = path.join(dir, 'server', name);
  writeFileSync(base, code);
  writeFileSync(`${base}.map`, JSON.stringify({ version: 3, sources, names: [], mappings: '' }));
}

/**
 * A healthy emitted fixture for one watchlist entry: a SINGLETON gets exactly one chunk,
 * a SHARED_STATE entry gets two chunks that both carry its `globalThis` pin.
 */
function healthyFixtureFor(entry: (typeof WATCHLIST)[number], i: number) {
  if (entry.rule === 'SINGLETON') {
    chunk(`chunks/baseline-${i}.js`, [`../../${entry.module}`], 'module.exports=[1,()=>{}]');
    return;
  }
  const pin = `globalThis.${entry.globalKey}??={}`;
  chunk(`chunks/baseline-${i}-a.js`, [`../../${entry.module}`], pin);
  chunk(`chunks/ssr/baseline-${i}-b.js`, [`../../../${entry.module}`], pin);
}

/**
 * The healthy baseline every case starts from — derived from the gate's REAL watchlist,
 * so a new entry is exercised here automatically instead of breaking the suite.
 *
 * `except` omits the module the case under test drives itself, so that case controls its
 * own copy count and its assertions stay exact (e.g. "1 of 2 emitted copies").
 */
function healthyBaselineExcept(...except: string[]) {
  WATCHLIST.forEach((entry, i) => {
    if (!except.includes(entry.module)) healthyFixtureFor(entry, i);
  });
}

const run = () => spawnSync(process.execPath, [GATE, '--next-dir', dir], { encoding: 'utf8' });

const output = (r: ReturnType<typeof run>) => `${r.stdout}${r.stderr}`;

/**
 * 🔴 These pin the WATCHLIST itself against ground truth — the real source files — and
 * they are the half that the synthetic cases below CANNOT provide.
 *
 * The fixtures further down are derived from the watchlist, which is what makes them
 * survive a new entry. The cost is that a derived fixture moves WITH a wrong entry and
 * therefore agrees with it: a mangled `globalKey`, a stale `module` path and a flipped
 * `rule` were all measured to leave every synthetic case green. An expectation derived
 * from the thing under test proves nothing about it.
 *
 * So correctness of an entry is asserted against the repo instead: the module must
 * exist, and a SHARED_STATE module must really reference its own key in source. Those
 * facts are independent of the watchlist, so they kill exactly the mutants the derived
 * fixtures cannot.
 */
describe('watchlist entries describe reality', () => {
  const repoRoot = path.resolve(__dirname, '../..');

  it('names at least one entry (a suite over an empty list asserts nothing)', () => {
    expect(WATCHLIST.length).toBeGreaterThan(0);
  });

  it.each(WATCHLIST.map((e) => [e.module, e] as const))(
    '%s exists and matches its rule',
    (module, entry) => {
      const source = readFileSync(path.join(repoRoot, module), 'utf8');

      if (entry.rule === 'SHARED_STATE') {
        // The pin the gate greps for in the EMITTED output has to be in the source that
        // produced it. A watchlist key nothing writes can only ever report a false FAIL.
        expect(entry.globalKey).toBeTruthy();

        // 🔴 Assert the ADOPT-OR-CREATE form, not merely that the key is spelled somewhere.
        // Two mutants motivate each half of this, both of which a `toContain` passes:
        //
        //  - the key surviving in a COMMENT while the real binding went back to module scope.
        //    Hence comments are stripped first: a token inside `//` or `/* */` is not code, and
        //    "the text is present" and "the binding exists" are different facts.
        //  - `??=` weakened to `=`. That is the ORIGINAL bug in one character: the second copy
        //    of the module to evaluate REPLACES the registry instead of adopting it, orphaning
        //    every mark the first copy recorded. The gate itself cannot see this — its
        //    SHARED_STATE rule greps emitted chunks for a REFERENCE to the key, and `=`
        //    references it just as `??=` does (measured: a chunk assigning with `=` passes the
        //    gate). This assertion is the only thing standing between that and a silent
        //    reintroduction.
        // Deliberately narrow: it pins the ONE canonical form, so an equivalent spelling
        // (`globalThis[KEY] ??=`, or an aliased `const g = globalThis`) fails here even though
        // it would satisfy the gate. That trade is on purpose — this failure is LOUD and takes
        // one line to fix, whereas the false PASS it replaces was silent and shipped a
        // permanently-empty registry. If you land such a form, widen this, don't delete it.
        const code = source
          .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
          .replace(/^\s*\/\/.*$/gm, ''); // line comments
        const key = entry.globalKey!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        expect(code).toMatch(new RegExp(String.raw`globalThis\.${key}\s*\?\?=`));
      } else {
        // A SINGLETON is a copy-count rule; a globalKey on it would be silently ignored.
        expect(entry).not.toHaveProperty('globalKey');
      }
    }
  );
});

describe('check-server-graph-singletons', () => {
  // -------------------------------------------------------------------------
  // The gate can PASS. Without this, every assertion below is satisfied by a
  // gate that is simply always red, which detects nothing.
  // -------------------------------------------------------------------------
  it('POSITIVE CONTROL: passes when every copy carries the pin and the singleton is emitted once', () => {
    healthyBaselineExcept(SINK_MODULE);
    chunk('chunks/a.js', [`../../${SINK_MODULE}`], `globalThis.${SINK_KEY}??={}`);
    chunk('chunks/ssr/b.js', [`../../../${SINK_MODULE}`], `globalThis.${SINK_KEY}??={}`);

    const r = run();
    expect(output(r)).toContain('PASS');
    expect(r.status).toBe(0);
  });

  // -------------------------------------------------------------------------
  // SHARED_STATE — the branch that catches the bug this gate was built for.
  // -------------------------------------------------------------------------
  it('FAILS when one emitted copy does not reference the globalThis pin', () => {
    healthyBaselineExcept(SINK_MODULE);
    chunk('chunks/a.js', [`../../${SINK_MODULE}`], `globalThis.${SINK_KEY}??={}`);
    // The regression: this copy holds a private module-scope object instead.
    chunk('chunks/ssr/b.js', [`../../../${SINK_MODULE}`], 'const sink={}');

    const r = run();
    expect(r.status).toBe(1);
    expect(output(r)).toContain(
      `1 of 2 emitted copies do NOT reference \`globalThis.${SINK_KEY}\``
    );
    // Names the offending chunk, so the failure is actionable rather than just red.
    expect(output(r)).toContain('chunks/ssr/b.js');
  });

  it('counts EVERY unpinned copy, not just the first', () => {
    healthyBaselineExcept(SINK_MODULE);
    chunk('chunks/a.js', [`../../${SINK_MODULE}`], 'const sink={}');
    chunk('chunks/b.js', [`../../${SINK_MODULE}`], 'const sink={}');
    chunk('chunks/c.js', [`../../${SINK_MODULE}`], `globalThis.${SINK_KEY}??={}`);

    const r = run();
    expect(r.status).toBe(1);
    expect(output(r)).toContain('2 of 3 emitted copies');
  });

  // -------------------------------------------------------------------------
  // The wired-to-nothing branch. A rule whose subject it cannot find must FAIL,
  // never quietly pass — that is the whole premise of the gate.
  // -------------------------------------------------------------------------
  it('FAILS when a watched module matches no emitted chunk (rule examined nothing)', () => {
    healthyBaselineExcept(SINK_MODULE);
    // No chunk mentions the sink module at all — e.g. it was renamed and the
    // watchlist path went stale.
    const r = run();
    expect(r.status).toBe(1);
    expect(output(r)).toContain('matched 0 emitted chunks');
    expect(output(r)).toContain('examined NOTHING');
    // Exactly one violation proves the derived baseline really is healthy for every
    // OTHER entry — otherwise this case could go red without the sink being the cause.
    expect(output(r)).toContain('1 violation(s)');
  });

  // -------------------------------------------------------------------------
  // SINGLETON
  // -------------------------------------------------------------------------
  it('FAILS when a SINGLETON module is emitted more than once', () => {
    // Every OTHER watched module healthy, so the only violation in the output is the
    // one this case is about — a second violation would make it pass for a reason it
    // did not test.
    healthyBaselineExcept(OTEL_MODULE);
    chunk('chunks/instrumentation.js', [`../../${OTEL_MODULE}`], 'module.exports=[1,()=>{}]');
    // A second copy: something in the request graph pulled the bridge in.
    chunk('chunks/ssr/page.js', [`../../../${OTEL_MODULE}`], 'module.exports=[2,()=>{}]');

    const r = run();
    expect(r.status).toBe(1);
    expect(output(r)).toContain('emitted 2 times, expected exactly 1');
    expect(output(r)).toContain('1 violation(s)');
  });

  // -------------------------------------------------------------------------
  // "The gate could not run" must be distinguishable from "the gate passed".
  // Exit 2, not 0 — a scan that sees nothing is not evidence of health.
  // -------------------------------------------------------------------------
  it('EXITS 2 (not 0) when the build emitted no source maps', () => {
    const serverDir = path.join(dir, 'server', 'chunks');
    mkdirSync(serverDir, { recursive: true });
    writeFileSync(path.join(serverDir, 'a.js'), 'module.exports=[1,()=>{}]');

    const r = run();
    expect(r.status).toBe(2);
    expect(output(r)).toContain('found 0 source maps');
  });

  it('EXITS 2 (not 0) when there is no server build output at all', () => {
    const r = run();
    expect(r.status).toBe(2);
    expect(output(r)).toContain('was `next build` run first?');
  });
});
