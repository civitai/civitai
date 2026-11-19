#!/usr/bin/env node
'use strict';
/**
 * The image feed benchmark's harness (README.md here). Three commands:
 *
 *   capture  read a window of production `image.getImagesAsPostsInfinite` requests served by the
 *            api-heavy (Next) pods out of Tempo (head-sampled traces) and write them as JSONL,
 *            { t, host, input, authed, durMs } per line, nothing else; plus `<out>.prod.json`, the
 *            in-situ p50s of those pods and of feed-go's served requests over the same window (the
 *            production gap the run's sanity gate compares against).
 *   run      replay those inputs at a fixed rate against each arm in turn (open loop), after a
 *            warm-up pass, for several rounds with the arm order rotated; record each request's
 *            status and latency; read each arm's container CPU from Prometheus; print one JSON
 *            summary. Signed in as the bench account by default (its session from
 *            FEED_BENCH_SESSION_FILE), or `--signed-out`.
 *   parity   send a sample of the inputs to every arm back to back and compare the bodies.
 *
 * Every command exits non-zero rather than print a result it cannot stand behind: no rows, fewer
 * rows than asked for, an empty comparison set, or a NaN in a summary.
 *
 * No dependencies beyond Node. Flags are `--name value` (`--target`/`--cpu` repeat, `name=value`);
 * `--signed-out` takes no value. The session is never printed, logged or written anywhere.
 */

/* eslint-disable @typescript-eslint/no-var-requires */
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const lib = require('./lib.cjs');

const BOOLEAN_FLAGS = new Set(['signed-out']);

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { _: command, target: [], cpu: [] };
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i].replace(/^--/, '');
    if (BOOLEAN_FLAGS.has(key)) {
      opts[key] = true;
      continue;
    }
    const value = rest[++i];
    if (value === undefined) throw new Error(`--${key} needs a value`);
    if (Array.isArray(opts[key])) opts[key].push(value);
    else opts[key] = value;
  }
  return opts;
}

function pairs(list, flag) {
  return list.map((s) => {
    const at = s.indexOf('=');
    if (at < 1) throw new Error(`--${flag} must be name=value, got ${s}`);
    return [s.slice(0, at), s.slice(at + 1)];
  });
}

function num(opts, key, fallback) {
  const v = opts[key] === undefined ? fallback : Number(opts[key]);
  if (!Number.isFinite(v)) throw new Error(`--${key} must be a number`);
  return v;
}

const log = (...a) => console.error(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

function readInputs(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/**
 * The session to replay with: undefined with `--signed-out`; otherwise read from the file
 * FEED_BENCH_SESSION_FILE names (the mounted Secret). A missing file is an error, never a silent
 * signed-out run.
 */
function loadSession(opts) {
  if (opts['signed-out']) return undefined;
  const file = process.env.FEED_BENCH_SESSION_FILE;
  if (!file)
    throw new Error('signed-in replay needs FEED_BENCH_SESSION_FILE (or pass --signed-out)');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw new Error(`cannot read the session file FEED_BENCH_SESSION_FILE names (${file})`);
  }
  return lib.parseSessionFile(text);
}

/** The rows a command replays, after the signed-in filter, with what was dropped logged. */
function rowsFor(opts, session) {
  const all = readInputs(opts.inputs);
  const { kept, dropped } = lib.selectRows(all, { signedIn: !!session, session });
  log(
    `inputs: ${all.length} captured, ${kept.length} kept (${
      session ? 'signed in' : 'signed out'
    });`,
    `dropped: ${JSON.stringify(dropped)}`
  );
  return kept;
}

// --- HTTP ------------------------------------------------------------------------------------------

const agents = {
  'http:': new http.Agent({ keepAlive: true, maxSockets: Infinity }),
  'https:': new https.Agent({ keepAlive: true, maxSockets: Infinity }),
};

/**
 * GET `base + row's path` as a browser on the captured host would: `Host` and a same-site
 * `Referer` (both the tRPC origin check and feed-go's need one), and the bench account's session
 * cookie when signed in. No API credential. Latency is from just before the request is written to
 * the last body byte. A `Set-Cookie` (a rolled session) is ignored: the original session stays valid.
 */
function get(base, row, { keepBody = false, timeoutMs = 30000, session } = {}) {
  const url = new URL(lib.requestPath(row), base);
  const mod = url.protocol === 'https:' ? https : http;
  const headers = { host: row.host, referer: `https://${row.host}/`, accept: 'application/json' };
  const cookie = lib.cookieFor(session, row.host);
  if (cookie) headers.cookie = cookie;
  return new Promise((resolve) => {
    const started = performance.now();
    const req = mod.request(
      url,
      { method: 'GET', agent: agents[url.protocol], headers, timeout: timeoutMs },
      (res) => {
        const chunks = [];
        let bytes = 0;
        res.on('data', (c) => {
          bytes += c.length;
          if (keepBody) chunks.push(c);
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            latencyMs: performance.now() - started,
            bytes,
            body: keepBody ? Buffer.concat(chunks).toString('utf8') : undefined,
          })
        );
        res.on('error', (e) => resolve({ status: 'error', error: e.message }));
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ status: 'error', error: e.message }));
    req.end();
  });
}

