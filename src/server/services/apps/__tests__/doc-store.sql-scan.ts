// The isolation shape every `appdata` statement must have, as a pure function so
// the static scan, the runtime recorder and the scanner's own controls share it.
//
// Rule: `$1` is the app id and `$2` the namespace. Every reference to an appdata
// table is aliased, and the statement carries `<alias>.app_id = $1` and
// `<alias>.ns = $2` for that alias; an INSERT lists `app_id, ns` first and
// writes `$1, $2` into them. A reference to an unknown appdata relation, or one
// that is not in a FROM / JOIN / UPDATE / INTO position, is itself a violation.
//
// Two exceptions. REVIEW MAINTENANCE: a SELECT or DELETE whose every alias carries
// `<alias>.ns LIKE 'rev:%'` in place of `ns = $2`. It must still carry `app_id = $1`,
// except a SELECT reading `usage_app` / `doc` (the sweep's listing). Such a statement only
// works inside the store's maintenance transaction (RLS admits nothing else);
// `isReviewMaintenanceStatement` names them so the isolation test can pin where they live.
// ACCOUNT-WIPE ENUMERATION: a SELECT on `usage_user` / `doc_mark` only, whose every alias
// carries `<alias>.user_id = $1::int` in place of the app and namespace predicates. It only
// works inside the store's account-wipe transaction; `isAccountWipeStatement` names it.

export const APPDATA_TABLES = [
  'doc',
  'doc_index',
  'doc_tally',
  'doc_mark',
  'doc_tomb',
  'usage_app',
  'usage_user',
] as const;

/** The RLS settings (`appdata.<name>`), which are not relations. */
const SETTING_NAMES = new Set(['app_id', 'ns', 'review_maintenance', 'account_wipe_uid']);

/** The two tables that record which namespaces a user has rows in. */
const ACCOUNT_WIPE_TABLES = new Set(['usage_user', 'doc_mark']);

const NOT_AN_ALIAS = new Set([
  'where',
  'set',
  'on',
  'using',
  'join',
  'left',
  'inner',
  'values',
  'select',
  'returning',
  'order',
  'group',
  'limit',
  'for',
  'as',
]);

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function scanStatement(sql: string): string[] {
  const violations: string[] = [];
  // Spellings that would reach the tables without matching the patterns below.
  if (/"appdata"|appdata\s*\.\s*"/i.test(sql)) violations.push('quoted appdata identifier');
  if (/search_path/i.test(sql)) violations.push('search_path change');
  if (
    /\bappdata\b/i.test(
      sql
        .replace(/appdata\.(?:[a-z_]+)/g, '')
        .replace(/'appdata\.(?:app_id|ns|review_maintenance|account_wipe_uid)'/g, '')
    )
  ) {
    violations.push('appdata referenced in a non-canonical spelling');
  }
  if (/--|\/\*/.test(sql)) violations.push('comment inside an appdata statement');
  const all = [...sql.matchAll(/appdata\.([a-z_]+)/g)].filter((m) => !SETTING_NAMES.has(m[1]));
  const refs = [
    ...sql.matchAll(
      /\b(FROM|JOIN|UPDATE|INTO)\s+appdata\.([a-z_]+)\b(?:\s+AS)?(?:\s+([A-Za-z_][A-Za-z0-9_]*))?/gi
    ),
  ];
  if (all.length !== refs.length) {
    violations.push(
      `appdata referenced ${all.length} time(s) but only ${refs.length} in a FROM/JOIN/UPDATE/INTO position`
    );
  }
  for (const m of refs) {
    const keyword = m[1].toUpperCase();
    const table = m[2];
    const alias = m[3] && !NOT_AN_ALIAS.has(m[3].toLowerCase()) ? m[3] : null;
    if (!(APPDATA_TABLES as readonly string[]).includes(table)) {
      violations.push(`unknown appdata relation ${table}`);
      continue;
    }
    if (keyword === 'INTO') {
      const rest = sql.slice((m.index ?? 0) + m[0].length);
      if (!/^\s*\(\s*app_id\s*,\s*ns\s*,/.test(rest)) {
        violations.push(`INSERT into ${table} does not list app_id, ns first`);
      }
      if (!/(VALUES\s*\(\s*\$1\s*,\s*\$2\s*,|SELECT\s+\$1\s*,\s*\$2\s*,)/.test(rest)) {
        violations.push(`INSERT into ${table} does not write $1, $2 into app_id, ns`);
      }
      continue;
    }
    if (!alias) {
      violations.push(`${keyword} appdata.${table} has no alias`);
      continue;
    }
    const a = escape(alias);
    if (new RegExp(`\\b${a}\\.ns\\s+LIKE\\s+'rev:%'`).test(sql)) {
      // Review maintenance: read or delete only, and keyed on the request unless it is the
      // usage_app-only listing.
      if (!/^\s*(WITH\s+gone\s+AS\s+\(\s*DELETE|SELECT)\b/i.test(sql)) {
        violations.push(`maintenance statement on appdata.${table} is not a SELECT or DELETE`);
      }
      const listing = /^\s*SELECT\b/i.test(sql) && (table === 'usage_app' || table === 'doc');
      if (!listing && !new RegExp(`\\b${a}\\.app_id\\s*=\\s*\\$1(?![0-9])`).test(sql)) {
        violations.push(`appdata.${table} ${alias} lacks ${alias}.app_id = $1`);
      }
      continue;
    }
    if (new RegExp(`\\b${a}\\.user_id\\s*=\\s*\\$1::int\\b`).test(sql)) {
      // Account-wipe enumeration: read only, and only the two per-user tables.
      if (!/^\s*SELECT\b/i.test(sql)) {
        violations.push(`account-wipe statement on appdata.${table} is not a SELECT`);
      }
      if (!ACCOUNT_WIPE_TABLES.has(table)) {
        violations.push(`account-wipe statement reads appdata.${table}`);
      }
      continue;
    }
    if (!new RegExp(`\\b${a}\\.app_id\\s*=\\s*\\$1(?![0-9])`).test(sql)) {
      violations.push(`appdata.${table} ${alias} lacks ${alias}.app_id = $1`);
    }
    if (!new RegExp(`\\b${a}\\.ns\\s*=\\s*\\$2(?![0-9])`).test(sql)) {
      violations.push(`appdata.${table} ${alias} lacks ${alias}.ns = $2`);
    }
  }
  return violations;
}

/** A statement written in the review-maintenance shape (`ns LIKE 'rev:%'`). */
export function isReviewMaintenanceStatement(sql: string): boolean {
  return /\.ns\s+LIKE\s+'rev:%'/.test(sql);
}

/** A statement written in the account-wipe enumeration shape (`user_id = $1::int`). */
export function isAccountWipeStatement(sql: string): boolean {
  return /\.user_id\s*=\s*\$1::int\b/.test(sql);
}
