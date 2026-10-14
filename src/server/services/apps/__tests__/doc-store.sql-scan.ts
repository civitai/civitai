// The isolation shape every `appdata` statement must have, as a pure function so
// the static scan, the runtime recorder and the scanner's own controls share it.
//
// Rule: `$1` is the app id and `$2` the namespace. Every reference to an appdata
// table is aliased, and the statement carries `<alias>.app_id = $1` and
// `<alias>.ns = $2` for that alias; an INSERT lists `app_id, ns` first and
// writes `$1, $2` into them. A reference to an unknown appdata relation, or one
// that is not in a FROM / JOIN / UPDATE / INTO position, is itself a violation.

export const APPDATA_TABLES = [
  'doc',
  'doc_index',
  'doc_tally',
  'doc_mark',
  'doc_tomb',
  'usage_app',
  'usage_user',
] as const;

/** `appdata.app_id` / `appdata.ns` are the RLS setting names, not relations. */
const SETTING_NAMES = new Set(['app_id', 'ns']);

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
    if (!new RegExp(`\\b${a}\\.app_id\\s*=\\s*\\$1(?![0-9])`).test(sql)) {
      violations.push(`appdata.${table} ${alias} lacks ${alias}.app_id = $1`);
    }
    if (!new RegExp(`\\b${a}\\.ns\\s*=\\s*\\$2(?![0-9])`).test(sql)) {
      violations.push(`appdata.${table} ${alias} lacks ${alias}.ns = $2`);
    }
  }
  return violations;
}
