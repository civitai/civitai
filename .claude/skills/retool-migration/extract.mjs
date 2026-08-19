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
    // A widget's OPTION SET is functionality, not layout. Retool encodes canned workflows as dropdown
    // presets — "Stripe Chargeback Retrieval" is one of five that fill a buzz-transfer form with a set
    // amount, type and description, and it appears in no query. Dropping these hid that button, the
    // timed-mute duration presets, and two whole tabs from a migration that otherwise looked complete.
    const options = [tpl._labels, tpl.labels, tpl.values, tpl._values]
      .filter(Array.isArray)
      .flat()
      .filter((v) => typeof v === 'string' && v.trim());

    // Nesting lives in position2, NOT in the empty top-level `container` field: `container` there is
    // the parent widget's id and `subcontainer` is which tab PANE of it this widget sits in. A tab bar
    // (TabsWidget2) then joins the two: `_values[i]` is the label of the pane `_ids[i]` inside
    // `targetContainerId`. Without this the inventory records that seven tab groups existed and
    // nothing about what was in them.
    const pos = conv(p.position2)?.v ?? {};

    widgets.push({
      ...base,
      type: p.type,
      label: tpl.label ?? tpl.text ?? tpl.title ?? null,
      options: [...new Set(options)],
      dataBindings: [...new Set([...bindings(tpl.data), ...bindings(tpl.value)])],
      parent: pos.container || null,
      pane: pos.subcontainer || null,
      rowGroup: pos.rowGroup || null,
      row: typeof pos.row === 'number' ? pos.row : 0,
      col: typeof pos.col === 'number' ? pos.col : 0,
      width: typeof pos.width === 'number' ? pos.width : 0,
      hidden: tpl.hidden === true || undefined,
      // Panes are defined on the CONTAINER (`_ids` ↔ `position2.subcontainer`), not on the tab bar
      // that drives it — a TabsWidget2's own `_values` are usually still "Tab 1/2/3". `_hiddenByIndex`
      // is the per-pane visibility condition, and it is where role gates hide: one pane here is
      // `{{!(current_user.groups.some(i => i.name === "Senior Mod"))}}`, which appears in no query.
      targetContainerId: tpl.targetContainerId ?? null,
      paneIds: Array.isArray(tpl._ids) ? tpl._ids : null,
      paneKeys: Array.isArray(tpl._viewKeys) ? tpl._viewKeys : null,
      paneLabels: Array.isArray(tpl._labels) ? tpl._labels : null,
      paneHidden: Array.isArray(tpl._hiddenByIndex) ? tpl._hiddenByIndex : null,
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
  console.log(`\n## component types (scale signal; the structure itself is below)`);
  Object.entries(bySub)
    .sort((a, b) => b[1] - a[1])
    .forEach(([k, c]) => console.log(`  ${k}: ${c}`));

  // TABS AND OPTION SETS ARE THE SPEC, not layout. Retool splits an app with tabs, so the tab bar is
  // its table of contents — "Submitted Reviews / Received Reviews" means two views exist, and porting
  // one is porting half. Dropdown presets are the same: canned workflows that appear in no query.
  const withOptions = widgets.filter((w) => w.options.length);
  if (withOptions.length) {
    console.log(`\n## tabs & option sets — READ THESE, they are functionality`);
    console.log(
      `  Tab labels are the app's table of contents; dropdown options are canned workflows that`
    );
    console.log(`  exist in no query. A tab you did not port is a capability you did not port.`);
    for (const w of withOptions) {
      console.log(`\n### ${w.id}   [${w.subtype}]`);
      for (const o of w.options) console.log(`    - ${o}`);
    }
  }

  // LAYOUT. Moderators navigate by shape, not by query: a section that was three tabs in Retool and is
  // one scrolling page here reads as "the new tool lost things", even when every query is ported.
  // Emitted so a port can keep the same shape — tab groups as sub-pages, modals as dialogs.
  const byParent = new Map();
  for (const w of widgets) {
    if (!w.parent) continue;
    if (!byParent.has(w.parent)) byParent.set(w.parent, []);
    byParent.get(w.parent).push(w);
  }
  const inReadingOrder = (a, b) => a.row - b.row || a.col - b.col;
  // Retool lays out on a 12-COLUMN GRID, and `col`/`width` are the whole answer to "was this page one
  // column or two". A form at col 0 width 6 beside panels at col 7 width 5 is a two-column screen; port
  // it as one and the moderator scrolls past what used to sit alongside.
  const describe = (w) =>
    `c${String(w.col).padStart(2)} w${String(w.width).padStart(2)}  ${w.id} [${w.subtype}]` +
    `${w.label ? ` "${String(w.label).replace(/\s+/g, ' ').slice(0, 50)}"` : ''}` +
    `${w.hidden ? ' (hidden by default)' : ''}`;

  const driverOf = new Map(
    widgets.filter((w) => w.targetContainerId).map((w) => [w.targetContainerId, w.id])
  );
  const modals = widgets.filter((w) => /Modal/i.test(w.subtype));
  // Containers only: a SelectWidget2's `_ids` are its dropdown OPTIONS, not panes, and they are
  // already reported under "tabs & option sets".
  const paneOwners = widgets.filter((w) => w.paneIds?.length && /Container|Frame/i.test(w.subtype));

  console.log(`\n## layout — panes, containers and modals`);
  console.log(`  Retool's shape. A container with several PANES is a tab group: port it as SUB-PAGES,`);
  console.log(`  one route per pane, not as one long page — a moderator who had tabs and now scrolls`);
  console.log(`  reports the tool as broken. A modal is a dialog, not an inlined panel.`);
  console.log(`  "only visible when" is a role/state gate that appears in NO query — port it too.`);

  const claimed = new Set();
  for (const c of paneOwners) {
    const kids = byParent.get(c.id) ?? [];
    const multi = c.paneIds.length > 1;
    if (!kids.length && !multi) continue;
    console.log(
      `\n### ${c.id}   [${c.subtype}] — ${c.paneIds.length} pane(s)` +
        `${driverOf.get(c.id) ? `, tab bar ${driverOf.get(c.id)}` : ''}` +
        `${c.parent ? `  (inside ${c.parent})` : ''}`
    );
    c.paneIds.forEach((paneId, i) => {
      const name = c.paneLabels?.[i] || c.paneKeys?.[i] || `(pane ${i + 1})`;
      const gate = c.paneHidden?.[i];
      const members = kids.filter((w) => w.pane === paneId).sort(inReadingOrder);
      members.forEach((m) => claimed.add(m.id));
      const when =
        typeof gate === 'string' && gate.trim() ? `   — only visible when NOT: ${gate.trim()}` : '';
      console.log(`  - "${name}"  [${paneId}]${members.length ? '' : '  — empty'}${when}`);
      for (const m of members) console.log(`      ${describe(m)}`);
    });
    const loose = kids.filter((w) => !claimed.has(w.id)).sort(inReadingOrder);
    for (const m of loose) {
      claimed.add(m.id);
      console.log(`      ${describe(m)}   (not in a pane)`);
    }
  }

  for (const m of modals) {
    const members = (byParent.get(m.id) ?? []).filter((x) => !claimed.has(x.id)).sort(inReadingOrder);
    if (!members.length) continue;
    members.forEach((x) => claimed.add(x.id));
    console.log(`\n### ${m.id}   [${m.subtype}] — MODAL${m.label ? ` "${m.label}"` : ''}`);
    for (const x of members) console.log(`    ${describe(x)}`);
  }

  const orphans = widgets.filter((w) => w.parent && !claimed.has(w.id));
  const byOrphanParent = new Map();
  for (const w of orphans) {
    if (!byOrphanParent.has(w.parent)) byOrphanParent.set(w.parent, []);
    byOrphanParent.get(w.parent).push(w);
  }
  for (const [parent, kids] of byOrphanParent) {
    console.log(`\n### ${parent}   (${kids.length})`);
    for (const x of kids.sort(inReadingOrder)) console.log(`    ${describe(x)}`);
  }
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
