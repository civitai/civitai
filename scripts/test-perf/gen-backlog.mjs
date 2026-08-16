#!/usr/bin/env node
/**
 * The unit-fast migration backlog: every file not yet a member, what blocks it, and which
 * specifier would unblock the most.
 *
 *   node scripts/test-perf/gen-backlog.mjs <repoRoot> <out.json>
 *
 * Read alongside the manifest, never instead of it. The manifest is the AUTHORITY on membership
 * (and the guard enforces it); this is a planning view derived from the same two inputs.
 *
 * 🔴 `blockers` here is every NON-CANONICAL specifier a pending file mocks, which is an UPPER
 * BOUND on what actually blocks it: the membership rule only evicts on a non-canonical mock that
 * is also SHARED with another member. Some of these are already private and cost nothing. Do not
 * quote a blocker count as work remaining without checking sharing.
 *
 * 🔑 Rank by `clears`, not `touches` — they are different orderings and the biggest specifier is
 * usually not the best first move. `~/env/server` touches 100 pending files and clears 17.
 */
import { readFileSync, writeFileSync } from 'fs';

const repo = process.argv[2];
const out = process.argv[3];
const m = JSON.parse(readFileSync(`${repo}/src/__tests__/mocks/unit-fast-manifest.json`, 'utf8'));
const inv = JSON.parse(readFileSync(`${repo}/.test-perf/inventory.json`, 'utf8'));
const byFile = new Map(inv.files.map((f) => [f.file, f]));
const CANON = new Set(m.canonicalSpecifiers);
const members = new Set(m.members);
const excluded = new Set(Object.keys(m.excluded));

const pending = [];
for (const f of byFile.keys()) {
  if (members.has(f) || excluded.has(f)) continue;
  const rec = byFile.get(f);
  const blockers = [
    ...new Set(rec.mocks.map((x) => x.specifier).filter((s) => !CANON.has(s))),
  ].sort();
  const canonicalDirect = [
    ...new Set(rec.mocks.map((x) => x.specifier).filter((s) => CANON.has(s))),
  ].sort();
  pending.push({ file: f, blockers, canonicalDirect, loads: rec.graphModules ?? 0 });
}
if (!pending.length) {
  console.error('zero pending files — refusing to write an empty backlog');
  process.exit(2);
}

// Group by slice so it can be handed out as work.
const sliceOf = (f) => {
  if (f.startsWith('scripts/')) return 'scripts/';
  if (f.startsWith('src/tests/')) return 'src/tests/';
  if (f.startsWith('src/components/')) return 'src/components/';
  if (f.startsWith('src/server/services/blocks/')) return 'server/services/blocks/';
  if (f.startsWith('src/server/services/orchestrator/')) return 'server/services/orchestrator/';
  if (f.startsWith('src/server/services/')) return 'server/services/';
  if (f.startsWith('src/server/routers/')) return 'server/routers/';
  if (f.startsWith('src/server/jobs/')) return 'server/jobs/';
  if (f.startsWith('src/server/')) return 'server/ (other)';
  return 'other';
};

const slices = new Map();
for (const p of pending) {
  const s = sliceOf(p.file);
  if (!slices.has(s))
    slices.set(s, { files: 0, zeroBlocker: 0, oneAway: 0, loads: 0, specs: new Set() });
  const g = slices.get(s);
  g.files++;
  g.loads += p.loads;
  if (!p.blockers.length) g.zeroBlocker++;
  if (p.blockers.length === 1) g.oneAway++;
  p.blockers.forEach((b) => g.specs.add(b));
}

// Unlock ranking: how many pending files would become member-eligible if this ONE specifier
// went canonical (i.e. it is their only remaining blocker). Distinct from raw frequency.
const touches = new Map();
const clears = new Map();
for (const p of pending) {
  for (const b of p.blockers) touches.set(b, (touches.get(b) ?? 0) + 1);
  if (p.blockers.length === 1) clears.set(p.blockers[0], (clears.get(p.blockers[0]) ?? 0) + 1);
}
const ranked = [...touches]
  .map(([spec, t]) => ({ spec, touches: t, clears: clears.get(spec) ?? 0 }))
  .sort((a, b) => b.clears - a.clears || b.touches - a.touches);

const data = {
  generatedFrom: 'src/__tests__/mocks/unit-fast-manifest.json + .test-perf/inventory.json',
  totals: {
    allTestFiles: m.totals.testFiles,
    members: m.totals.members,
    permanentlyExcluded: m.totals.excludedPermanently,
    pending: pending.length,
    pendingZeroBlockers: pending.filter((p) => !p.blockers.length).length,
    pendingOneAway: pending.filter((p) => p.blockers.length === 1).length,
    distinctBlockingSpecifiers: touches.size,
    pendingModuleLoads: pending.reduce((n, p) => n + p.loads, 0),
    memberModuleLoads: m.totals.moduleLoadsInMembers,
  },
  slices: [...slices]
    .map(([name, g]) => ({
      name,
      files: g.files,
      oneAway: g.oneAway,
      zeroBlocker: g.zeroBlocker,
      loads: g.loads,
      distinctSpecs: g.specs.size,
    }))
    .sort((a, b) => b.files - a.files),
  topSpecifiers: ranked.slice(0, 25),
  pending: pending.sort((a, b) => a.blockers.length - b.blockers.length || b.loads - a.loads),
};
writeFileSync(out, JSON.stringify(data, null, 2) + '\n');
console.log(
  `pending ${pending.length} | one-away ${data.totals.pendingOneAway} | zero-blocker ${data.totals.pendingZeroBlockers} | distinct specifiers ${touches.size}`
);
console.log('top unlocks (clears / touches):');
ranked
  .slice(0, 12)
  .forEach((r) =>
    console.log(
      `   clears ${String(r.clears).padStart(3)}  touches ${String(r.touches).padStart(3)}  ${
        r.spec
      }`
    )
  );
console.log('slices:');
data.slices.forEach((s) =>
  console.log(
    `   ${String(s.files).padStart(4)} files  ${String(s.oneAway).padStart(3)} one-away  ${s.name}`
  )
);
