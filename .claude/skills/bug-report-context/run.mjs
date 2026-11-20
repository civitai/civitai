#!/usr/bin/env node
/**
 * Pull a bug reporter's last 24h and line it up against their errors. Read-only: every read goes
 * through checks.mjs's guards and then the existing postgres-query / clickhouse-query / axiom
 * scripts, each of which keeps its own read-only protections. See SKILL.md.
 */
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import {
  OUTAGE_COLUMNS,
  faroLines,
  reasonOf,
  targetLabel,
  idsFromStageOne,
  outageRead,
  parseArgs,
  pickChecks,
  reading,
  rowsOf,
  stageOne,
  stageTwo,
  toCommand,
} from './checks.mjs';

const run = promisify(execFile);
// ClickHouse hands back zone-less timestamps, read as local time: make local UTC, here and in the
// child scripts, so the window and the timeline mean the same instant everywhere.
process.env.TZ = 'UTC';

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (e) {
  console.error(`bug-report-context: ${e.message}`);
  console.error(
    'usage: run.mjs --user <id> --at <ISO sent-at> [--ref <errorRef>] [--route <route>] ' +
      '[--paths a.b,c.d] [--post <id>]... [--feedback <id>] [--hours 24] [--checks all|errors,images,...] [--plan] [--json <file>]'
  );
  process.exit(1);
}
const checks = pickChecks(opts);

