/**
 * Scope check for the `query_database` support tool.
 *
 * `query_database` is the one tool whose SQL is written by the model rather
 * than by us, so the tool — not the SQL text — has to carry two bounds:
 *
 *   1. WHICH relations the statement may read (this file), and
 *   2. how long it may hold a pooled connection — enforced server-side by
 *      `queryWithTimeout`'s `SET LOCAL statement_timeout` inside a
 *      `BEGIN READ ONLY` transaction (see `freshdesk-tools.ts`).
 *
 * The check below is deliberately CONSERVATIVE: it confirms a statement is
 * built only out of shapes it fully understands, and rejects everything else
 * with an actionable message. It is not a SQL parser and does not try to be
 * one — a check that pattern-matches its way to a "looks fine" verdict on a
 * shape it cannot actually read would be worse than no check at all. Known
 * false rejections are listed in `checkQueryScope`'s docblock; each one has a
 * documented rewrite the model can apply.
 */

/**
 * Relations `query_database` may read.
 *
 * Derived, not guessed: this is every relation referenced by the `Prisma.sql`
 * queries in `freshdesk-investigation-tools.ts` (the agent's purpose-built
 * lookups), plus `"User"` for the email lookup that `freshdesk-prompts.ts`
 * spells out inline. `query_database` is documented in those prompts as the
 * fallback for the same investigations, so that is its working set.
 *
 * These are physical Postgres relation names. All 26 are plain `model`s in
 * `prisma/schema.prisma` — none is a view and none carries an `@@map`, so the
 * Prisma name IS the table name. Matching is case-SENSITIVE and requires
 * double quotes, because that is how Postgres itself distinguishes `"User"`
 * from the folded `user`.
 *
 * `buzzTransactions` is deliberately absent: it lives in ClickHouse, which
 * `query_database` does not reach.
 */
export const FRESHDESK_QUERY_TABLES = [
  'BuzzWithdrawalRequest',
  'Challenge',
  'ChallengeWinner',
  'Changelog',
  'Cosmetic',
  'CryptoDeposit',
  'CryptoWallet',
  'CustomerSubscription',
  'Image',
  'ImageReport',
  'Model',
  'ModelReport',
  'Post',
  'PostReport',
  'Price',
  'Product',
  'Purchase',
  'Report',
  'User',
  'UserCosmetic',
  'UserCosmeticShopPurchases',
  'UserProfile',
  'UserReport',
  'UserRestriction',
  'UserStat',
  'UserStrike',
] as const;

const ALLOWED_TABLES: ReadonlySet<string> = new Set(FRESHDESK_QUERY_TABLES);

/** Rendered into rejection messages so the model can retarget without guessing. */
const TABLE_LIST = FRESHDESK_QUERY_TABLES.map((t) => `"${t}"`).join(', ');

/** Keywords that introduce a relation reference in a `FROM` list. */
const RELATION_KEYWORDS: ReadonlySet<string> = new Set(['from', 'join']);

/**
 * Keywords that end a `FROM` list at its own paren depth. `on` and `using` are
 * intentionally NOT here: `FROM a JOIN b ON a.id = b.id, c` is valid, so the
 * comma after an `ON` clause still has to be read as a new relation position.
 */
const FROM_LIST_TERMINATORS: ReadonlySet<string> = new Set([
  'where',
  'group',
  'having',
  'order',
  'limit',
  'offset',
  'window',
  'union',
  'intersect',
  'except',
  'fetch',
  'for',
]);

/**
 * Statement verbs that have no place in a read. The `BEGIN READ ONLY`
 * transaction is the real backstop for all of these; rejecting them here just
 * turns a Postgres error into a message the model can act on. Reserved words
 * in Postgres cannot appear as bare identifiers, so this cannot collide with a
 * column or alias in a well-formed statement.
 */
const NON_READ_KEYWORDS: ReadonlySet<string> = new Set([
  'insert',
  'update',
  'delete',
  'drop',
  'alter',
  'truncate',
  'create',
  'grant',
  'revoke',
  'copy',
  'into',
  'call',
  'vacuum',
  'reindex',
  'refresh',
  'listen',
  'notify',
  'lock',
  'begin',
  'commit',
  'rollback',
  'savepoint',
]);

type Token =
  | { kind: 'ident'; value: string } // bare identifier/keyword, folded to lower case
  | { kind: 'quoted'; value: string } // double-quoted identifier, quotes removed
  | { kind: 'literal' } // single-quoted string; contents intentionally discarded
  | { kind: 'punct'; value: string };

