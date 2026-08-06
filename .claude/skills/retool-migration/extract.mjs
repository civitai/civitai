#!/usr/bin/env node
// Decode a Retool app export into a readable inventory of its queries and components.
//
//   node extract.mjs <export.json>            # markdown inventory (default)
//   node extract.mjs <export.json> --json     # machine-readable
//   node extract.mjs <export.json> --queries  # SQL/REST only, no component noise
//
// The export is NOT plain JSON all the way down: `page.data.appState` is a transit-js
// encoded string (`~#iR` tag, `["^ ", k, v, …]` maps, `^N` back-references). Reading it
// with JSON.parse alone yields an opaque blob, which is why this decoder exists.
import fs from 'node:fs';
import transit from 'transit-js';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('usage: node extract.mjs <retool-export.json> [--json|--queries]');
  process.exit(1);
}
const asJson = args.includes('--json');
const queriesOnly = args.includes('--queries');

function conv(v) {
  if (v === null || v === undefined) return v;
  if (transit.isMap(v)) {
    const o = {};
    v.forEach((val, key) => {
      o[transit.isKeyword(key) || transit.isSymbol(key) ? key.name() : String(key)] = conv(val);
    });
    return o;
  }
  if (Array.isArray(v)) return v.map(conv);
  if (transit.isKeyword(v) || transit.isSymbol(v)) return v.name();
  if (typeof v === 'object' && 'tag' in v && 'rep' in v) return conv(v.rep);
  return v;
}

// Retool flattens every component/query prop bag into a [k, v, k, v, …] array.
function pairsToObject(arr) {
  if (!Array.isArray(arr)) return arr ?? {};
  const o = {};
  for (let i = 0; i < arr.length - 1; i += 2) if (typeof arr[i] === 'string') o[arr[i]] = arr[i + 1];
  return o;
}

// `{{ … }}` is Retool's binding syntax. These are the data-flow edges: which query or
// component another query depends on. They must be replaced by real inputs when porting.
function bindings(text) {
  if (typeof text !== 'string') return [];
  return [...new Set([...text.matchAll(/\{\{([^}]+)\}\}/g)].map((m) => m[1].trim()))];
}

const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
if (!raw?.page?.data?.appState) {
  console.error('not a Retool app export (no page.data.appState)');
  process.exit(1);
}
const state = conv(transit.reader('json').read(raw.page.data.appState));
const app = state.v ?? state;

const flat = Array.isArray(app.plugins) ? app.plugins : Object.values(app.plugins ?? {});
const plugins = flat.filter((e) => e && typeof e === 'object' && e.v).map((e) => e.v);

const queries = [];
const widgets = [];
for (const p of plugins) {
  const tpl = pairsToObject(p.template);
  const base = { id: p.id, subtype: p.subtype, resource: p.resourceDisplayName ?? p.resourceName };
  if (p.type === 'datasource') {
    const sql = tpl.query ?? null;
    const body = typeof tpl.body === 'string' ? tpl.body : null;
    queries.push({
      ...base,
      sql,
      body,
      url: tpl.url ?? null,
      method: tpl.queryType ?? tpl.method ?? null,
      // GUI-mode queries (Retool's insert/update/bulk-upsert builder) carry no SQL at all — just a
      // target table. Without this they read as empty queries and the table they write is invisible.
      tableName: tpl.tableName ?? null,
      runOnLoad: tpl.runWhenPageLoads ?? null,
      bindings: [...new Set([...bindings(sql), ...bindings(body), ...bindings(tpl.url)])],
    });
  } else {
    widgets.push({
      ...base,
      type: p.type,
      label: tpl.label ?? tpl.text ?? tpl.title ?? null,
      dataBindings: [...new Set([...bindings(tpl.data), ...bindings(tpl.value)])],
    });
  }
}

if (asJson) {
  console.log(JSON.stringify({ queries, widgets }, null, 2));
  process.exit(0);
}

const name = file.split(/[\\/]/).pop();
console.log(`# ${decodeURIComponent(name)}`);
console.log(`\nqueries: ${queries.length}   components: ${widgets.length}`);
console.log(`resources: ${[...new Set(queries.map((q) => q.resource).filter(Boolean))].join(', ')}`);

if (!queriesOnly) {
  const bySub = {};
  for (const w of widgets) bySub[w.subtype] = (bySub[w.subtype] ?? 0) + 1;
  console.log(`\n## component types (layout is NOT ported — this is only a scale signal)`);
  Object.entries(bySub)
    .sort((a, b) => b[1] - a[1])
    .forEach(([k, c]) => console.log(`  ${k}: ${c}`));
}

console.log(`\n## queries`);
for (const q of queries) {
  const where = q.url ? `${q.method ?? 'REST'} ${q.url}` : '';
  console.log(`\n### ${q.id}   [${q.subtype} / ${q.resource ?? '?'}] ${where}`);
  if (q.runOnLoad) console.log(`    (runs on page load)`);
  if (q.tableName) console.log(`    GUI-mode write → table: ${q.tableName}`);
  if (q.bindings.length) console.log(`    depends on: ${q.bindings.join(', ')}`);
  const text = q.sql ?? q.body;
  if (text)
    console.log(
      String(text)
        .trim()
        .split('\n')
        .map((l) => '    ' + l)
        .join('\n')
    );
}
