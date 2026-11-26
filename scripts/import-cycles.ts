/**
 * The import-cycle worklist: every cycle in src/, the edges whose cut shrinks them most, and how
 * many modules pages and API routes reach. Uses the guards' own import graph, dynamic `import()`
 * included, so its numbers match no-import-cycle-growth.
 *
 *   pnpm exec tsx scripts/import-cycles.ts [--cuts 25] [--json out.json]
 *
 * docs/dev/import-cycles.md says how to read it and how to break a cut.
 */
import fs from 'fs';
import path from 'path';

import {
  importCycles,
  importGraph,
  REPO_ROOT,
  rel,
} from '../src/server/services/__tests__/import-graph.harness';

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};
const CUTS = Number(arg('--cuts') ?? 25);
const JSON_OUT = arg('--json');

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__' && entry.name !== 'node_modules') sources(full, out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
      out.push(rel(full));
    }
  }
  return out;
}

const all = sources(path.join(REPO_ROOT, 'src'));
const graph = importGraph(all);
const staticGraph = importGraph(all, { followDynamic: false });
const isDynamic = (from: string, to: string) => !staticGraph.get(from)?.includes(to);

const weight = (cycles: string[][]) => cycles.reduce((n, c) => n + c.length ** 2, 0);

function subgraph(nodes: string[], cut: Set<string>) {
  const set = new Set(nodes);
  return new Map(
    nodes.map((f) => [f, (graph.get(f) ?? []).filter((t) => set.has(t) && !cut.has(`${f}>${t}`))])
  );
}

/** Cut the edge that most lowers the cycles' weight, CUTS times over. */
function rankCuts(cycle: string[]) {
  const cut = new Set<string>();
  const steps: { from: string; to: string; dynamic: boolean; sizes: number[] }[] = [];
  let live = importCycles(subgraph(cycle, cut));
  while (steps.length < CUTS && live.length) {
    const nodes = live.flat();
    const sub = subgraph(nodes, cut);
    let best: { from: string; to: string; w: number } | null = null;
    for (const [from, deps] of sub) {
      for (const to of deps) {
        const key = `${from}>${to}`;
        cut.add(key);
        const w = weight(importCycles(subgraph(nodes, cut)));
        cut.delete(key);
        if (!best || w < best.w) best = { from, to, w };
      }
    }
    if (!best) break;
    cut.add(`${best.from}>${best.to}`);
    live = importCycles(subgraph(nodes, cut));
    steps.push({
      from: best.from,
      to: best.to,
      dynamic: isDynamic(best.from, best.to),
      sizes: live.map((c) => c.length),
    });
  }
  return steps;
}

function reach(entry: string) {
  const seen = new Set([entry]);
  const stack = [entry];
  while (stack.length) {
    for (const next of graph.get(stack.pop()!) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return seen.size;
}

function reachStats(entries: string[]) {
  const n = entries.map(reach).sort((a, b) => a - b);
  const at = (q: number) => n[Math.min(n.length - 1, Math.floor(n.length * q))] ?? 0;
  return {
    entries: n.length,
    median: at(0.5),
    p75: at(0.75),
    summed: n.reduce((a, b) => a + b, 0),
  };
}

const cycles = importCycles(graph);
const report = {
  modulesInCycles: cycles.reduce((n, c) => n + c.length, 0),
  weight: weight(cycles),
  sizes: cycles.map((c) => c.length),
  reach: {
    pages: reachStats(
      all.filter((f) => f.startsWith('src/pages/') && !f.startsWith('src/pages/api/'))
    ),
    api: reachStats(all.filter((f) => f.startsWith('src/pages/api/'))),
  },
  cycles: cycles
    .filter((c) => c.length >= 10)
    .map((members) => ({ size: members.length, members, cuts: rankCuts(members) })),
};

console.log(`modules in cycles: ${report.modulesInCycles}, weight: ${report.weight}`);
console.log(`cycle sizes: ${report.sizes.join(', ')}`);
for (const [kind, s] of Object.entries(report.reach)) {
  console.log(
    `${kind}: ${s.entries} entries, median reach ${s.median}, p75 ${s.p75}, summed ${s.summed}`
  );
}
for (const c of report.cycles) {
  console.log(`\ncycle of ${c.size}, best cuts in order:`);
  c.cuts.forEach((s, i) =>
    console.log(
      `  ${String(i + 1).padStart(2)}. ${s.from} -> ${s.to}${s.dynamic ? ' (dynamic)' : ''}  => ${
        s.sizes.slice(0, 5).join(', ') || 'gone'
      }`
    )
  );
}
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(report, null, 1));
