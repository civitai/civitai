// Per-service dev/prod selection for a dev-server session.
//
// Definitions live in `<skillDir>/env-modes.local`, which is gitignored because the values are
// connection strings with credentials in them. `env-modes.example` documents the format.
//
// A mode is an OVERLAY on top of whichever `.env` the session already chose — it never replaces
// that file. The base file still supplies every key, so a group with no definition changes nothing
// rather than dropping the keys it does not restate.

import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

export const MODES = ['dev', 'prod'];

// Services this repo talks to that have no dev counterpart at all: there is no dev orchestrator and
// no dev notifications database (confirmed by Justin, 2026-08-15), and the rest were never split.
// A session reports these alongside its modes so `mode: dev` is never read as "nothing here is
// production" — pressing Generate on a dev-mode server still submits a real job and spends real Buzz.
export const PROD_ONLY_GROUPS = [
  'orchestrator',
  'payments',
  's3',
  'clickhouse',
  'notifications',
  'feeds',
  'opensearch',
  // The auth hub is one process shared by every session and reads its own apps/auth/.env, so it
  // cannot follow a per-session mode. `db=prod` moves the app and not the login that mints the
  // token, and the two databases' user ids are unrelated rows.
  'auth-hub',
];

// Groups an overlay cannot move, whatever anyone writes in env-modes.local: the hub is a separate
// process reading its own .env, so `[auth-hub.dev]` would not change where the login goes — it
// would only repoint the app at a hub that is not there, and delete the warning while doing it.
// Defining one is refused rather than silently honoured.
const UNMOVABLE_GROUPS = ['auth-hub'];

// A group someone has actually defined is not prod-only any more, whatever this list says. Naming
// it in both halves of the same summary line would make the line unreadable rather than cautious.
function prodOnlyExcluding(definedGroups) {
  return PROD_ONLY_GROUPS.filter((g) => UNMOVABLE_GROUPS.includes(g) || !definedGroups.includes(g));
}

function stripQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export function parseModeDefinitions(content) {
  const groups = {};
  const errors = [];
  let current = null;

  content.split('\n').forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;

    const section = trimmed.match(/^\[([^\].]+)\.([^\]]+)\]$/);
    if (section) {
      const [, group, mode] = section;
      if (!MODES.includes(mode)) {
        errors.push(`line ${i + 1}: unknown mode "${mode}" (expected ${MODES.join(' or ')})`);
        current = null;
        return;
      }
      groups[group] ??= {};
      groups[group][mode] ??= {};
      current = groups[group][mode];
      return;
    }

    const kv = trimmed.match(/^([^=]+)=(.*)$/);
    if (!kv) {
      // Closing the open section matters more than the message. `[db prod]` misses the section
      // regex, and leaving the previous section open would file every following key under it —
      // a one-character typo putting the production DATABASE_URL under [db.dev].
      errors.push(`line ${i + 1}: expected [group.mode] or KEY=VALUE`);
      current = null;
      return;
    }
    if (!current) {
      // No echo of the line: these errors reach an HTTP 400 body and a log buffer any agent can
      // read, and a stray connection-string line splits on its first `=` with the password on the
      // left of it.
      errors.push(`line ${i + 1}: assignment outside any [group.mode] section`);
      return;
    }
    current[kv[1].trim()] = stripQuotes(kv[2].trim());
  });

  return { groups, errors };
}

export function loadModeDefinitions(skillDir) {
  const path = resolve(skillDir, 'env-modes.local');
  if (!existsSync(path)) return { path, exists: false, groups: {}, errors: [] };
  const { groups, errors } = parseModeDefinitions(readFileSync(path, 'utf-8'));
  for (const group of Object.keys(groups)) {
    if (!UNMOVABLE_GROUPS.includes(group)) continue;
    delete groups[group];
    errors.push(
      `[${group}.*] cannot be an env group — ${group} is a separate process with its own .env, ` +
        `and an overlay here would only repoint the app at a service that is not there`
    );
  }
  return { path, exists: true, groups, errors };
}

export function parseGroupList(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean);
}

