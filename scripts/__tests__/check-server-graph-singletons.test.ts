import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
  writeFileSync(
    `${base}.map`,
    JSON.stringify({ version: 3, sources, names: [], mappings: '' })
  );
}

/** The healthy baseline every case starts from: a singleton otel-logs, emitted once. */
function healthyOtelLogs() {
  chunk('chunks/instrumentation.js', [`../../${OTEL_MODULE}`], 'module.exports=[1,()=>{}]');
}

const run = () =>
  spawnSync(process.execPath, [GATE, '--next-dir', dir], { encoding: 'utf8' });

const output = (r: ReturnType<typeof run>) => `${r.stdout}${r.stderr}`;

describe('check-server-graph-singletons', () => {
  // -------------------------------------------------------------------------
  // The gate can PASS. Without this, every assertion below is satisfied by a
  // gate that is simply always red, which detects nothing.
  // -------------------------------------------------------------------------
  it('POSITIVE CONTROL: passes when every copy carries the pin and the singleton is emitted once', () => {
    healthyOtelLogs();
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
    healthyOtelLogs();
    chunk('chunks/a.js', [`../../${SINK_MODULE}`], `globalThis.${SINK_KEY}??={}`);
    // The regression: this copy holds a private module-scope object instead.
    chunk('chunks/ssr/b.js', [`../../../${SINK_MODULE}`], 'const sink={}');

    const r = run();
    expect(r.status).toBe(1);
    expect(output(r)).toContain(`1 of 2 emitted copies do NOT reference \`globalThis.${SINK_KEY}\``);
    // Names the offending chunk, so the failure is actionable rather than just red.
    expect(output(r)).toContain('chunks/ssr/b.js');
  });

  it('counts EVERY unpinned copy, not just the first', () => {
    healthyOtelLogs();
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
    healthyOtelLogs();
    // No chunk mentions the sink module at all — e.g. it was renamed and the
    // watchlist path went stale.
    const r = run();
    expect(r.status).toBe(1);
    expect(output(r)).toContain('matched 0 emitted chunks');
    expect(output(r)).toContain('examined NOTHING');
  });

  // -------------------------------------------------------------------------
  // SINGLETON
  // -------------------------------------------------------------------------
  it('FAILS when a SINGLETON module is emitted more than once', () => {
    chunk('chunks/a.js', [`../../${SINK_MODULE}`], `globalThis.${SINK_KEY}??={}`);
    chunk('chunks/instrumentation.js', [`../../${OTEL_MODULE}`], 'module.exports=[1,()=>{}]');
    // A second copy: something in the request graph pulled the bridge in.
    chunk('chunks/ssr/page.js', [`../../../${OTEL_MODULE}`], 'module.exports=[2,()=>{}]');

    const r = run();
    expect(r.status).toBe(1);
    expect(output(r)).toContain('emitted 2 times, expected exactly 1');
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
