#!/usr/bin/env node
/**
 * Builds `.test-perf/dashboard.html` from whatever measurement data is on disk.
 *
 *   node scripts/test-perf/graph.mjs        # refresh the static inventory
 *   node scripts/test-perf/dashboard.mjs    # rebuild the page
 *
 * Every number on the page is derived from a generated file, so it stays true as the migration
 * moves without anyone maintaining a checklist by hand:
 *   .test-perf/inventory.json          - static import graph + vi.mock inventory
 *   .test-perf/runs/<label>.perf.json  - per-file timings from a run (scripts/test-perf/reporter.mjs)
 *
 * A file's isolation status is READ FROM A RUN, not asserted: the authority is whether it passed
 * in the most recent `--no-isolate` run. Files nobody has run that way yet say so.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const perfDir = path.join(repoRoot, '.test-perf');
const runsDir = path.join(perfDir, 'runs');

const inventory = existsSync(path.join(perfDir, 'inventory.json'))
  ? JSON.parse(readFileSync(path.join(perfDir, 'inventory.json'), 'utf8'))
  : { files: [], totals: {}, mockedModules: [], heaviestModules: [], heaviestExternals: [] };

const runs = (existsSync(runsDir) ? readdirSync(runsDir) : [])
  .filter((f) => f.endsWith('.perf.json'))
  .map((f) => {
    try {
      return JSON.parse(readFileSync(path.join(runsDir, f), 'utf8'));
    } catch {
      return null;
    }
  })
  .filter(Boolean)
  .sort((a, b) => new Date(a.generatedAt) - new Date(b.generatedAt));

const isFull = (r) => r.totals.files > 900;
const isNoIsolate = (r) => r.config?.isolate === false || /no-?iso/i.test(r.label);

const fullRuns = runs.filter(isFull);
const baseline = fullRuns.find((r) => /baseline/i.test(r.label)) ?? fullRuns[0] ?? null;
const latestFull = fullRuns.filter((r) => !isNoIsolate(r)).at(-1) ?? null;
const latestNoIso = runs.filter(isNoIsolate).at(-1) ?? null;

// ---- migration status ------------------------------------------------------
// The shared modules whose per-file mock behaviour is what `isolate: false` collides on.
const SHARED = [
  '~/server/db/client',
  '~/server/logging/client',
  '~/server/redis/client',
  '~/env/server',
  '~/server/clickhouse/client',
  '~/utils/trpc',
];

const noIsoVerdict = new Map();
if (latestNoIso) for (const f of latestNoIso.files) noIsoVerdict.set(f.file, f.failed > 0 ? 'fail' : 'pass');

const timing = new Map();
if (latestFull) for (const f of latestFull.files) timing.set(f.file, f);

const files = inventory.files.map((f) => {
  const sharedMocks = f.mocks.filter((m) => SHARED.includes(m.specifier));
  const inlineShared = sharedMocks.filter((m) => m.hasFactory && !m.importOriginal);
  let status;
  if (sharedMocks.length === 0) status = 'no-shared-mocks';
  else if (inlineShared.length === 0) status = 'spread-only';
  else status = 'needs-migration';
  const t = timing.get(f.file);
  return {
    ...f,
    sharedMockCount: sharedMocks.length,
    inlineSharedCount: inlineShared.length,
    sharedSpecifiers: [...new Set(sharedMocks.map((m) => m.specifier))],
    status,
    verdict: noIsoVerdict.get(f.file) ?? null,
    collect: t?.collect ?? null,
    setup: t?.setup ?? null,
    testMs: t?.duration ?? null,
  };
});

const counts = files.reduce((a, f) => ((a[f.status] = (a[f.status] || 0) + 1), a), {});
const verdictCounts = files.reduce((a, f) => ((a[f.verdict ?? 'unknown'] = (a[f.verdict ?? 'unknown'] || 0) + 1), a), {});

const sweep = existsSync(path.join(perfDir, 'sweep.json'))
  ? JSON.parse(readFileSync(path.join(perfDir, 'sweep.json'), 'utf8'))
  : [];

const payload = {
  generatedAt: new Date().toISOString(),
  sweep,
  inventoryTotals: inventory.totals,
  baseline: baseline && summarise(baseline),
  latestFull: latestFull && summarise(latestFull),
  latestNoIso: latestNoIso && summarise(latestNoIso),
  runs: runs.map(summarise),
  counts,
  verdictCounts,
  files,
  mockedModules: inventory.mockedModules.slice(0, 30),
  heaviestModules: inventory.heaviestModules.slice(0, 40),
  heaviestExternals: inventory.heaviestExternals.slice(0, 30),
  shared: SHARED,
};

function summarise(r) {
  return {
    label: r.label,
    at: r.generatedAt,
    head: r.head,
    full: isFull(r),
    noIsolate: isNoIsolate(r),
    wallS: +(r.wallMs / 1000).toFixed(1),
    collectS: +(r.totals.collectMs / 1000).toFixed(1),
    setupS: +(r.totals.setupMs / 1000).toFixed(1),
    testS: +(r.totals.testMs / 1000).toFixed(1),
    transformS: null,
    files: r.totals.files,
    tests: r.totals.tests,
    failed: r.totals.failed,
    workers: r.config?.maxWorkers ?? null,
  };
}

writeFileSync(path.join(perfDir, 'dashboard.json'), JSON.stringify(payload, null, 2));
writeFileSync(path.join(perfDir, 'dashboard.html'), html(payload));
console.log(
  `dashboard: ${files.length} files | needs-migration ${counts['needs-migration'] ?? 0} | ` +
    `runs ${runs.length} | -> .test-perf/dashboard.html`
);

function html(d) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Unit suite performance</title>
<style>
:root{color-scheme:dark;--bg:#0b0d10;--panel:#14181d;--line:#232a32;--fg:#e6edf3;--dim:#8b98a5;--ok:#3fb950;--warn:#d29922;--bad:#f85149;--accent:#58a6ff}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif}
header{padding:24px 28px;border-bottom:1px solid var(--line)}
h1{margin:0 0 4px;font-size:20px;letter-spacing:-.01em}
.sub{color:var(--dim);font-size:13px}
main{padding:24px 28px;max-width:1500px}
section{margin-bottom:32px}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim);margin:0 0 12px;font-weight:600}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}
.kpi{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.kpi .v{font-size:26px;font-weight:600;letter-spacing:-.02em}
.kpi .l{color:var(--dim);font-size:12px;margin-top:2px}
.kpi .d{font-size:12px;margin-top:6px}
.up{color:var(--bad)}.down{color:var(--ok)}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
th{color:var(--dim);font-weight:600;font-size:12px;cursor:pointer;user-select:none;position:sticky;top:0;background:var(--bg)}
tbody tr:hover{background:#1a1f26}
.wrap{overflow-x:auto;background:var(--panel);border:1px solid var(--line);border-radius:10px}
.scroll{max-height:620px;overflow-y:auto}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.tag{display:inline-block;padding:1px 7px;border-radius:20px;font-size:11px;border:1px solid var(--line)}
.t-needs{color:var(--warn);border-color:#4a3a12}
.t-spread{color:var(--accent);border-color:#1f3a5c}
.t-none{color:var(--dim)}
.t-pass{color:var(--ok);border-color:#17391f}
.t-fail{color:var(--bad);border-color:#4c1d1a}
.bar{display:flex;height:14px;border-radius:7px;overflow:hidden;border:1px solid var(--line);margin-bottom:8px}
.bar div{height:100%}
.legend{display:flex;gap:16px;flex-wrap:wrap;color:var(--dim);font-size:12px}
.legend b{color:var(--fg);font-weight:600}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px}
input[type=search]{background:var(--panel);border:1px solid var(--line);color:var(--fg);border-radius:8px;padding:7px 11px;width:280px;margin-bottom:10px}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:20px}
@media(max-width:1000px){.cols{grid-template-columns:1fr}}
.note{color:var(--dim);font-size:12px;margin-top:8px}
</style></head><body>
<header>
  <h1>Unit suite performance &amp; isolation migration</h1>
  <div class="sub">Generated <span id="gen"></span> — every figure derives from <span class="mono">.test-perf/</span>. Rebuild with <span class="mono">node scripts/test-perf/graph.mjs &amp;&amp; node scripts/test-perf/dashboard.mjs</span></div>
</header>
<main>
<section><h2>Where the time goes</h2><div class="kpis" id="kpis"></div><div class="note" id="phasenote"></div></section>
<section><h2>Migration to the shared-mock system</h2><div id="bar"></div><div class="legend" id="legend"></div><div class="note" id="verdictnote"></div></section>
<section><h2>Config sweep — same 90-file subset, back to back</h2><div class="wrap"><table id="sweep"></table></div><div class="note">A crash exit (<span class="mono">3221225477</span> = 0xC0000005, Windows access violation) writes no report, so its phase columns are blank. Wall clock is still the run's real duration.</div></section>
<section class="cols">
  <div><h2>Most-mocked shared modules</h2><div class="wrap scroll"><table id="mocks"></table></div></div>
  <div><h2>Run history</h2><div class="wrap scroll"><table id="runs"></table></div></div>
</section>
<section><h2>Test files</h2><input type="search" id="q" placeholder="filter by path, status or specifier…"><div class="wrap scroll"><table id="files"></table></div></section>
<section class="cols">
  <div><h2>First-party modules in the most test closures</h2><div class="wrap scroll"><table id="heavy"></table></div></div>
  <div><h2>External packages in the most test closures</h2><div class="wrap scroll"><table id="ext"></table></div></div>
</section>
</main>
<script>
const D = ${JSON.stringify(payload)};
const $ = (s) => document.querySelector(s);
document.getElementById('gen').textContent = new Date(D.generatedAt).toLocaleString();

const s = (n, u='s') => n == null ? '—' : n.toLocaleString(undefined,{maximumFractionDigits:1}) + u;
function delta(now, base){
  if(now==null||base==null) return '';
  const p = ((now-base)/base*100);
  const cls = p>0?'up':'down';
  return '<span class="'+cls+'">'+(p>0?'+':'')+p.toFixed(0)+'% vs baseline</span>';
}
const L = D.latestFull, B = D.baseline;
const kpi = (v,l,d='') => '<div class="kpi"><div class="v">'+v+'</div><div class="l">'+l+'</div><div class="d">'+d+'</div></div>';
$('#kpis').innerHTML = [
  kpi(L?s(L.wallS):'—','wall clock, full run', L&&B?delta(L.wallS,B.wallS):''),
  kpi(L?s(L.collectS):'—','import + collect (worker-s)', L&&B?delta(L.collectS,B.collectS):''),
  kpi(L?s(L.setupS):'—','setup (worker-s)', L&&B?delta(L.setupS,B.setupS):''),
  kpi(L?s(L.testS):'—','test bodies (worker-s)', L&&B?delta(L.testS,B.testS):''),
  kpi(L?L.tests.toLocaleString():'—','tests', L?L.files+' files':''),
  kpi(L?L.failed:'—','failed', '16 is the known Windows baseline'),
].join('');
if(L) $('#phasenote').textContent = 'Latest full run: '+L.label+' ('+(L.workers??'default')+' workers, '+new Date(L.at).toLocaleString()+'). Import is '
  + (L.collectS/(L.collectS+L.setupS+L.testS)*100).toFixed(0) + '% of measured worker time.';

const C = D.counts, tot = D.files.length;
const seg = [['no-shared-mocks','#30363d',C['no-shared-mocks']||0],['spread-only','#1f6feb',C['spread-only']||0],['needs-migration','#d29922',C['needs-migration']||0]];
$('#bar').innerHTML = '<div class="bar">'+seg.map(([k,c,n])=>'<div style="width:'+(n/tot*100)+'%;background:'+c+'" title="'+k+': '+n+'"></div>').join('')+'</div>';
$('#legend').innerHTML = seg.map(([k,c,n])=>'<span><span class="dot" style="background:'+c+'"></span><b>'+n+'</b> '+k+'</span>').join('')
  + '<span><b>'+tot+'</b> files total</span>';
const V = D.verdictCounts;
$('#verdictnote').textContent = D.latestNoIso
  ? 'Latest --no-isolate run ('+D.latestNoIso.label+'): '+(V.pass||0)+' files passed, '+(V.fail||0)+' failed, '+(V.unknown||0)+' not covered by that run.'
  : 'No --no-isolate run recorded yet, so per-file isolation verdicts are unknown. Run one and rebuild.';

function table(el, cols, rows, rowFn){
  el.innerHTML = '<thead><tr>'+cols.map(c=>'<th>'+c+'</th>').join('')+'</tr></thead><tbody>'
    + rows.map(rowFn).join('') + '</tbody>';
}
table($('#sweep'), ['config','workers','wall','import','setup','tests','failed','exit'], D.sweep,
  r => '<tr><td class="mono">'+r.pool+' '+(r.isolate?'isolate':'no-isolate')+'</td><td>'+r.workers+'</td><td><b>'+s(r.wallS)+'</b></td><td>'+s(r.collectS)+'</td><td>'+s(r.setupS)+'</td><td>'+s(r.testS)+'</td><td>'+(r.failed==null?'—':r.failed)+'</td><td class="'+(r.exit===0?'':'up')+'">'+r.exit+'</td></tr>');
table($('#mocks'), ['module','sites','files','inline factories'], D.mockedModules,
  m => '<tr><td class="mono">'+m.specifier+'</td><td>'+m.sites+'</td><td>'+m.files+'</td><td>'+m.partial+'</td></tr>');
table($('#runs'), ['label','when','wall','import','setup','tests','failed','files'], [...D.runs].reverse(),
  r => '<tr><td class="mono">'+r.label+(r.noIsolate?' <span class="tag t-spread">no-isolate</span>':'')+'</td><td>'+new Date(r.at).toLocaleString()+'</td><td>'+s(r.wallS)+'</td><td>'+s(r.collectS)+'</td><td>'+s(r.setupS)+'</td><td>'+s(r.testS)+'</td><td>'+r.failed+'</td><td>'+r.files+'</td></tr>');
table($('#heavy'), ['module','in test closures','own bytes'], D.heaviestModules,
  m => '<tr><td class="mono">'+m.module+'</td><td>'+m.inClosures+'</td><td>'+(m.ownBytes/1024).toFixed(1)+'k</td></tr>');
table($('#ext'), ['package','in test closures'], D.heaviestExternals,
  m => '<tr><td class="mono">'+m.pkg+'</td><td>'+m.inClosures+'</td></tr>');

const statusTag = f => '<span class="tag t-'+(f.status==='needs-migration'?'needs':f.status==='spread-only'?'spread':'none')+'">'+f.status+'</span>';
const verdictTag = f => f.verdict ? '<span class="tag t-'+f.verdict+'">'+f.verdict+'</span>' : '<span class="tag t-none">—</span>';
let sortKey='graphModules', sortDir=-1;
function renderFiles(){
  const q = $('#q').value.toLowerCase();
  const rows = D.files.filter(f => !q || f.file.toLowerCase().includes(q) || f.status.includes(q)
      || f.sharedSpecifiers.some(x=>x.toLowerCase().includes(q)))
    .sort((a,b)=>((b[sortKey]??-1)-(a[sortKey]??-1))*(sortDir<0?1:-1));
  table($('#files'), ['file','closure','collect ms','setup ms','tests','mocks','shared mocks','status','no-isolate'], rows.slice(0,600),
    f => '<tr><td class="mono">'+f.file+'</td><td>'+f.graphModules+'</td><td>'+(f.collect??'—')+'</td><td>'+(f.setup??'—')+'</td><td>'+f.tests+'</td><td>'+f.mockCount+'</td><td>'+f.sharedMockCount+'</td><td>'+statusTag(f)+'</td><td>'+verdictTag(f)+'</td></tr>');
  const ths = $('#files').querySelectorAll('th');
  const keys = ['file','graphModules','collect','setup','tests','mockCount','sharedMockCount','status','verdict'];
  ths.forEach((th,i)=>th.onclick=()=>{ if(sortKey===keys[i]) sortDir*=-1; else {sortKey=keys[i];sortDir=-1;} renderFiles(); });
}
$('#q').oninput = renderFiles;
renderFiles();
</script></body></html>`;
}