async function getJson(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    (u.protocol === 'https:' ? https : http)
      .get(u, (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`${res.statusCode} from ${u.host}`));
          try {
            resolve(JSON.parse(raw));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

// --- capture ---------------------------------------------------------------------------------------

/**
 * The api-heavy (Next) pods only: the in-situ latency is compared with the `next` arm, which is
 * api-heavy's container. The standalone-server arm of that pool (`-api-heavy-sa-` pods) and the
 * other pools sharing the service name are excluded by pod name (`host.name`).
 */
const DEFAULT_TRACEQL =
  '{ resource.service.name = "civitai-dp-prod-api" && resource.host.name =~ "civitai-dp-prod-api-heavy-.*" && resource.host.name !~ "civitai-dp-prod-api-heavy-sa-.*" && span.http.url =~ ".*/api/trpc/image\\\\.getImagesAsPostsInfinite\\\\?.*" }';
/** feed-go's served (not fallen-back) answers of the procedure, durations only. */
const DEFAULT_GO_TRACEQL =
  '{ resource.service.name = "feed-go" && name = "serve as-posts" && span.feed_go.outcome = "served" }';

async function tempoWindows(tempo, traceql, { minutes, windowSec, limit, end }, onJson) {
  let full = 0;
  for (let s = end - minutes * 60; s < end; s += windowSec) {
    const q = new URLSearchParams({
      q: traceql,
      start: String(s),
      end: String(Math.min(s + windowSec, end)),
      limit: String(limit),
      spss: '10',
    });
    const json = await getJson(`${tempo.replace(/\/$/, '')}/api/search?${q}`);
    if ((json.traces || []).length >= limit) full++;
    onJson(json);
  }
  return full;
}

async function capture(opts) {
  const tempo = opts.tempo;
  const out = opts.out;
  if (!tempo || !out) throw new Error('capture needs --tempo <url> --out <file>');
  const window = {
    minutes: num(opts, 'minutes', 60),
    windowSec: num(opts, 'window-sec', 60),
    limit: num(opts, 'limit', 1000),
    end: num(opts, 'end', Math.floor(Date.now() / 1000) - 120),
  };
  const rows = [];
  const full = await tempoWindows(tempo, opts.traceql || DEFAULT_TRACEQL, window, (json) =>
    rows.push(...lib.captureRowsFromTempoSearch(json))
  );
  const goDur = [];
  const goFull = await tempoWindows(
    tempo,
    opts['go-traceql'] || DEFAULT_GO_TRACEQL,
    window,
    (json) => goDur.push(...lib.spanDurationsFromTempoSearch(json))
  );
  lib.requireRows(rows.length, 1, 'capture');
  rows.sort((a, b) => a.t - b.t);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const prod = {
    // Both cohorts: the run uses the one it replays (authed when signed in).
    node: lib.summarize(rows.map((r) => r.durMs)),
    nodeAuthed: lib.summarize(rows.filter((r) => r.authed).map((r) => r.durMs)),
    go: lib.summarize(goDur),
  };
  fs.writeFileSync(`${out}.prod.json`, JSON.stringify(prod));
  const hosts = {};
  for (const r of rows) hosts[r.host] = (hosts[r.host] || 0) + 1;
  console.log(
    JSON.stringify({
      command: 'capture',
      rows: rows.length,
      authedRows: rows.filter((r) => r.authed).length,
      windows: Math.ceil((window.minutes * 60) / window.windowSec),
      // A window that hit --limit was truncated: the capture under-samples it. Shrink --window-sec.
      windowsAtLimit: full,
      goWindowsAtLimit: goFull,
      hosts,
      prod,
      out,
    })
  );
}

// --- Prometheus (container CPU) --------------------------------------------------------------------

async function cpuSeconds(prom, selector, startSec, endSec) {
  const dur = Math.max(1, Math.round(endSec - startSec));
  const q = `sum(increase(container_cpu_usage_seconds_total{${selector}}[${dur}s]))`;
  const json = await getJson(
    `${prom.replace(/\/$/, '')}/api/v1/query?${new URLSearchParams({
      query: q,
      time: String(endSec),
    })}`
  );
  const v = json.data && json.data.result && json.data.result[0];
  return v ? Number(v.value[1]) : NaN;
}

// --- run -------------------------------------------------------------------------------------------

async function replay(base, items, { rps, maxInFlight, timeoutMs, session }) {
  return lib.runOpenLoop({
    items,
    rps,
    maxInFlight,
    now: () => performance.now(),
    sleepUntil: (t) => sleep(t - performance.now()),
    send: (row) => get(base, row, { timeoutMs, session }),
  });
}

function statusCounts(results) {
  const out = {};
  for (const r of results) out[r.status] = (out[r.status] || 0) + 1;
  return out;
}

async function run(opts) {
  const targets = pairs(opts.target, 'target');
  if (!opts.inputs || !targets.length) throw new Error('run needs --inputs and --target name=url');
  const session = loadSession(opts);
  const rps = num(opts, 'rps', 2);
  const all = rowsFor(opts, session);
  const count = num(opts, 'count', all.length);
  lib.requireRows(all.length, count, 'run');
  const items = all.slice(0, count);
  const warm = Math.min(num(opts, 'warm', count), count);
  const rounds = num(opts, 'rounds', 3);
  const gapSec = num(opts, 'gap-sec', 30);
  const idleSec = num(opts, 'idle-sec', 120);
  const maxInFlight = num(opts, 'max-in-flight', 64);
  const timeoutMs = num(opts, 'timeout-ms', 30000);
  const cpuSel = Object.fromEntries(pairs(opts.cpu, 'cpu'));
  const prodFile = opts.prod || `${opts.inputs}.prod.json`;
  const prod = fs.existsSync(prodFile) ? JSON.parse(fs.readFileSync(prodFile, 'utf8')) : undefined;
  const outDir = opts.out;
  if (outDir) fs.mkdirSync(outDir, { recursive: true });
  const send = { rps, maxInFlight, timeoutMs, session };

  // Warm-up: the warm items through every arm, in the order given (list the Node arms first: they
  // write the shared per-entity caches, and the bench account's session data, that feed-go only
  // reads), at the same rate. Not measured.
  for (const [name, base] of targets) {
    log(`warm ${name}: ${warm} requests at ${rps}/s`);
    const res = await replay(base, items.slice(0, warm), send);
    log(`warm ${name}:`, JSON.stringify(statusCounts(res)));
  }

  // Idle baseline per arm, every arm idle at once.
  const idle = {};
  if (opts.prom && Object.keys(cpuSel).length) {
    log(`idle baseline: ${idleSec}s`);
    const s = Date.now() / 1000;
    await sleep(idleSec * 1000);
    const e = Date.now() / 1000;
    for (const [name, sel] of Object.entries(cpuSel))
      idle[name] = { cpuSeconds: await cpuSeconds(opts.prom, sel, s, e), seconds: e - s };
  }

  const names = targets.map(([n]) => n);
  const baseOf = Object.fromEntries(targets);
  const runs = [];
  const problems = [];
  for (const [r, order] of lib.armOrders(names, rounds).entries()) {
    const byArm = {};
    for (const name of order) {
      await sleep(gapSec * 1000);
      log(`round ${r + 1}/${rounds} ${name}: ${items.length} requests at ${rps}/s`);
      const s = Date.now() / 1000;
      const res = await replay(baseOf[name], items, send);
      const e = Date.now() / 1000;
      byArm[name] = res;
      let cpu;
      if (opts.prom && cpuSel[name] && idle[name]) {
        // Prometheus scrapes every ~30s: read after one more interval so the run's tail is in.
        await sleep(45000);
        const busy = await cpuSeconds(opts.prom, cpuSel[name], s, e);
        cpu = {
          busyCpuSeconds: busy,
          seconds: e - s,
          ...lib.cpuReport({
            busyCpuSeconds: busy,
            busySeconds: e - s,
            idleCpuSeconds: idle[name].cpuSeconds,
            idleSeconds: idle[name].seconds,
            sent: res.filter((x) => typeof x.status === 'number').length,
            ok: res.filter((x) => x.status === 200).length,
          }),
        };
        if (!Number.isFinite(cpu.msPerSent)) problems.push(`round ${r + 1} ${name}: CPU is NaN`);
      }
      if (outDir)
        fs.writeFileSync(
          path.join(outDir, `round${r + 1}-${name}.jsonl`),
          res.map((x, i) => JSON.stringify({ i, ...x })).join('\n') + '\n'
        );
      runs.push({ round: r + 1, arm: name, start: s, end: e, statuses: statusCounts(res), cpu });
      log(`round ${r + 1} ${name}:`, JSON.stringify(statusCounts(res)));
    }
    // Latency over the requests EVERY arm answered 200 in this round.
    const common = lib.commonOkIndexes(byArm);
    if (!common.length) problems.push(`round ${r + 1}: no request answered 200 by every arm`);
    for (const name of order) {
      const entry = runs.find((x) => x.round === r + 1 && x.arm === name);
      entry.latency = lib.summarize(common.map((i) => byArm[name][i].latencyMs));
      entry.allOkLatency = lib.summarize(
        byArm[name].filter((x) => x.status === 200).map((x) => x.latencyMs)
      );
      entry.maxLagMs = Math.max(...byArm[name].map((x) => x.lagMs));
      entry.commonOk = common.length;
      if (!lib.isFiniteSummary(entry.latency))
        problems.push(`round ${r + 1} ${name}: latency summary has a NaN`);
    }
  }

  // The sanity gate: per arm, the median of its rounds' common-200 p50s.
  const pooled = (arm) =>
    lib.summarize(
      runs.filter((x) => x.arm === arm).flatMap((x) => (x.latency.n ? [x.latency.p50] : []))
    );
  const prodNode = prod && (session ? prod.nodeAuthed : prod.node);
  const sanity =
    baseOf.next && baseOf.go && prod
      ? lib.gapCheck({
          benchNextMs: pooled('next').p50,
          benchGoMs: pooled('go').p50,
          prodNodeMs: prodNode && prodNode.p50,
          prodGoMs: prod.go && prod.go.p50,
        })
      : {
          flagged: true,
          reason: 'no production figures (the capture .prod.json) or no next/go arm',
        };

  const summary = {
    command: 'run',
    signedIn: !!session,
    rps,
    requests: items.length,
    rounds,
    inSitu: lib.summarize(items.map((r) => r.durMs).filter((v) => Number.isFinite(v))),
    prod,
    sanity,
    idle,
    runs,
    problems,
  };
  if (outDir) fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
  if (problems.length) throw new Error(`run is not a result: ${problems.join('; ')}`);
}

// --- parity ----------------------------------------------------------------------------------------

async function parity(opts) {
  const targets = pairs(opts.target, 'target');
  if (!opts.inputs || targets.length < 2) throw new Error('parity needs --inputs and 2+ --target');
  const session = loadSession(opts);
  const all = rowsFor(opts, session);
  const sample = num(opts, 'sample', 200);
  lib.requireRows(all.length, sample, 'parity');
  const step = all.length / sample;
  const [refName, refBase] = targets[0];
  const pairsOut = {};
  for (const [name] of targets.slice(1))
    pairsOut[name] = { compared: 0, bytesEqual: 0, jsonEqual: 0, skipped: 0, examples: [] };
  for (let k = 0; k < sample; k++) {
    const row = all[Math.floor(k * step)];
    const ref = await get(refBase, row, { keepBody: true, session });
    for (const [name, base] of targets.slice(1)) {
      const other = await get(base, row, { keepBody: true, session });
      const p = pairsOut[name];
      if (ref.status !== 200 || other.status !== 200) {
        p.skipped++;
        continue;
      }
      const cmp = lib.compareBodies(ref.body, other.body, { maxDiffs: 5 });
      p.compared++;
      if (cmp.bytesEqual) p.bytesEqual++;
      if (cmp.jsonEqual) p.jsonEqual++;
      // Paths only: a value can be a username or a URL from the page.
      else if (p.examples.length < 10) p.examples.push(cmp.diffs.map((d) => d.path));
    }
  }
  console.log(
    JSON.stringify({
      command: 'parity',
      signedIn: !!session,
      reference: refName,
      sample,
      pairs: pairsOut,
    })
  );
  const empty = Object.entries(pairsOut).filter(([, p]) => p.compared === 0);
  if (empty.length)
    throw new Error(`parity compared nothing against ${empty.map(([n]) => n).join(', ')}`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts._ === 'capture') return capture(opts);
  if (opts._ === 'run') return run(opts);
  if (opts._ === 'parity') return parity(opts);
  throw new Error('usage: bench.cjs capture|run|parity --flag value ... (see README.md)');
}

main().then(
  () => process.exit(0),
  (err) => {
    // The message only: no error here carries the session (lib.parseSessionFile never quotes it).
    console.error(String((err && err.message) || err));
    process.exit(1);
  }
);
