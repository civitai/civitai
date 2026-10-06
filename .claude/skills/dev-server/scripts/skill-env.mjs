/**
 * Skill credentials: report them, copy them into a worktree, and keep a copy outside the repo.
 *
 * Three failures this exists for, all observed on 2026-10-05:
 *
 * 1. A WORKTREE GETS NONE OF THEM. The daemon layers the APP's env chain (root `.env`, per-app
 *    `.env`) and nothing has ever touched `.claude/skills/*​/.env`, so a fresh worktree starts
 *    with zero of them. Measured: the primary had 7, the worktree 0 of 47 skill dirs. There is
 *    no `wt create` to hook — worktrees come from the `git worktree add` recipe in CLAUDE.md —
 *    so this is a verb that recipe calls, not an automatic step.
 *
 * 2. THE GAP IS INVISIBLE. A missing credential surfaces as whatever that skill says when it
 *    cannot authenticate: "FLIPT_URL and FLIPT_API_TOKEN must be set", "credentials not
 *    configured", or a bare 401. Every one of those reads as a bug in the skill. The flipt
 *    failure in that session was seen and shrugged off for exactly this reason, and diagnosing
 *    the discord one took a dozen commands to reach "the file isn't there".
 *
 * 3. THEY ARE ONE `git clean` FROM GONE. `discord/.gitignore` lists `.env`, so `clean -x`
 *    removes it; `flipt` has no `.gitignore`, so the file is untracked and `clean -d` removes
 *    it. Both were missing from the primary while siblings sat untouched since May — the shape
 *    of an accidental clean, with no backup to restore from.
 *
 * 🔴 NEVER PRINTS A VALUE. Every report here is a filename and a set/absent verdict. A skill
 * credential inventory annotated with what each unlocks is precisely what must not exist, and
 * this repository is public.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'fs';
import { homedir } from 'os';
import { basename, join, resolve } from 'path';
import { resolvePrimaryCheckout, samePath } from './paths.mjs';

/**
 * Where the out-of-repo copy lives.
 *
 * Outside the repo is the whole point — a backup inside it is removed by the same `clean` that
 * removed the original. A per-user config directory, not a path anyone has to remember: the
 * verbs below are the interface.
 */
export function backupDir() {
  const base =
    process.env.CIVITAI_SKILL_ENV_HOME ??
    (process.platform === 'win32'
      ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'civitai-skill-env')
      : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'civitai-skill-env'));
  return base;
}

const skillsDir = (root) => join(root, '.claude', 'skills');

