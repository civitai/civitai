#!/usr/bin/env node
/**
 * Where a test file's module closure actually comes from.
 *
 * `graph.mjs` says how big each closure is; this says WHY. It builds the same first-party
 * graph, then computes the dominator tree rooted at the entry: a node's dominator-subtree
 * size is exactly how many modules disappear if that node stops being reachable. A node with
 * a single predecessor and a large subtree is one edge holding up a wing of the graph.
 *
 *   node scripts/test-perf/cuts.mjs cuts <entry> [--top N]
 *   node scripts/test-perf/cuts.mjs path <entry> <substring>
 *   node scripts/test-perf/cuts.mjs cuts-many <entry...> --top N
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';

const repoRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
  '../..'
);
const SRC_DIRS = ['src', 'scripts', 'packages'];
const EXT = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs'];
const norm = (p) => p.replace(/\\/g, '/');

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.next' || e.name === 'dist' || e.name === '.git')
      continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (EXT.includes(path.extname(e.name))) out.push(p);
  }
  return out;
}

const files = SRC_DIRS.flatMap((d) => walk(path.join(repoRoot, d)));
const fileSet = new Set(files.map(norm));

function tryFile(base) {
  const b = norm(base);
  for (const e of EXT) if (fileSet.has(b + e)) return b + e;
  if (fileSet.has(b)) {
    try {
      if (statSync(b).isFile()) return b;
    } catch {}
  }
  for (const e of EXT) if (fileSet.has(`${b}/index${e}`)) return `${b}/index${e}`;
  return null;
}

function resolveSpecifier(spec, fromFile) {
  if (spec.startsWith('~/')) return tryFile(path.join(repoRoot, 'src', spec.slice(2)));
  if (spec.startsWith('@civitai/')) {
    const rest = spec.slice('@civitai/'.length);
    const [pkg, ...sub] = rest.split('/');
    const base = path.join(repoRoot, 'packages', `civitai-${pkg}`, 'src');
    return tryFile(sub.length ? path.join(base, sub.join('/')) : path.join(base, 'index'));
  }
  if (spec.startsWith('.')) return tryFile(path.resolve(path.dirname(fromFile), spec));
  return null;
}

const IMPORT_RE =
  /(?:^|\n)\s*import\s+(?:type\s+)?(?:[\s\S]*?\sfrom\s+)?['"]([^'"]+)['"]|(?:^|[^.\w])(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)|(?:^|\n)\s*export\s+(?:type\s+)?[\s\S]*?\sfrom\s+['"]([^'"]+)['"]/g;

const cache = new Map();
function importsOf(file) {
  if (cache.has(file)) return cache.get(file);
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {}
  const lines = text
    .split('\n')
    .filter((l) => !/^\s*import\s+type\s/.test(l) && !/^\s*export\s+type\s/.test(l));
  const scan = lines.join('\n');
  const internal = new Set();
  let m;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(scan))) {
    const spec = m[1] || m[2] || m[3];
    if (!spec) continue;
    // `import()` is LAZY at runtime — under vitest the module is never fetched unless the
    // call actually runs — so it costs nothing in the registry a worker builds. `require()`
    // is eager and stays. STATIC=1 counts them anyway (bundler view).
    if (m[2] !== undefined && !process.env.COUNT_DYNAMIC) {
      const call = scan.slice(Math.max(0, m.index), m.index + 12);
      if (!/require/.test(call)) continue;
    }
    const r = resolveSpecifier(spec, file);
    if (r) internal.add(r);
  }
  const res = { internal: [...internal], bytes: Buffer.byteLength(text) };
  cache.set(file, res);
  return res;
}

/** Reachable set + adjacency, rooted at `entry`. */
function buildGraph(entry) {
  const nodes = [entry];
  const index = new Map([[entry, 0]]);
  const succ = [];
  for (let i = 0; i < nodes.length; i++) {
    const own = importsOf(nodes[i]);
    const s = [];
    for (const dep of own.internal) {
      let j = index.get(dep);
      if (j === undefined) {
        j = nodes.length;
        index.set(dep, j);
        nodes.push(dep);
      }
      s.push(j);
    }
    succ[i] = s;
  }
  const pred = nodes.map(() => []);
  succ.forEach((s, i) => s.forEach((j) => pred[j].push(i)));
  return { nodes, index, succ, pred };
}

