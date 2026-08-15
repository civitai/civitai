/**
 * Per-file timing reporter for the unit suite.
 *
 * Vitest's summary line gives the phase totals for a whole run; this writes the same phases per
 * FILE, which is what tells you where the import cost actually sits. Output goes to
 * `.test-perf/runs/<label>.perf.json`, keyed by TESTPERF_LABEL.
 */
import { writeFileSync, mkdirSync } from 'fs';
import path from 'path';

export default class TestPerfReporter {
  onInit(ctx) {
    this.ctx = ctx;
    this.start = Date.now();
  }

  onTestRunEnd(testModules, unhandledErrors, reason) {
    const root = this.ctx?.config?.root ?? process.cwd();
    const label = process.env.TESTPERF_LABEL || 'run';
    const files = [];

    for (const mod of testModules ?? []) {
      let d = {};
      try {
        d = mod.diagnostic() ?? {};
      } catch {}
      let passed = 0;
      let failed = 0;
      let skipped = 0;
      try {
        for (const t of mod.children.allTests()) {
          const r = t.result();
          if (r?.state === 'passed') passed++;
          else if (r?.state === 'failed') failed++;
          else skipped++;
        }
      } catch {}
      files.push({
        file: path.relative(root, mod.moduleId).replace(/\\/g, '/'),
        // `collectDuration` is the import + collection phase — the cost this project is about.
        collect: round(d.collectDuration),
        setup: round(d.setupDuration),
        prepare: round(d.prepareDuration),
        env: round(d.environmentSetupDuration),
        duration: round(d.duration),
        heapMB: d.heap != null ? Math.round(d.heap / 1e6) : null,
        passed,
        failed,
        skipped,
      });
    }

    files.sort((a, b) => b.collect - a.collect);
    const sum = (k) => files.reduce((a, f) => a + (f[k] || 0), 0);
    const out = {
      label,
      reason,
      generatedAt: new Date().toISOString(),
      head: process.env.TESTPERF_HEAD ?? null,
      config: {
        isolate: this.ctx?.config?.isolate,
        pool: this.ctx?.config?.pool,
        maxWorkers: this.ctx?.config?.maxWorkers,
        argv: process.argv.slice(2).join(' '),
      },
      wallMs: Date.now() - this.start,
      totals: {
        files: files.length,
        tests: files.reduce((a, f) => a + f.passed + f.failed + f.skipped, 0),
        failed: files.reduce((a, f) => a + f.failed, 0),
        collectMs: sum('collect'),
        setupMs: sum('setup'),
        prepareMs: sum('prepare'),
        envMs: sum('env'),
        testMs: sum('duration'),
        unhandledErrors: (unhandledErrors ?? []).length,
      },
      files,
    };

    const dir = path.join(root, '.test-perf/runs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${label}.perf.json`), JSON.stringify(out, null, 2));
    console.log(
      `\n[test-perf] ${label}: wall ${(out.wallMs / 1000).toFixed(1)}s | collect ${(
        out.totals.collectMs / 1000
      ).toFixed(0)}s | setup ${(out.totals.setupMs / 1000).toFixed(0)}s | tests ${(
        out.totals.testMs / 1000
      ).toFixed(0)}s | ${out.totals.failed} failed -> .test-perf/runs/${label}.perf.json`
    );
  }
}

const round = (n) => (typeof n === 'number' ? Math.round(n) : 0);