// Compared as RESOLVED modes rather than as flag text: `--prod all` and `--prod <every group>` are
// the same session, and a bare start is not the same session it was before someone edited
// DEVSERVER_PROD_GROUPS.
//
// Asymmetric on purpose. `running` is the session that exists; `requested` is what the caller asked
// for. A group the request knows about and the session does not is an ADDED section — harmless, or
// `start` would stop being idempotent for every live worktree the moment someone edits
// env-modes.local. A group the SESSION has and the request lost is the dangerous direction: it means
// the definitions file went missing or that section was removed, and the request resolved to
// nothing while the session runs on production. Matching an empty request against anything is the
// fail-open half of "compare the overlap", so it is not allowed.
// `required` is the groups the caller named on a flag. Leniency about a group the session has never
// heard of is only defensible when nobody asked for it: `--dev search` against a session that
// predates [search.*] must NOT come back as the same session, or the caller is told search is on dev
// while it runs on the base .env — production.
export function sameResolvedModes(running = {}, requested = {}, required = []) {
  const modeOf = (choice) => choice?.mode ?? choice;
  // A session that resolved NOTHING came up before env-modes.local existed and is running the base
  // .env — production for everything it does not override. `every` over no keys is vacuously true,
  // so without this the first bare start after the file appears would be told its dev modes hold.
  if (!Object.keys(running).length) return !Object.keys(requested).length;
  const named = required.filter((g) => g !== 'all');
  if (!named.every((group) => group in running)) return false;
  return Object.keys(running).every(
    (group) => group in requested && modeOf(running[group]) === modeOf(requested[group])
  );
}