/** Cooper-Harvey-Kennedy iterative dominators over the reverse-postorder of the graph. */
function dominators({ nodes, succ, pred }) {
  const n = nodes.length;
  const order = [];
  const seen = new Uint8Array(n);
  // iterative DFS postorder
  const stack = [[0, 0]];
  seen[0] = 1;
  while (stack.length) {
    const frame = stack[stack.length - 1];
    const [v, k] = frame;
    if (k < succ[v].length) {
      frame[1]++;
      const w = succ[v][k];
      if (!seen[w]) {
        seen[w] = 1;
        stack.push([w, 0]);
      }
    } else {
      order.push(v);
      stack.pop();
    }
  }
  const postIdx = new Int32Array(n).fill(-1);
  order.forEach((v, i) => (postIdx[v] = i));
  const rpo = order.slice().reverse();
  const idom = new Int32Array(n).fill(-1);
  idom[0] = 0;
  const intersect = (a, b) => {
    while (a !== b) {
      while (postIdx[a] < postIdx[b]) a = idom[a];
      while (postIdx[b] < postIdx[a]) b = idom[b];
    }
    return a;
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const v of rpo) {
      if (v === 0) continue;
      let newIdom = -1;
      for (const p of pred[v]) {
        if (idom[p] === -1 || postIdx[p] === -1) continue;
        newIdom = newIdom === -1 ? p : intersect(p, newIdom);
      }
      if (newIdom !== -1 && idom[v] !== newIdom) {
        idom[v] = newIdom;
        changed = true;
      }
    }
  }
  // dominator-subtree size
  const children = nodes.map(() => []);
  for (let v = 1; v < n; v++) if (idom[v] >= 0) children[idom[v]].push(v);
  const size = new Int32Array(n).fill(1);
  const post = [];
  const st = [[0, 0]];
  while (st.length) {
    const f = st[st.length - 1];
    if (f[1] < children[f[0]].length) st.push([children[f[0]][f[1]++], 0]);
    else {
      post.push(f[0]);
      st.pop();
    }
  }
  for (const v of post) for (const c of children[v]) size[v] += size[c];
  return { idom, size, children };
}

const rel = (f) => path.relative(repoRoot, f).replace(/\\/g, '/');

function shortestPath(g, targetIdx) {
  const { succ, nodes } = g;
  const parent = new Int32Array(nodes.length).fill(-2);
  parent[0] = -1;
  const q = [0];
  for (let h = 0; h < q.length; h++) {
    const v = q[h];
    if (v === targetIdx) break;
    for (const w of succ[v])
      if (parent[w] === -2) {
        parent[w] = v;
        q.push(w);
      }
  }
  if (parent[targetIdx] === -2) return null;
  const out = [];
  for (let c = targetIdx; c !== -1; c = parent[c]) out.push(rel(nodes[c]));
  return out.reverse();
}

const [cmd, ...rest] = process.argv.slice(2);
const topArg = rest.indexOf('--top');
const TOP = topArg >= 0 ? Number(rest[topArg + 1]) : 20;
const args = rest.filter((a, i) => (topArg < 0 ? true : i !== topArg && i !== topArg + 1));

function abs(p) {
  return norm(path.resolve(repoRoot, p));
}