const shellQuote = (a) => (/^[\w./:=,-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);
const failures = [];
const warnings = [];
const targets = new Set();

async function exec(read) {
  let argv;
  try {
    argv = toCommand(read); // throws on anything that is not a query this skill builds
  } catch (e) {
    failures.push({ check: read.check, why: e.message });
    return [];
  }
  if (opts.plan) {
    console.log(`# ${read.check}\nnode ${argv.map(shellQuote).join(' ')}\n`);
    return [];
  }
  try {
    const { stdout, stderr } = await run('node', argv, {
      maxBuffer: 32 * 1024 * 1024,
      timeout: 45_000,
    });
    // postgres-query names the database that answered; on some machines --prod is not prod.
    const target = targetLabel(stderr);
    if (target) targets.add(target);
    const rows = rowsOf(
      read.tool,
      JSON.parse(stdout.slice(stdout.indexOf('{'))),
      read.check === 'outage' ? OUTAGE_COLUMNS : []
    );
    if (read.limit && rows.length >= read.limit)
      warnings.push(`${read.check}: hit its LIMIT ${read.limit}, so rows past it were not read`);
    return rows;
  } catch (e) {
    const why = (e.stderr || e.message || '').toString().trim().split('\n').slice(-3).join(' | ');
    failures.push({ check: read.check, why });
    return [];
  }
}

async function runAll(reads, into) {
  const rows = await Promise.all(reads.map(exec));
  reads.forEach((r, i) => (into[r.check] = [...(into[r.check] ?? []), ...rows[i]]));
}

const results = {};
await runAll(stageOne(opts, checks), results);
let second = [];
try {
  second = stageTwo(opts, checks, idsFromStageOne(opts, results));
} catch (e) {
  for (const c of ['post', 'ratings'])
    if (checks.includes(c)) failures.push({ check: c, why: e.message });
}
for (const c of ['post', 'ratings']) {
  if (
    !checks.includes(c) ||
    second.some((r) => r.check === c) ||
    failures.some((f) => f.check === c)
  )
    continue;
  const source = ['errors', 'images'].find((f) => failures.some((x) => x.check === f));
  if (source) {
    failures.push({ check: c, why: `its ids come from ${source}, which failed` });
    continue;
  }
  const why = opts.plan
    ? `${c}: runs on the ids stage one finds (post/image ids in error inputs, window images, --post)`
    : `${c}: skipped, no ids (post/image ids come from error inputs, window images and --post)`;
  if (opts.plan) console.log(`# ${why}\n`);
  else warnings.push(why);
}
await runAll(second, results);
if (checks.includes('outage')) {
  await runAll([outageRead(opts, results)], results);
  // Twenty minutes of site-wide errors is never empty on prod: empty means the read did not work.
  if (!opts.plan && !results.outage?.length && !failures.some((f) => f.check === 'outage'))
    failures.push({
      check: 'outage',
      why: 'no error groups at all in 20 minutes; the summarize output was not understood',
    });
}
if (opts.plan) process.exit(0);

if (opts.json)
  writeFileSync(
    opts.json,
    JSON.stringify({ opts, checks, targets: [...targets], results, failures, warnings }, null, 2)
  );
console.log(render());
process.exit(failures.length ? 2 : 0);

function render() {
  const out = [];
  const t = (v) => {
    const d = new Date(v);
    return v && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 19) + 'Z' : String(v ?? '?');
  };
  const failed = new Set(failures.map((f) => f.check));
  out.push(`# Reporter context: ${opts.start} .. ${opts.end}`);
  out.push(
    `checks: ${checks.join(', ')}${failed.size ? `  (FAILED: ${[...failed].join(', ')})` : ''}`
  );
  for (const target of targets) out.push(target);

  const inWin = (x) => {
    const v = t(x);
    return v >= opts.start.slice(0, 19) && v <= opts.end.slice(0, 19) + 'Z';
  };
  const events = [];
  for (const e of results.errors ?? [])
    events.push([
      e._time,
      `error  ${e.path ?? '?'} ${e.code ?? ''} ${reasonOf(e)} ref=${e.errorRef ?? '-'}`,
    ]);
  for (const i of results.images ?? []) {
    if (inWin(i.createdAt))
      events.push([
        i.createdAt,
        `image  #${i.id} ${i.type} post=${i.postId ?? '-'} created, ingestion=${i.ingestion}`,
      ]);
    else if (inWin(i.updatedAt))
      events.push([
        i.updatedAt,
        `image  #${i.id} ${i.type} post=${i.postId ?? '-'} updated, ingestion=${i.ingestion}`,
      ]);
  }
  for (const h of results.textscan ?? [])
    events.push([
      h.createdAt,
      `scan   ${h.entityType} #${h.entityId} held (${h.label}), ${h.status}`,
    ]);
  for (const g of results.generation ?? [])
    events.push([
      g.createdAt,
      `gen    ${g.workflowId} ${g.type} ${g.status} ${g.failureClass ?? ''}`,
    ]);
  for (const r of results.ratings ?? [])
    events.push([
      r.createdAt,
      `rating image #${r.imageId} asked level ${r.nsfwLevel}, ${r.status}`,
    ]);
  events.sort((a, b) => t(b[0]).localeCompare(t(a[0])));
  out.push(`\n## Timeline (newest first, ${events.length} rows)`);
  for (const [time, line] of events.slice(0, 80)) out.push(`${t(time)}  ${line}`);

  if (results.post?.length) {
    out.push('\n## Posts in play');
    for (const p of results.post) out.push(JSON.stringify(p));
    for (const i of results.postImages ?? [])
      out.push(
        `  post ${i.postId} #${i.index ?? '?'} image ${i.id} ${i.type} ingestion=${
          i.ingestion
        } level=${i.nsfwLevel}${i.nsfwLevelLocked ? ' locked' : ''}`
      );
  }
  if (checks.includes('ref')) {
    if (failed.has('ref')) out.push(`\n## Error ref ${opts.ref}: NOT READ`);
    else if (results.ref?.length) {
      out.push(`\n## Error ref ${opts.ref}`);
      for (const r of results.ref) out.push(`${t(r._time)} ${r.path} ${r.code} ${reasonOf(r)}`);
    } else out.push(`\n## Error ref ${opts.ref}: not found in the window`);
  }

  const outage = results.outage ?? [];
  if (outage.length) {
    out.push("\n## Site-wide errors around the reporter's last error (±10 min), top 15");
    for (const o of outage.slice(0, 15))
      out.push(`${o.n} rows, ${o.users} users, ${t(o.first)}..${t(o.last)}  ${o.sig}`);
  }

  if (checks.includes('feedback')) {
    out.push('\n## Browser telemetry (Faro)');
    if (failed.has('feedback')) out.push('Faro: NOT READ');
    else out.push(...faroLines(results.feedback?.[0], opts, Date.now()));
  }

  out.push('\n## Reading');
  out.push(...reading(results, failed, checks));
  for (const w of warnings) out.push(`WARNING ${w}`);
  for (const f of failures) out.push(`FAILED ${f.check}: ${f.why}`);
  return out.join('\n');
}
