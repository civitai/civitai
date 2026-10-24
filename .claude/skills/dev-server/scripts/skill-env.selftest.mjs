// Safety checks for `wt env`. Run:
//   node .claude/skills/dev-server/scripts/skill-env.selftest.mjs
//
// The verb copies CREDENTIALS, so the properties worth testing are the ones where it could do
// damage rather than the happy path: it must never overwrite a credential a tree already has,
// and never replace a newer backup with an older working copy. Both are silent if wrong — the
// file still exists, it is just the wrong one, and the skill then authenticates as something
// unexpected or not at all.
//
// `wants` is tested too: without it a 47-skill tree reports 40-odd "missing" credentials for
// skills that take none, which buries the handful that matter and trains people to ignore it.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const root = mkdtempSync(resolve(tmpdir(), 'skill-env-'));
const store = join(root, 'store');
process.env.CIVITAI_SKILL_ENV_HOME = store;

const { survey, cmdSkillEnv, backupDir } = await import('./skill-env.mjs');

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    console.error(`FAIL  ${label}\n      expected ${JSON.stringify(expected)}\n      got      ${JSON.stringify(actual)}`);
    failures++;
  } else console.log(`ok    ${label}`);
}

function tree(name, skills) {
  const r = join(root, name);
  for (const [skill, files] of Object.entries(skills)) {
    const d = join(r, '.claude', 'skills', skill);
    mkdirSync(d, { recursive: true });
    for (const [file, body] of Object.entries(files)) writeFileSync(join(d, file), body);
  }
  return r;
}

// ── the store location is outside any repo ─────────────────────────────────
check('backupDir honours the override', backupDir(), store);

// ── survey: has / wants ───────────────────────────────────────────────────
const primary = tree('primary', {
  alpha: { '.env': 'A=1', '.env.example': 'A=' },
  beta: { '.env.example': 'B=' }, // takes credentials, has none
  gamma: {}, // takes none
});
const s = survey(primary);
check(
  'survey classifies has/wants',
  s.map((r) => [r.skill, r.has, r.wants]),
  [
    ['alpha', true, true],
    ['beta', false, true],
    ['gamma', false, false],
  ]
);

// ── sync fills gaps and NEVER overwrites ──────────────────────────────────
const wt = tree('wt', { alpha: { '.env': 'LOCAL=keepme' }, beta: { '.env.example': 'B=' } });
cmdSkillEnv(primary, [wt]);
check(
  'sync does not overwrite a credential the tree already has',
  readFileSync(join(wt, '.claude/skills/alpha/.env'), 'utf8'),
  'LOCAL=keepme'
);

const wt2 = tree('wt2', { alpha: { '.env.example': 'A=' } });
cmdSkillEnv(primary, [wt2]);
check(
  'sync fills a gap from the primary',
  readFileSync(join(wt2, '.claude/skills/alpha/.env'), 'utf8'),
  'A=1'
);

// a skill absent from the target is skipped rather than created
const wt3 = tree('wt3', { beta: { '.env.example': 'B=' } });
cmdSkillEnv(primary, [wt3]);
check(
  'sync does not invent a skill directory the target lacks',
  survey(wt3).map((r) => [r.skill, r.has]),
  [['beta', false]]
);

// ── backup is newest-wins ─────────────────────────────────────────────────
cmdSkillEnv(primary, ['--backup']);
check('backup writes the store', readFileSync(join(store, 'alpha.env'), 'utf8'), 'A=1');

// an OLDER working copy must not clobber a NEWER backup
writeFileSync(join(store, 'alpha.env'), 'NEWER=1');
const old = new Date(Date.now() - 60_000);
utimesSync(join(primary, '.claude/skills/alpha/.env'), old, old);
cmdSkillEnv(primary, ['--backup']);
check(
  'backup keeps a newer backup over an older working copy',
  readFileSync(join(store, 'alpha.env'), 'utf8'),
  'NEWER=1'
);

// ── restore only fills gaps ───────────────────────────────────────────────
const wt4 = tree('wt4', { alpha: { '.env': 'MINE=1', '.env.example': 'A=' } });
cmdSkillEnv(wt4, ['--restore']);
check(
  'restore does not overwrite what the tree already has',
  readFileSync(join(wt4, '.claude/skills/alpha/.env'), 'utf8'),
  'MINE=1'
);

const wt5 = tree('wt5', { alpha: { '.env.example': 'A=' } });
cmdSkillEnv(wt5, ['--restore']);
check(
  'restore fills a gap from the store',
  readFileSync(join(wt5, '.claude/skills/alpha/.env'), 'utf8'),
  'NEWER=1'
);

// -- syncSkillEnv: what `wt new` calls --------------------------------------
// It reports rather than prints, and `absent` is the half that makes the gap visible at
// creation time. A skill nobody has credentials for (flipt, today) must show up there.
const { syncSkillEnv } = await import('./skill-env.mjs');

const wt6 = tree('wt6', { alpha: { '.env.example': 'A=' }, beta: { '.env.example': 'B=' } });
const r6 = syncSkillEnv(primary, wt6);
check('syncSkillEnv fills gaps and names them', [r6.copied, r6.names], [1, ['alpha']]);
check('syncSkillEnv reports a skill no tree has credentials for', r6.absent, ['beta']);

const r6again = syncSkillEnv(primary, wt6);
check('syncSkillEnv is idempotent', [r6again.copied, r6again.kept], [0, 1]);

check(
  'syncSkillEnv refuses to copy a tree onto itself',
  syncSkillEnv(primary, primary).skipped,
  'same-tree'
);
check(
  'syncSkillEnv reports a target that is not a checkout',
  syncSkillEnv(primary, join(root, 'nope')).skipped,
  'no-skills-dir'
);

// -- the three states: set / served by the root .env / genuinely absent ------
// The report over-reported before this: it checked only for a skill OWN .env, so three
// skills that work fine by reading the root file were listed as missing credentials. A
// report that cries wolf is one people stop reading, which is the failure it exists to
// prevent.
const rooted = tree('rooted', {
  served: { '.env.example': 'SHARED_KEY=' },
  unserved: { '.env.example': 'PRIVATE_KEY=' },
  wiring: { '.env.example': '# skill-env: settings-only\nPORT=' },
});
writeFileSync(join(rooted, '.env'), 'SHARED_KEY=from-the-root');

const states = Object.fromEntries(
  survey(rooted).map((r) => [r.skill, r.viaRoot ? 'root' : r.has ? 'set' : r.wants ? 'absent' : 'n/a'])
);
check('a skill whose keys the root .env supplies is not reported absent', states.served, 'root');
check('a skill whose keys the root .env lacks IS reported absent', states.unserved, 'absent');
check('an example marked settings-only is not a credential gap', states.wiring, 'n/a');

// the blocking key is named, because that is the actionable half
check(
  'the absent row knows which key is missing',
  survey(rooted).find((r) => r.skill === 'unserved').missingFromRoot,
  ['PRIVATE_KEY']
);

// and the same narrowing reaches `wt new`, which warns off this list
const warnTarget = tree('warn', {
  served: { '.env.example': 'SHARED_KEY=' },
  unserved: { '.env.example': 'PRIVATE_KEY=' },
});
writeFileSync(join(warnTarget, '.env'), 'SHARED_KEY=from-the-root');
check(
  'wt new warns only about skills the root .env cannot serve',
  syncSkillEnv(rooted, warnTarget).absent,
  ['unserved']
);

rmSync(root, { recursive: true, force: true });
console.log(failures ? `\n${failures} failure(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
