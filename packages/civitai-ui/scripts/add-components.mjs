// Fetches shadcn-svelte components from the live stable registry and writes them
// into this package, rewriting the CLI's alias placeholders ($UTILS$, $UI$, ...)
// from components.json. The official CLI (>=1.3) defaults to a dead `nova` registry
// and its `init` clobbers our custom theme.css, so we pull directly instead.
//
// Usage:  node scripts/add-components.mjs accordion alert switch ...
//         node scripts/add-components.mjs --all-free      (every dep-free registry:ui component)
//         node scripts/add-components.mjs accordion --force   (overwrite existing)

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REGISTRY = "https://shadcn-svelte.com/registry";
const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const uiDir = join(pkgRoot, "src/lib/components/ui");

const components = JSON.parse(readFileSync(join(pkgRoot, "components.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));
const haveDeps = new Set([
  ...Object.keys(pkg.dependencies || {}),
  ...Object.keys(pkg.peerDependencies || {}),
  ...Object.keys(pkg.devDependencies || {}),
]);

const a = components.aliases;
const tokenMap = {
  $UTILS$: a.utils,
  $UI$: a.ui,
  $COMPONENTS$: a.components,
  $HOOKS$: a.hooks,
  $LIB$: a.lib,
};

const args = process.argv.slice(2);
const force = args.includes("--force");
const allFree = args.includes("--all-free");
let requested = args.filter((x) => !x.startsWith("--"));

const cache = new Map();
async function getItem(name) {
  if (cache.has(name)) return cache.get(name);
  const res = await fetch(`${REGISTRY}/${name}.json`, { redirect: "follow" });
  if (!res.ok) throw new Error(`fetch ${name}: ${res.status}`);
  const json = await res.json();
  cache.set(name, json);
  return json;
}

async function getIndex() {
  const res = await fetch(`${REGISTRY}/index.json`, { redirect: "follow" });
  return res.json();
}

function applyTokens(content) {
  let out = content;
  for (const [tok, val] of Object.entries(tokenMap)) out = out.split(tok).join(val);
  const leftover = out.match(/\$[A-Z_]+\$/g);
  if (leftover) throw new Error(`unmapped tokens: ${[...new Set(leftover)].join(", ")}`);
  return out;
}

const onDisk = new Set(existsSync(uiDir) ? readdirSync(uiDir) : []);
const written = [];
const skipped = [];
const newDeps = new Set();
const seen = new Set();

async function add(name, isDep) {
  if (seen.has(name)) return;
  seen.add(name);

  const item = await getItem(name);
  if (item.type !== "registry:ui") {
    console.warn(`! ${name}: type ${item.type} — skipping (not a ui component)`);
    return;
  }

  for (const d of item.registryDependencies || []) await add(d, true);

  for (const dep of [...(item.dependencies || []), ...(item.devDependencies || [])]) {
    const bare = dep.replace(/@(?:\^|~|>=)?[0-9].*$/, "").replace(/@next$/, "");
    if (!haveDeps.has(bare)) newDeps.add(dep);
  }

  if (onDisk.has(name) && !force) {
    skipped.push(name);
    return;
  }

  for (const file of item.files || []) {
    const target = file.target;
    if (!target) throw new Error(`${name}: file without target`);
    const outPath = join(uiDir, target);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, applyTokens(file.content));
    written.push(target);
  }
}

const idx = await getIndex();
if (allFree) {
  const ui = idx.filter((i) => i.type === "registry:ui");
  const draggers = new Set();
  for (const i of ui) {
    const item = await getItem(i.name);
    const deps = [...(item.dependencies || []), ...(item.devDependencies || [])];
    if (deps.some((d) => !haveDeps.has(d.replace(/@(?:\^|~|>=)?[0-9].*$/, "").replace(/@next$/, ""))))
      draggers.add(i.name);
  }
  requested = ui.map((i) => i.name).filter((n) => !draggers.has(n));
}

if (requested.length === 0) {
  console.error("no components requested. pass names or --all-free");
  process.exit(1);
}

for (const name of requested) await add(name, false);

console.log(`\nwrote ${written.length} files across ${new Set(written.map((t) => t.split("/")[0])).size} components`);
if (skipped.length) console.log(`skipped (already present, use --force): ${skipped.join(", ")}`);
if (newDeps.size) {
  console.log(`\n⚠ NEW npm deps required (install manually):\n  ${[...newDeps].join("\n  ")}`);
} else {
  console.log("no new npm deps needed ✓");
}
