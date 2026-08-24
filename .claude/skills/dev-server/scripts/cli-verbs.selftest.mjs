// Every function the dispatch switch in cli.mjs calls must actually be defined in cli.mjs.
//
// This exists because a refactor deleted `cmdStop` and `cmdRestart` while leaving both call sites,
// so `stop <session-id>` and `restart <session-id>` — the two most-used commands in the skill —
// threw ReferenceError for everyone on that branch. Nothing in the chain saw it: `node --check`
// passes (a missing binding is not a syntax error), `pnpm typecheck` is scoped to src/, CI's ESLint
// filters by path prefix, and every other selftest imports daemon.mjs / worktree.mjs / paths.mjs.
// Not one of them loads cli.mjs, so the file holding all the user-facing dispatch had no reader.
//
// It is a source check rather than a run of each verb, and that is deliberate: the first version
// spawned the CLI once per verb, which took 56s AND started a real daemon, because most verbs call
// ensureDaemon() before validating their own arguments. A test that boots servers to prove a symbol
// exists is worse than the bug. Importing cli.mjs would not work either — the switch runs at import
// and an unevaluated branch stays unevaluated.
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const cliPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'cli.mjs');
const src = readFileSync(cliPath, 'utf-8');
const failures = [];
let checks = 0;

// Everything callable that cli.mjs defines: `function f(`, `async function f(`, `const f = (`,
// `const f = async (`, and the imports at the top.
const defined = new Set();
for (const re of [
  /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g,
  /(?:^|\n)\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function)/g,
  /import\s*\{([^}]*)\}\s*from/g,
  // Destructuring, which the `const NAME =` pattern above does not match. cli.mjs reaches `cmdStale`
  // and `cmdRemove` via `const { cmdStale, cmdRemove } = await import('./scripts/worktree.mjs')`,
  // so without this the widened scan below reports both as undefined.
  /(?:const|let|var)\s*\{([^}]*)\}\s*=/g,
]) {
  for (const m of src.matchAll(re)) {
    for (const name of m[1].split(',')) {
      const clean = name.trim().split(/\s+as\s+/).pop()?.trim();
      if (clean) defined.add(clean);
    }
  }
}

// The WHOLE file, not just the dispatch switch. Scanning only the switch missed every helper reached
// from another function — including `followLogs`, whose extraction is what deleted cmdStop and
// cmdRestart in the first place. A slice running a few lines further would have taken it too, and a
// switch-only guard would have stayed green over its own cause.
const called = new Set();
for (const m of src.matchAll(/\b((?:cmd|follow)[A-Za-z0-9_$]*)\s*\(/g)) called.add(m[1]);

// The switch still has to be there. Without it this file is reading something that is not the CLI,
// and every result below is meaningless rather than reassuring.
checks++;
if (!src.includes('switch (command) {')) {
  failures.push('could not find the dispatch switch — this guard is looking at the wrong thing');
}

// If this ever drops to a handful, the regex has stopped matching and the guard has gone quiet
// without failing — the shape of an inert check.
checks++;
if (called.size < 8) {
  failures.push(`only ${called.size} cmd*/follow* calls found — the extractor is probably broken`);
}

for (const name of [...called].sort()) {
  checks++;
  if (!defined.has(name)) {
    failures.push(`cli.mjs calls \`${name}(\` and does not define it`);
  }
}

if (failures.length) {
  console.error('FAIL');
  for (const f of failures) console.error('  ' + f);
  process.exit(1);
}
console.log(`cli-verbs selftest: ${checks} checks, ${called.size} call targets all defined`);