/** Skill directory names in `root`, sorted. Empty when the tree has no skills dir. */
function skillNames(root) {
  const dir = skillsDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

const envPath = (root, skill) => join(skillsDir(root), skill, '.env');

/**
 * What each skill's credential state is in `root`, plus whether a backup exists for it.
 *
 * `wants` is the signal that a skill takes credentials at all: a `.env.example` beside it. A
 * skill with neither file wants nothing and is not a gap — reporting all 47 as "missing" would
 * bury the handful that matter.
 */
export function survey(root) {
  const backup = backupDir();
  return skillNames(root).map((skill) => {
    const p = envPath(root, skill);
    const has = existsSync(p);
    return {
      skill,
      has,
      wants: existsSync(join(skillsDir(root), skill, '.env.example')),
      backedUp: existsSync(join(backup, `${skill}.env`)),
      mtime: has ? statSync(p).mtime : undefined,
    };
  });
}

function report(root, rows) {
  const relevant = rows.filter((r) => r.has || r.wants);
  const missing = relevant.filter((r) => !r.has);
  const present = relevant.filter((r) => r.has);

  console.log(`\nSkill credentials in ${root}\n`);
  for (const r of present) {
    const age = r.mtime ? r.mtime.toISOString().slice(0, 10) : '';
    console.log(`  set      ${r.skill.padEnd(20)} ${age}${r.backedUp ? '' : '   (no backup)'}`);
  }
  for (const r of missing) {
    console.log(`  ABSENT   ${r.skill.padEnd(20)} ${r.backedUp ? 'restorable from backup' : ''}`);
  }
  if (!relevant.length) console.log('  (no skill in this tree takes credentials)');

  const restorable = missing.filter((r) => r.backedUp).length;
  const unbacked = present.filter((r) => !r.backedUp).length;
  console.log(
    `\n  ${present.length} set, ${missing.length} absent${
      restorable ? ` (${restorable} restorable)` : ''
    }`
  );
  if (restorable) console.log(`  Restore:  cli.mjs wt env --restore`);
  if (unbacked) console.log(`  Back up:  cli.mjs wt env --backup      (${unbacked} unprotected)`);
  console.log('');
  return { present: present.length, missing: missing.length, restorable, unbacked };
}

/** Copy every credential this tree has into the out-of-repo store. */
function backup(root, rows) {
  const dest = backupDir();
  mkdirSync(dest, { recursive: true });
  let copied = 0;
  for (const r of rows.filter((x) => x.has)) {
    const to = join(dest, `${r.skill}.env`);
    // Newest wins, so running this after an edit keeps the edit and running it twice is a
    // no-op. It must never clobber a good backup with an older working copy.
    if (existsSync(to) && statSync(to).mtime >= r.mtime) continue;
    copyFileSync(envPath(root, r.skill), to);
    copied++;
  }
  console.log(`\nBacked up ${copied} credential file(s) outside the repo.`);
  console.log(`  ${dest}\n`);
  return copied;
}

/** Bring back anything this tree is missing that the store has. */
function restore(root, rows) {
  const dest = backupDir();
  let restored = 0;
  for (const r of rows) {
    const from = join(dest, `${r.skill}.env`);
    if (r.has || !existsSync(from)) continue;
    const target = envPath(root, r.skill);
    if (!existsSync(join(skillsDir(root), r.skill))) continue;
    copyFileSync(from, target);
    console.log(`  restored  ${r.skill}`);
    restored++;
  }
  console.log(
    restored
      ? `\nRestored ${restored} credential file(s) from the backup.\n`
      : '\nNothing to restore — every skill that takes credentials already has them.\n'
  );
  return restored;
}

/**
 * Copy the primary checkout's credentials into `target`.
 *
 * Only fills gaps. A worktree may legitimately hold a different credential (a scratch token, a
 * different environment), and silently replacing it with the primary's would be the one way
 * this verb could do damage.
 */
/**
 * Copy the primary checkout's skill credentials into `target`, filling gaps only, and report
 * what happened. Prints nothing: `wt new` wants one line, the CLI verb wants a listing.
 *
 * `absent` is the part worth surfacing at creation time -- a skill that takes credentials which
 * exist in NO tree. That is `flipt` today, and the only other way to learn it is to run the
 * skill and read an error that looks like the skill itself being broken.
 */
export function syncSkillEnv(primary, target) {
  if (samePath(primary, target))
    return { skipped: 'same-tree', copied: 0, kept: 0, names: [], absent: [] };
  if (!existsSync(skillsDir(target)))
    return { skipped: 'no-skills-dir', copied: 0, kept: 0, names: [], absent: [] };

  const names = [];
  let kept = 0;
  for (const r of survey(primary).filter((x) => x.has)) {
    if (!existsSync(join(skillsDir(target), r.skill))) continue;
    const to = envPath(target, r.skill);
    // Never overwrite: a worktree may hold a different credential on purpose.
    if (existsSync(to)) {
      kept++;
      continue;
    }
    copyFileSync(envPath(primary, r.skill), to);
    names.push(r.skill);
  }

  const absent = survey(target)
    .filter((r) => r.wants && !r.has)
    .map((r) => r.skill);
  return { copied: names.length, kept, names, absent };
}

function sync(primary, target) {
  const r = syncSkillEnv(primary, target);
  if (r.skipped === 'same-tree') {
    console.error('That is the primary checkout, so there is nothing to copy from.');
    return 0;
  }
  if (r.skipped === 'no-skills-dir') {
    console.error(`No .claude/skills in ${target} -- is that a checkout of this repo?`);
    return 0;
  }
  for (const name of r.names) console.log(`  copied    ${name}`);
  console.log(
    `
Copied ${r.copied} credential file(s) into ${target}.${
      r.kept ? ` Left ${r.kept} already present untouched.` : ''
    }
`
  );
  return r.copied;
}

export function cmdSkillEnv(projectRoot, argv) {
  const rows = survey(projectRoot);

  if (argv.includes('--backup')) return backup(projectRoot, rows);
  if (argv.includes('--restore')) return restore(projectRoot, rows);

  const target = argv.find((a) => !a.startsWith('--'));
  if (target) {
    // `{ path, derived }`, not a string. When git could not answer, `path` is just the caller's
    // own directory — syncing from that into a worktree would copy nothing and report success,
    // so say which tree is being treated as the source rather than implying one.
    const primary = resolvePrimaryCheckout(projectRoot);
    if (!primary.derived) {
      console.log(`\nCould not ask git for the primary checkout${
        primary.error ? ` (${primary.error.split('\n')[0]})` : ''
      }.\n  Copying from ${primary.path} instead.`);
    }
    return sync(primary.path, resolve(target));
  }

  return report(projectRoot, rows);
}