if (cmd === 'union') {
  // Suite-wide view: one synthetic root over every unit test file, so a dominator subtree is
  // exactly "modules that leave the UNION when this node stops being reachable". Under
  // `isolate: false` each worker builds one registry from that union, so this — not any single
  // file's closure — is what the registry-build floor is proportional to.
  const unitTests = files
    .map(norm)
    .filter((f) => /\.test\.ts$/.test(f) && (f.includes('/src/') || f.includes('/scripts/')))
    .filter((f) => !f.includes('/packages/'));
  const ROOT = '<<all-unit-tests>>';
  cache.set(ROOT, { internal: unitTests, bytes: 0 });
  const g = buildGraph(ROOT);
  const { size } = dominators(g);
  console.log(`union: ${g.nodes.length - 1} first-party modules over ${unitTests.length} tests`);
  const rows = [];
  for (let v = 1; v < g.nodes.length; v++) {
    if (size[v] < 5 || g.nodes[v].endsWith('.test.ts')) continue;
    rows.push({ v, size: size[v] });
  }
  rows.sort((a, b) => b.size - a.size);
  for (const r of rows.slice(0, TOP)) {
    const preds = g.pred[r.v].map((p) => rel(g.nodes[p]));
    console.log(
      `  -${String(r.size).padStart(4)}  ${rel(g.nodes[r.v])}   [preds ${preds.length}${
        preds.length <= 3 ? ': ' + preds.join(', ') : ''
      }]`
    );
  }
} else if (cmd === 'union-real') {
  // Same question as `union`, but honouring `vi.mock`: a factory mock without `importOriginal`
  // stops the real module — and its whole subtree — from ever being fetched, so counting it in
  // the registry overstates the win from cutting an edge that no test actually walks.
  const inv = JSON.parse(readFileSync(path.join(repoRoot, '.test-perf/inventory.json'), 'utf8'));
  const unitTests = inv.files.map((f) => norm(path.join(repoRoot, f.file)));
  const blockedFor = new Map();
  for (const f of inv.files) {
    const blocked = new Set();
    for (const m of f.mocks) {
      if (!m.hasFactory || m.importOriginal) continue;
      const r = resolveSpecifier(m.specifier, norm(path.join(repoRoot, f.file)));
      if (r) blocked.add(r);
    }
    blockedFor.set(norm(path.join(repoRoot, f.file)), blocked);
  }

  const reach = (root, blocked, cut) => {
    const seen = new Set([root]);
    const q = [root];
    while (q.length) {
      const cur = q.pop();
      for (const dep of importsOf(cur).internal) {
        if (seen.has(dep) || blocked.has(dep) || dep === cut) continue;
        seen.add(dep);
        q.push(dep);
      }
    }
    return seen;
  };
  const unionSize = (cut) => {
    const u = new Set();
    for (const t of unitTests) for (const m of reach(t, blockedFor.get(t) ?? new Set(), cut)) u.add(m);
    return u;
  };

  const base = unionSize(null);
  const nonTest = [...base].filter((m) => !m.endsWith('.test.ts'));
  console.log(`effective union: ${nonTest.length} first-party modules (mocks honoured)`);

  // Candidate generation from the mock-blind dominator view, then verify each by recomputing.
  const ROOT = '<<all-unit-tests>>';
  cache.set(ROOT, { internal: unitTests, bytes: 0 });
  const g = buildGraph(ROOT);
  const { size } = dominators(g);
  const cands = [];
  for (let v = 1; v < g.nodes.length; v++)
    if (size[v] >= 5 && !g.nodes[v].endsWith('.test.ts')) cands.push([g.nodes[v], size[v]]);
  cands.sort((a, b) => b[1] - a[1]);

  const rows = [];
  for (const [mod] of cands.slice(0, Number(process.env.UNION_CANDIDATES ?? 60))) {
    const after = unionSize(mod);
    const loss = base.size - after.size;
    if (loss >= 5) rows.push({ mod, loss });
  }
  rows.sort((a, b) => b.loss - a.loss);
  for (const r of rows.slice(0, TOP)) console.log(`  -${String(r.loss).padStart(4)}  ${rel(r.mod)}`);
} else if (cmd === 'cuts' || cmd === 'cuts-many') {
  for (const entryRel of args) {
    const entry = abs(entryRel);
    const g = buildGraph(entry);
    const { idom, size } = dominators(g);
    console.log(`\n=== ${rel(entry)}  (${g.nodes.length} modules)`);
    const rows = [];
    for (let v = 1; v < g.nodes.length; v++) {
      if (size[v] < 5) continue;
      rows.push({ v, size: size[v], preds: g.pred[v].length });
    }
    rows.sort((a, b) => b.size - a.size);
    for (const r of rows.slice(0, TOP)) {
      const via = g.pred[r.v].map((p) => rel(g.nodes[p]));
      console.log(
        `  -${String(r.size).padStart(4)}  ${rel(g.nodes[r.v])}   [preds ${r.preds}${
          r.preds <= 2 ? ': ' + via.join(', ') : ''
        }]  idom=${rel(g.nodes[idom[r.v]])}`
      );
    }
  }
} else if (cmd === 'path') {
  let entry = abs(args[0]);
  if (args[0] === 'all') {
    entry = '<<all-unit-tests>>';
    cache.set(entry, {
      internal: files
        .map(norm)
        .filter((f) => /\.test\.ts$/.test(f) && f.includes('/src/'))
        .filter((f) => !f.includes('/packages/')),
      bytes: 0,
    });
  }
  const needle = args[1];
  const g = buildGraph(entry);
  const hits = g.nodes.map((n, i) => [n, i]).filter(([n]) => norm(n).includes(needle));
  if (!hits.length) console.log('no module matching', needle);
  for (const [, i] of hits.slice(0, 10)) {
    const p = shortestPath(g, i);
    console.log('\n' + p.map((h, k) => (k ? '  -> ' : '') + h).join('\n'));
  }
} else {
  console.log('usage: cuts.mjs cuts <entry> [--top N] | path <entry> <substring>');
}