// Resolve one session's modes. Every defined group defaults to dev; the skill's own .env can move
// a group's default to prod (DEVSERVER_PROD_GROUPS), and a per-start override beats both. The
// override is the request's alone — nothing here reads a previous session's choice, which is what
// keeps a prod start from leaking into the next bare start.
export function resolveSessionModes({ definitions, prod = [], dev = [], defaultProdGroups = [] }) {
  const defined = Object.keys(definitions.groups).sort();
  const modes = {};
  const notes = [];

  // Names are checked BEFORE `all` expands, or `--prod all,typo` would replace the set with every
  // defined group and the typo would never be looked at. `all` with nothing defined is the same
  // mistake wearing a different name: it would resolve to "no groups" and report success.
  const named = [...prod, ...dev].filter((g) => g !== 'all');
  const unknown = named.filter((g) => !defined.includes(g));
  const known = defined.length ? defined.join(', ') : '(none — env-modes.local is missing)';
  if (unknown.length) {
    throw new Error(
      `Unknown env group(s): ${unknown.join(', ')}. Defined in ${definitions.path}: ${known}. ` +
        `Always production, no dev target: ${prodOnlyExcluding(defined).join(', ')}.`
    );
  }
  if ((prod.includes('all') || dev.includes('all')) && !defined.length) {
    throw new Error(
      `"all" matches no env groups — ${definitions.path} defines none. ` +
        `Copy env-modes.example to env-modes.local and fill it in.`
    );
  }

  const namedProd = prod.filter((g) => g !== 'all');
  const namedDev = dev.filter((g) => g !== 'all');

  if (prod.includes('all') && dev.includes('all')) {
    throw new Error('--prod all and --dev all ask for opposite things');
  }

  const conflict = namedProd.filter((g) => namedDev.includes(g));
  if (conflict.length) {
    throw new Error(`Group(s) asked for both --dev and --prod: ${conflict.join(', ')}`);
  }

  // `all` covers every group that HAS that mode and was not named on the other flag, so
  // `--prod all --dev search` reads as "everything on prod except search" rather than a conflict.
  // Taking `defined` wholesale would instead fail the whole start over one group that only has a
  // dev block.
  const expand = (list, named, other, mode) =>
    list.includes('all')
      ? [...named, ...defined.filter((g) => definitions.groups[g][mode] && !other.includes(g))]
      : named;
  const explicitProd = new Set(expand(prod, namedProd, namedDev, 'prod'));
  const explicitDev = new Set(expand(dev, namedDev, namedProd, 'dev'));

  for (const [list, other, mode, chosen] of [
    [prod, namedDev, 'prod', explicitProd],
    [dev, namedProd, 'dev', explicitDev],
  ]) {
    if (!list.includes('all')) continue;
    // Every other unhonourable request here throws or leaves a note. A group `all` could not take
    // because it has no section for that mode should not be the one silent case — that is how you
    // add [search.dev], forget [search.prod], and read `--prod all` as having moved search.
    const skipped = defined.filter(
      (g) => !chosen.has(g) && !other.includes(g) && !definitions.groups[g][mode]
    );
    if (!skipped.length) continue;
    if (mode === 'dev') {
      // Skipping is only survivable in the prod direction, where the group stays on dev. A group
      // `--dev all` cannot move stays on the .env, which is production — so the request that was
      // asking for safety would be the one that quietly failed to deliver it.
      throw new Error(
        `--dev all cannot move ${skipped.join(', ')} — no [<group>.dev] section in ` +
          `${definitions.path}. Add one, or name the groups you do mean.`
      );
    }
    notes.push(`"all" skipped ${skipped.join(', ')} — no [<group>.${mode}] section defined`);
  }

  // A group named alongside `all` still has to be honoured by name — `--prod all,db` where db has
  // no prod block is a request that cannot be met, not one to drop on the floor.
  const namedByFlag = new Set([...namedProd, ...namedDev]);

  const unusedDefaults = defaultProdGroups.filter((g) => !defined.includes(g));
  if (unusedDefaults.length) {
    // Silent here would mean an operator who set DEVSERVER_PROD_GROUPS=buzzz to route around a
    // broken dev service keeps hitting the dev service, with nothing anywhere saying why.
    notes.push(
      `DEVSERVER_PROD_GROUPS names ${unusedDefaults.join(', ')}, which no [group.mode] section ` +
        `defines — ignored. Defined: ${known}.`
    );
  }

  for (const group of defined) {
    const available = definitions.groups[group];
    let mode;
    if (explicitProd.has(group)) mode = 'prod';
    else if (explicitDev.has(group)) mode = 'dev';
    else if (namedProd.includes(group)) mode = 'prod';
    else if (namedDev.includes(group)) mode = 'dev';
    else if (defaultProdGroups.includes(group)) mode = 'prod';
    else mode = 'dev';

    if (!available[mode]) {
      // Only worth failing when someone asked for this by name. An absent [x.dev] under the
      // default would otherwise make the daemon unstartable for a group nobody mentioned.
      if (namedByFlag.has(group)) {
        throw new Error(
          `No [${group}.${mode}] section in ${definitions.path} — ${group} has only: ` +
            Object.keys(available).join(', ')
        );
      }
      modes[group] = { mode: 'base', reason: `no [${group}.${mode}] definition` };
      notes.push(`${group}: left at the .env value — no [${group}.${mode}] definition`);
      continue;
    }

    modes[group] = {
      mode,
      source:
        explicitProd.has(group) || explicitDev.has(group) || namedByFlag.has(group)
          ? 'flag'
          : defaultProdGroups.includes(group)
          ? 'skill-default'
          : 'default',
    };
  }

  return { modes, notes };
}

export function applyModes(envVars, definitions, modes) {
  const applied = [];
  for (const [group, choice] of Object.entries(modes)) {
    if (choice.mode === 'base') continue;
    const values = definitions.groups[group]?.[choice.mode];
    if (!values) continue;
    Object.assign(envVars, values);
    applied.push({ group, mode: choice.mode, keys: Object.keys(values) });
  }
  return { envVars, applied };
}

// One line an agent can read off `status`, `list` or the log and know what the session is pointed
// at. The always-prod tail is not decoration: it is the part that stops "dev" being read as "safe".
export function formatModeSummary(modes) {
  const entries = Object.entries(modes);
  const pairs = entries.length
    ? entries.map(([group, choice]) => `${group}=${choice.mode}`).join(' ')
    : '(no groups defined — no overlay applied, the .env stands as written)';
  // Only a group that actually MOVED leaves the warning list. `base` means no section applied and
  // the .env value stands, which for a prod-only service is the production one — dropping it there
  // would under-report precisely when a definition is half-written.
  const stillProd = prodOnlyExcluding(
    entries.filter(([, choice]) => choice.mode !== 'base').map(([group]) => group)
  );
  return `${pairs} | always prod (no dev target): ${stillProd.join(', ')}`;
}
