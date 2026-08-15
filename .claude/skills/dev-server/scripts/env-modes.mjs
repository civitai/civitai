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
];

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
      errors.push(`line ${i + 1}: expected [group.mode] or KEY=VALUE, got "${trimmed}"`);
      current = null;
      return;
    }
    if (!current) {
      errors.push(`line ${i + 1}: "${kv[1].trim()}" is outside any [group.mode] section`);
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
export function sameResolvedModes(a = {}, b = {}) {
  const norm = (modes) =>
    Object.entries(modes)
      .map(([group, choice]) => `${group}=${choice.mode ?? choice}`)
      .sort()
      .join(' ');
  return norm(a) === norm(b);
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
        `Always production, no dev target: ${PROD_ONLY_GROUPS.join(', ')}.`
    );
  }
  if ((prod.includes('all') || dev.includes('all')) && !defined.length) {
    throw new Error(
      `"all" matches no env groups — ${definitions.path} defines none. ` +
        `Copy env-modes.example to env-modes.local and fill it in.`
    );
  }

  // `all` means every group that HAS that mode. Taking `defined` wholesale would fail the whole
  // start over one group that only has a prod block.
  const expand = (list, mode) =>
    list.includes('all') ? defined.filter((g) => definitions.groups[g][mode]) : list;
  const explicitProd = new Set(expand(prod, 'prod'));
  const explicitDev = new Set(expand(dev, 'dev'));

  const unusedDefaults = defaultProdGroups.filter((g) => !defined.includes(g));
  if (unusedDefaults.length) {
    // Silent here would mean an operator who set DEVSERVER_PROD_GROUPS=buzzz to route around a
    // broken dev service keeps hitting the dev service, with nothing anywhere saying why.
    notes.push(
      `DEVSERVER_PROD_GROUPS names ${unusedDefaults.join(', ')}, which no [group.mode] section ` +
        `defines — ignored. Defined: ${known}.`
    );
  }

  const conflict = [...explicitProd].filter((g) => explicitDev.has(g));
  if (conflict.length) {
    throw new Error(`Group(s) asked for both --dev and --prod: ${conflict.join(', ')}`);
  }

  for (const group of defined) {
    const available = definitions.groups[group];
    let mode;
    if (explicitProd.has(group)) mode = 'prod';
    else if (explicitDev.has(group)) mode = 'dev';
    else if (defaultProdGroups.includes(group)) mode = 'prod';
    else mode = 'dev';

    if (!available[mode]) {
      // Only worth failing when someone asked for this by name. An absent [x.dev] under the
      // default would otherwise make the daemon unstartable for a group nobody mentioned.
      if (explicitProd.has(group) || explicitDev.has(group)) {
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
        explicitProd.has(group) || explicitDev.has(group)
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
    : '(no groups defined)';
  return `${pairs} | always prod (no dev target): ${PROD_ONLY_GROUPS.join(', ')}`;
}