type TokenizeResult = { ok: true; tokens: Token[] } | { ok: false; error: string };

const IDENT_START = /[A-Za-z_]/;
const IDENT_CHAR = /[A-Za-z0-9_]/;
/** A quote directly after one of these is a prefixed literal (E'', U&'', B'', X'', U&""). */
const QUOTE_PREFIX_CHAR = /[A-Za-z0-9_&]/;

function reject(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

/**
 * Split the statement into the four token shapes this check understands.
 *
 * Everything that would let a relation reference hide from a structural read —
 * comments, prefixed/escaped string forms, dollar quoting, backslashes, a
 * second statement after a semicolon — is refused here rather than stripped,
 * so no later stage has to reason about text it cannot see.
 */
function tokenize(sql: string): TokenizeResult {
  const tokens: Token[] = [];
  const n = sql.length;
  let i = 0;

  while (i < n) {
    const c = sql[i];

    if (/\s/.test(c)) {
      i++;
      continue;
    }

    if (c === '-' && sql[i + 1] === '-') {
      return reject('Error: SQL comments are not supported by query_database. Remove them.');
    }
    if (c === '/' && sql[i + 1] === '*') {
      return reject('Error: SQL comments are not supported by query_database. Remove them.');
    }

    if (c === '"') {
      if (i > 0 && QUOTE_PREFIX_CHAR.test(sql[i - 1])) {
        return reject(
          'Error: prefixed identifier forms (e.g. U&"...") are not supported by query_database.'
        );
      }
      let j = i + 1;
      let value = '';
      for (;;) {
        if (j >= n) return reject('Error: unterminated quoted identifier in query.');
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') {
            value += '"';
            j += 2;
            continue;
          }
          j++;
          break;
        }
        value += sql[j];
        j++;
      }
      tokens.push({ kind: 'quoted', value });
      i = j;
      continue;
    }

    if (c === "'") {
      if (i > 0 && QUOTE_PREFIX_CHAR.test(sql[i - 1])) {
        return reject(
          "Error: prefixed string forms (e.g. E'...') are not supported by query_database. Use a plain '...' literal."
        );
      }
      let j = i + 1;
      for (;;) {
        if (j >= n) return reject('Error: unterminated string literal in query.');
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        j++;
      }
      tokens.push({ kind: 'literal' });
      i = j;
      continue;
    }

    if (IDENT_START.test(c)) {
      let j = i;
      while (j < n && IDENT_CHAR.test(sql[j])) j++;
      tokens.push({ kind: 'ident', value: sql.slice(i, j).toLowerCase() });
      i = j;
      continue;
    }

    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < n && /[0-9.]/.test(sql[j])) j++;
      // Numeric value is irrelevant to scope; record a placeholder so the
      // token stream stays positional.
      tokens.push({ kind: 'punct', value: '0' });
      i = j;
      continue;
    }

    if (c === '$') {
      return reject(
        'Error: $ (dollar quoting / bind parameters) is not supported by query_database. Inline plain literals.'
      );
    }
    if (c === '\\') {
      return reject('Error: backslashes are not supported by query_database.');
    }
    if (c === ';') {
      if (sql.slice(i + 1).trim() !== '') {
        return reject('Error: query_database runs exactly one statement. Remove the extra ";".');
      }
      i++;
      continue;
    }

    tokens.push({ kind: 'punct', value: c });
    i++;
  }

  return { ok: true, tokens };
}

export type QueryScopeResult = { ok: true } | { ok: false; error: string };

/**
 * Confirm every relation the statement reads is one `query_database` is
 * allowed to reach.
 *
 * What it DOES cover, because the walk is positional rather than textual:
 *   - relations behind `FROM` / any `JOIN` flavour, at any nesting depth
 *   - relations in a comma-separated `FROM` list, including a comma that
 *     follows a join's `ON` clause (tracked per paren depth, so an inner
 *     sub-select's `FROM` list cannot be confused with the outer one)
 *   - relations inside sub-selects in the target list, `WHERE`, `IN (...)`
 *   - the leading relation of a parenthesized join expression
 *     (`FROM ("A" JOIN "B" ON ...)`), which is a relation position and not a
 *     sub-select, at any nesting depth
 *   - each branch of a `UNION` / `INTERSECT` / `EXCEPT`
 *   - text hidden in comments or a second statement — refused outright
 *
 * What it does NOT do, and rejects rather than guesses at:
 *   - CTEs. `WITH` cannot lead (the caller's `SELECT` check already refuses
 *     that) and a nested CTE's name is a bare identifier in relation position,
 *     which is refused.
 *   - schema-qualified names (`"public"."User"`), `ONLY`, table functions, and
 *     any bare/unquoted relation name — including `information_schema` and the
 *     `pg_*` catalog. Relation position accepts a double-quoted identifier or
 *     an opening paren, nothing else.
 *   - `FROM` used as function-call syntax: `EXTRACT(EPOCH FROM col)`,
 *     `SUBSTRING(x FROM 1)`, `TRIM(BOTH ' ' FROM x)`. These read as a relation
 *     position and are rejected. Rewrite with `date_part(...)` / `substr(...)`
 *     / `btrim(...)`.
 *
 * What it deliberately does NOT bound at all:
 *   - columns and rows. Any column of an allowed table is readable, for every
 *     row. Narrowing the projection is the prompt's job, not this check's.
 *   - functions in the target list, which need no `FROM`. Bare `pg_*` and
 *     `information_schema` identifiers are refused anywhere in the statement,
 *     but that is a named-prefix refusal, not an allowlist — the read-only
 *     transaction and the statement timeout are what actually bound this case.
 */
export function checkQueryScope(sql: string): QueryScopeResult {
  const tokenized = tokenize(sql);
  if (!tokenized.ok) return tokenized;

  const { tokens } = tokenized;
  /** `fromListAtDepth[d]` — is a `FROM` list currently open at paren depth d? */
  const fromListAtDepth: boolean[] = [];
  let depth = 0;
  let expectRelation = false;

  for (const token of tokens) {
    if (token.kind === 'punct' && token.value === '(') {
      depth++;
      // A paren in relation position is EITHER a sub-query (`FROM (SELECT …)`,
      // `FROM (VALUES …)`) or a parenthesized joined_table
      // (`FROM ("A" JOIN "B" ON …)`), whose FIRST item is itself a relation.
      // Carry the expectation inward so that leading relation is still checked;
      // the `SELECT`/`VALUES` below is what marks the sub-query and clears it.
      // Clearing unconditionally here would let a joined_table's first relation
      // through unchecked.
      continue;
    }

    if (token.kind === 'punct' && token.value === ')') {
      fromListAtDepth[depth] = false;
      depth = Math.max(0, depth - 1);
      expectRelation = false;
      continue;
    }

    if (expectRelation) {
      // `SELECT`/`VALUES` in relation position mean a sub-query rather than a
      // joined_table, so they resolve the expectation instead of failing it.
      // Both are reserved words in Postgres and so cannot be a bare relation
      // name; any relation *inside* the sub-query is still walked by this loop.
      if (token.kind === 'ident' && (token.value === 'select' || token.value === 'values')) {
        expectRelation = false;
        continue;
      }
      if (token.kind === 'quoted') {
        if (!ALLOWED_TABLES.has(token.value)) {
          return reject(
            `Error: query_database cannot read "${token.value}". It is limited to these tables: ${TABLE_LIST}.`
          );
        }
        expectRelation = false;
        continue;
      }
      // `LATERAL` sits between the keyword and the relation itself.
      if (token.kind === 'ident' && token.value === 'lateral') continue;
      const shown = token.kind === 'ident' ? token.value : 'the value here';
      return reject(
        `Error: query_database expected a double-quoted table name after FROM/JOIN and got ${shown}. Reference tables directly by their quoted name — CTEs, schema prefixes, table functions, and FROM-inside-a-function-call (EXTRACT/SUBSTRING/TRIM) are not supported. Allowed tables: ${TABLE_LIST}.`
      );
    }

    if (token.kind === 'ident') {
      if (token.value.startsWith('pg_') || token.value === 'information_schema') {
        return reject(
          `Error: query_database reads application tables only. Allowed tables: ${TABLE_LIST}.`
        );
      }
      if (RELATION_KEYWORDS.has(token.value)) {
        expectRelation = true;
        if (token.value === 'from') fromListAtDepth[depth] = true;
        continue;
      }
      if (NON_READ_KEYWORDS.has(token.value)) {
        return reject(
          `Error: query_database runs read-only SELECT statements. "${token.value.toUpperCase()}" is not available.`
        );
      }
      if (fromListAtDepth[depth] && FROM_LIST_TERMINATORS.has(token.value)) {
        fromListAtDepth[depth] = false;
      }
      continue;
    }

    if (token.kind === 'punct' && token.value === ',' && fromListAtDepth[depth]) {
      expectRelation = true;
      continue;
    }
  }

  if (expectRelation) {
    return reject('Error: query is incomplete — a table name was expected after FROM/JOIN.');
  }

  return { ok: true };
}
