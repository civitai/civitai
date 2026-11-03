/**
 * Which tables does a migration touch?
 *
 * Feeds `drift --migration <file>`: a drift check scoped to the tables one migration changes, so
 * the person who just applied it reads a report about THAT change instead of the whole backlog.
 *
 * Pure: a string in, a classification out. No I/O, no database.
 *
 * THE ONE RULE THIS FILE KEEPS. A statement it cannot read is never quietly skipped and never
 * guessed at. It is returned in `unparsed`, with the reason, and the CLI refuses to run until a
 * human has acknowledged it (`--allow-unparsed`, optionally with `--tables` naming what it
 * touches). The failure being designed against is a scoped check that reports CLEAN because the
 * one statement that broke something was a `DO` block the parser silently ignored: that is a
 * comparison that visited the wrong thing, printing the same reassuring page as a correct one.
 *
 * So the vocabulary is closed. Every statement lands in exactly one of three buckets:
 *
 *   tables     a structural or data statement whose target tables can be read from its text —
 *              CREATE / ALTER / DROP TABLE, CREATE INDEX ... ON, REFERENCES targets, RENAME TO
 *              (both names), COMMENT ON, INSERT / UPDATE / DELETE / TRUNCATE.
 *   ignored    a statement that touches no table's shape at all — transaction control, SET,
 *              enum types, sequences, extensions, grants, ANALYZE. Listed so a reader can see
 *              they were looked at, not overlooked.
 *   unparsed   everything else: procedural code (DO, functions, triggers), views and rules, a
 *              statement naming an index rather than its table (DROP INDEX, ALTER INDEX), any
 *              CASCADE (which reaches tables the statement does not name), and anything not
 *              recognised at all.
 *
 * Identifier rules follow Postgres, because the catalog the result is compared against does:
 * a double-quoted name is exact (`"Image"` is `Image`), an unquoted one folds to lower case
 * (`ALTER TABLE Image` targets `image`, which is what Postgres would do with it too), and a
 * qualifier naming the schema being compared is dropped (`"public"."Image"` is `Image`).
 * A qualifier naming ANY OTHER schema makes the statement `unparsed`: the drift tool reads one
 * Postgres schema per run, so `label_store.subject` is not the `subject` it would compare, and
 * reading it as the bare name would put a stranger's table into the scope. An UNQUALIFIED name
 * is assumed to resolve to the compared schema; a migration that changes `search_path` first
 * defeats that, and the README lists it as a limitation.
 */

/** One top-level SQL statement, with comments removed and literals blanked. */
export interface SqlStatement {
  /** 1-based position among the file's statements, for messages. */
  index: number;
  /** 1-based line the statement starts on. */
  line: number;
  /**
   * The statement for classification: comments removed, string literals replaced by `''`, and
   * dollar-quoted bodies replaced by `$$ $$`. Text inside a literal can therefore never be read
   * as a keyword — `RAISE EXCEPTION 'see REFERENCES "X"'` mentions no table.
   */
  text: string;
  /**
   * The statement for hints: comments removed but literals and dollar bodies KEPT. Only ever
   * used to suggest which tables an unparsed statement mentions; never to decide scope.
   */
  raw: string;
}

export type TableAction = 'present' | 'absent';

/** A table one statement touches, and what the statement leaves it as. */
export interface TouchedTable {
  table: string;
  /**
   * `absent` for a DROP TABLE target and the OLD name of a RENAME TO — after the migration the
   * table should not exist. Everything else is `present`.
   */
  action: TableAction;
  /** Short label of the statement kind (`CREATE TABLE`, `REFERENCES`, ...), for the report. */
  via: string;
  statement: number;
}

export interface UnparsedStatement {
  statement: number;
  line: number;
  /** First line of the statement, trimmed, for the message. */
  head: string;
  /** Why it could not be classified. */
  reason: string;
  /**
   * Double-quoted identifiers the statement's full text mentions. A HINT for choosing
   * `--tables`, never added to the scope automatically: a quoted name inside a function body
   * might be a column, a table, or neither.
   */
  mentions: string[];
}

export interface IgnoredStatement {
  statement: number;
  line: number;
  head: string;
  kind: string;
}

export interface MigrationTables {
  statements: number;
  touched: TouchedTable[];
  ignored: IgnoredStatement[];
  unparsed: UnparsedStatement[];
}

// ---------------------------------------------------------------------------
// Splitting
// ---------------------------------------------------------------------------

const IDENT_CHAR = /[A-Za-z0-9_$]/;

/**
 * Split SQL into top-level statements on `;`.
 *
 * A `;` inside a string, a quoted identifier, a comment or a dollar-quoted body does not end a
 * statement — every real migration with a function in it has semicolons inside `$$ ... $$`.
 * Block comments nest, as they do in Postgres.
 */
export function splitSqlStatements(sql: string): SqlStatement[] {
  const out: SqlStatement[] = [];
  let text = '';
  let raw = '';
  let line = 1;
  let startLine = 1;
  let started = false;
  let i = 0;

  const flush = () => {
    if (text.trim().length > 0) {
      out.push({
        index: out.length + 1,
        line: startLine,
        text: text.replace(/\s+/g, ' ').trim(),
        raw: raw.trim(),
      });
    }
    text = '';
    raw = '';
    started = false;
  };
  const mark = () => {
    if (!started) {
      started = true;
      startLine = line;
    }
  };

  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];

    if (c === '\n') {
      line += 1;
      text += c;
      raw += c;
      i += 1;
      continue;
    }

    // Line comment.
    if (c === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') i += 1;
      text += ' ';
      raw += ' ';
      continue;
    }

    // Block comment, nesting.
    if (c === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === '\n') line += 1;
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth += 1;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth -= 1;
          i += 2;
        } else {
          i += 1;
        }
      }
      text += ' ';
      raw += ' ';
      continue;
    }

    if (c === ';') {
      flush();
      i += 1;
      continue;
    }

    if (/\s/.test(c)) {
      text += c;
      raw += c;
      i += 1;
      continue;
    }

    mark();

    // String literal. `E'...'` honours backslash escapes; a standard string only `''`.
    if (c === "'") {
      const prev = sql[i - 1];
      const escapes = (prev === 'E' || prev === 'e') && !IDENT_CHAR.test(sql[i - 2] ?? ' ');
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === '\n') line += 1;
        if (escapes && sql[j] === '\\') {
          j += 2;
          continue;
        }
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      text += "''";
      raw += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }

    // Quoted identifier, `""` escaping a quote. Kept verbatim: it is what names tables.
    if (c === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') {
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      const ident = sql.slice(i, j + 1);
      text += ident;
      raw += ident;
      i = j + 1;
      continue;
    }

    // Dollar quote: `$$` or `$tag$`, not preceded by an identifier character (`a$b` is an
    // identifier) and not a positional parameter (`$1`).
    if (c === '$' && !IDENT_CHAR.test(sql[i - 1] ?? ' ')) {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length);
        const end = close === -1 ? sql.length : close + tag[0].length;
        const body = sql.slice(i, end);
        line += (body.match(/\n/g) ?? []).length;
        text += '$$ $$';
        raw += body;
        i = end;
        continue;
      }
    }

    text += c;
    raw += c;
    i += 1;
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

interface Token {
  /** Upper-cased for an unquoted word; `null` for a quoted identifier, which is never a keyword. */
  keyword: string | null;
  /** The identifier as Postgres resolves it: quoted -> exact, unquoted -> lower case. */
  ident: string | null;
  /** The token's text, for punctuation. */
  text: string;
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const re = /"((?:[^"]|"")*)"|([A-Za-z_][A-Za-z0-9_$]*)|(\S)/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (m[1] !== undefined) {
      tokens.push({ keyword: null, ident: m[1].replace(/""/g, '"'), text: m[0] });
    } else if (m[2] !== undefined) {
      tokens.push({ keyword: m[2].toUpperCase(), ident: m[2].toLowerCase(), text: m[0] });
    } else {
      tokens.push({ keyword: null, ident: null, text: m[0] });
    }
  }
  return tokens;
}

interface QualifiedName {
  name: string;
  /** The qualifier, if the name was written `schema.name`. */
  schema: string | null;
  end: number;
}

/** Read `name` or `schema.name` at `at`; return the bare name, its qualifier and the index after. */
function qualifiedName(tokens: Token[], at: number): QualifiedName | null {
  const first = tokens[at];
  if (!first?.ident) return null;
  if (tokens[at + 1]?.text === '.' && tokens[at + 2]?.ident) {
    return { name: tokens[at + 2].ident as string, schema: first.ident, end: at + 3 };
  }
  return { name: first.ident, schema: null, end: at + 1 };
}

type NameReader = (at: number) => QualifiedName | null;

/** All dotted parts of a name at `at`, for COMMENT ON COLUMN. */
function nameParts(tokens: Token[], at: number): string[] {
  const parts: string[] = [];
  let i = at;
  if (!tokens[i]?.ident) return parts;
  parts.push(tokens[i].ident as string);
  i += 1;
  while (tokens[i]?.text === '.' && tokens[i + 1]?.ident) {
    parts.push(tokens[i + 1].ident as string);
    i += 2;
  }
  return parts;
}

function kw(tokens: Token[], at: number): string | null {
  return tokens[at]?.keyword ?? null;
}

/** Skip any of `words` in sequence (e.g. `IF NOT EXISTS`) if they appear at `at`. */
function skip(tokens: Token[], at: number, ...words: string[]): number {
  let i = at;
  for (const w of words) {
    if (kw(tokens, i) !== w) return at;
    i += 1;
  }
  return i;
}

/** Index of the first unquoted keyword `word` at or after `from`, or -1. */
function find(tokens: Token[], word: string, from = 0): number {
  for (let i = from; i < tokens.length; i += 1) if (tokens[i].keyword === word) return i;
  return -1;
}

/** Every `REFERENCES <table>` target in the statement. */
function referencedTables(tokens: Token[], qn: NameReader): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i].keyword !== 'REFERENCES') continue;
    const name = qn(i + 1);
    if (name) out.push(name.name);
  }
  return out;
}

/** A comma-separated list of table names starting at `at` (DROP TABLE a, b / TRUNCATE a, b). */
function nameList(tokens: Token[], at: number, qn: NameReader): string[] {
  const out: string[] = [];
  let i = at;
  for (;;) {
    i = skip(tokens, i, 'ONLY');
    const name = qn(i);
    if (!name) break;
    out.push(name.name);
    i = name.end;
    if (tokens[i]?.text === '*') i += 1;
    if (tokens[i]?.text !== ',') break;
    i += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

type Classified =
  | { kind: 'tables'; touched: Omit<TouchedTable, 'statement'>[] }
  | { kind: 'ignored'; label: string }
  | { kind: 'unparsed'; reason: string };

const unparsed = (reason: string): Classified => ({ kind: 'unparsed', reason });
const ignored = (label: string): Classified => ({ kind: 'ignored', label });

/**
 * Statements that cannot change any table's columns, constraints or indexes. Deliberately a
 * short list: anything not on it and not understood below is `unparsed`.
 */
function ignorable(tokens: Token[]): string | null {
  const a = kw(tokens, 0);
  const b = kw(tokens, 1);
  switch (a) {
    case 'BEGIN':
    case 'COMMIT':
    case 'ROLLBACK':
    case 'START':
    case 'END':
    case 'SAVEPOINT':
    case 'RELEASE':
      return 'transaction control';
    case 'SET':
    case 'RESET':
      return 'session setting';
    case 'ANALYZE':
    case 'VACUUM':
      return 'statistics / maintenance';
    case 'LOCK':
      return 'explicit lock';
    case 'GRANT':
    case 'REVOKE':
      return 'privileges (not checked by the drift detector)';
    default:
      break;
  }
  if ((a === 'CREATE' || a === 'ALTER' || a === 'DROP') && (b === 'TYPE' || b === 'DOMAIN')) {
    return `${a} ${b} (enum and domain types are not checked by the drift detector)`;
  }
  if ((a === 'CREATE' || a === 'ALTER' || a === 'DROP') && b === 'SEQUENCE') {
    return `${a} SEQUENCE`;
  }
  if ((a === 'CREATE' || a === 'DROP') && b === 'EXTENSION') return `${a} EXTENSION`;
  return null;
}

/** Why a statement's procedural or programmability head makes it unreadable, if it does. */
function programmability(tokens: Token[]): string | null {
  const a = kw(tokens, 0);
  let i = 1;
  if (a === 'CREATE') i = skip(tokens, i, 'OR', 'REPLACE');
  const what = kw(tokens, i);
  const what2 = kw(tokens, i + 1);

  if (a === 'DO') {
    return 'DO block: procedural code can touch any table, and what it does cannot be read statically';
  }
  if (a === 'CALL' || a === 'SELECT' || a === 'WITH' || a === 'EXECUTE' || a === 'PERFORM') {
    return `${a} statement: it can run code that changes any table`;
  }
  if (a === 'REFRESH')
    return 'REFRESH MATERIALIZED VIEW: views are not checked by the drift detector';
  if (a === 'CREATE' || a === 'ALTER' || a === 'DROP') {
    if (what === 'FUNCTION' || what === 'PROCEDURE') {
      return `${a} ${what}: a function body can touch any table, and its effect cannot be read statically`;
    }
    if (what === 'TRIGGER' || (what === 'CONSTRAINT' && what2 === 'TRIGGER')) {
      return `${a} TRIGGER: triggers are programmability the drift detector does not check`;
    }
    if (what === 'EVENT' && what2 === 'TRIGGER') return `${a} EVENT TRIGGER`;
    if (what === 'VIEW' || what === 'RECURSIVE' || (what === 'MATERIALIZED' && what2 === 'VIEW')) {
      return `${a} VIEW: views are not checked by the drift detector`;
    }
    if (what === 'RULE')
      return `${a} RULE: rules are programmability the drift detector does not check`;
    if (what === 'POLICY')
      return `${a} POLICY: row-level security is not checked by the drift detector`;
    if (what === 'INDEX') {
      return a === 'CREATE'
        ? null
        : `${a} INDEX names an index, not its table, so the table it affects cannot be read from the statement`;
    }
  }
  return null;
}

function classify(statement: SqlStatement, dbSchema: string): Classified {
  const tokens = tokenize(statement.text);
  const a = kw(tokens, 0);
  // Every name read goes through here, so a qualifier naming another schema is seen wherever
  // it appears — the statement's own target, a REFERENCES target, a DROP list.
  const foreign = new Set<string>();
  const qn: NameReader = (at) => {
    const name = qualifiedName(tokens, at);
    if (name?.schema && name.schema !== dbSchema) foreign.add(name.schema);
    return name;
  };
  const result = classifyWith(tokens, a, qn, dbSchema);
  if (result.kind === 'tables' && foreign.size > 0) {
    return unparsed(
      `names a table in schema ${[...foreign].map((f) => `"${f}"`).join(', ')}, and this check ` +
        `compares schema "${dbSchema}" only`
    );
  }
  return result;
}

function classifyWith(
  tokens: Token[],
  a: string | null,
  qn: NameReader,
  dbSchema: string
): Classified {
  const prog = programmability(tokens);
  if (prog) return unparsed(prog);

  // A statement-level CASCADE drops or alters objects the statement does not name — a foreign
  // key on another table, a view, every column of a dropped type — so the set of touched tables
  // is not in the text. The referential action `ON DELETE CASCADE` / `ON UPDATE CASCADE` is NOT
  // that: it is a property of the constraint being defined, and reading it as one made every
  // real `ADD CONSTRAINT ... ON DELETE CASCADE` unparseable on the first sweep.
  //
  // Checked BEFORE `ignorable`, and for every statement head: `DROP TYPE x CASCADE` is on the
  // ignorable list without its CASCADE, and answering "touches no table" for it is exactly the
  // silent skip the module comment rules out.
  const statementCascade = tokens.some(
    (t, i) =>
      t.keyword === 'CASCADE' && kw(tokens, i - 1) !== 'DELETE' && kw(tokens, i - 1) !== 'UPDATE'
  );
  if (statementCascade) {
    return unparsed('CASCADE also changes objects on tables the statement does not name');
  }

  const benign = ignorable(tokens);
  if (benign) return ignored(benign);

  const refs = (via = 'REFERENCES') =>
    referencedTables(tokens, qn).map((table) => ({ table, action: 'present' as const, via }));

  // CREATE [OR REPLACE] [UNIQUE] INDEX [CONCURRENTLY] [IF NOT EXISTS] [name] ON [ONLY] table
  if (a === 'CREATE') {
    let i = skip(tokens, 1, 'OR', 'REPLACE');
    i = skip(tokens, i, 'UNIQUE');
    if (kw(tokens, i) === 'INDEX') {
      const on = find(tokens, 'ON', i + 1);
      const name = on === -1 ? null : qn(skip(tokens, on + 1, 'ONLY'));
      if (!name) return unparsed('CREATE INDEX with no readable ON <table>');
      return {
        kind: 'tables',
        touched: [{ table: name.name, action: 'present', via: 'CREATE INDEX' }],
      };
    }
  }

  // CREATE [GLOBAL|LOCAL] [TEMP|TEMPORARY|UNLOGGED] TABLE [IF NOT EXISTS] name ...
  if (a === 'CREATE') {
    let i = 1;
    i = skip(tokens, i, 'GLOBAL');
    i = skip(tokens, i, 'LOCAL');
    if (kw(tokens, i) === 'TEMP' || kw(tokens, i) === 'TEMPORARY') {
      return unparsed(
        'CREATE TEMPORARY TABLE: a temporary table is not in any catalog to compare against'
      );
    }
    i = skip(tokens, i, 'UNLOGGED');
    if (kw(tokens, i) === 'TABLE') {
      const name = qn(skip(tokens, i + 1, 'IF', 'NOT', 'EXISTS'));
      if (!name) return unparsed('CREATE TABLE with no readable table name');
      const touched: Omit<TouchedTable, 'statement'>[] = [
        { table: name.name, action: 'present', via: 'CREATE TABLE' },
        ...refs(),
      ];
      // PARTITION OF parent / INHERITS (a, b) / LIKE source — the other tables named in the
      // definition. Over-inclusion widens the scope by a table; it cannot hide a finding.
      for (const word of ['OF', 'LIKE']) {
        const at = find(tokens, word, name.end);
        if (at !== -1 && (word === 'LIKE' || kw(tokens, at - 1) === 'PARTITION')) {
          const other = qn(at + 1);
          if (other)
            touched.push({ table: other.name, action: 'present', via: `CREATE TABLE ${word}` });
        }
      }
      const inherits = find(tokens, 'INHERITS', name.end);
      if (inherits !== -1 && tokens[inherits + 1]?.text === '(') {
        for (const t of nameList(tokens, inherits + 2, qn)) {
          touched.push({ table: t, action: 'present', via: 'INHERITS' });
        }
      }
      return { kind: 'tables', touched };
    }
  }

  // ALTER TABLE [IF EXISTS] [ONLY] name [*] ...
  if (a === 'ALTER' && kw(tokens, 1) === 'TABLE') {
    if (kw(tokens, 2) === 'ALL') return unparsed('ALTER TABLE ALL IN TABLESPACE names no table');
    const at = skip(tokens, skip(tokens, 2, 'IF', 'EXISTS'), 'ONLY');
    const name = qn(at);
    if (!name) return unparsed('ALTER TABLE with no readable table name');
    // SET SCHEMA moves the table out of the schema being compared.
    const setSchema = find(tokens, 'SET', name.end);
    if (setSchema !== -1 && kw(tokens, setSchema + 1) === 'SCHEMA') {
      return unparsed(
        'ALTER TABLE ... SET SCHEMA moves the table to a schema this check does not read'
      );
    }
    const touched: Omit<TouchedTable, 'statement'>[] = [];
    // `RENAME TO new` renames the TABLE; `RENAME [COLUMN] a TO b` and `RENAME CONSTRAINT a TO
    // b` do not. Only the first has `TO` straight after `RENAME`.
    const rename = find(tokens, 'RENAME', name.end);
    if (rename !== -1 && kw(tokens, rename + 1) === 'TO') {
      const to = qn(rename + 2);
      if (!to) return unparsed('ALTER TABLE ... RENAME TO with no readable new name');
      touched.push({ table: name.name, action: 'absent', via: 'RENAME TO (old name)' });
      touched.push({ table: to.name, action: 'present', via: 'RENAME TO (new name)' });
    } else {
      touched.push({ table: name.name, action: 'present', via: 'ALTER TABLE' });
    }
    for (const word of ['ATTACH', 'DETACH']) {
      const p = find(tokens, word, name.end);
      if (p !== -1 && kw(tokens, p + 1) === 'PARTITION') {
        const part = qn(p + 2);
        if (part) touched.push({ table: part.name, action: 'present', via: `${word} PARTITION` });
      }
    }
    touched.push(...refs());
    return { kind: 'tables', touched };
  }

  // DROP TABLE [IF EXISTS] a, b [RESTRICT]
  if (a === 'DROP' && kw(tokens, 1) === 'TABLE') {
    const tables = nameList(tokens, skip(tokens, 2, 'IF', 'EXISTS'), qn);
    if (tables.length === 0) return unparsed('DROP TABLE with no readable table name');
    return {
      kind: 'tables',
      touched: tables.map((table) => ({ table, action: 'absent' as const, via: 'DROP TABLE' })),
    };
  }

  // COMMENT ON TABLE t | COLUMN [schema.]t.c | CONSTRAINT c ON t | TRIGGER x ON t | other
  if (a === 'COMMENT' && kw(tokens, 1) === 'ON') {
    const what = kw(tokens, 2);
    if (what === 'TABLE') {
      const name = qn(3);
      if (name)
        return {
          kind: 'tables',
          touched: [{ table: name.name, action: 'present', via: 'COMMENT ON TABLE' }],
        };
    }
    if (what === 'COLUMN') {
      // `table.column` or `schema.table.column`.
      const parts = nameParts(tokens, 3);
      if (parts.length === 3 && parts[0] !== dbSchema) {
        return unparsed(
          `COMMENT ON COLUMN names schema "${parts[0]}", which this check does not compare`
        );
      }
      if (parts.length >= 2) {
        return {
          kind: 'tables',
          touched: [
            { table: parts[parts.length - 2], action: 'present', via: 'COMMENT ON COLUMN' },
          ],
        };
      }
    }
    if (what === 'CONSTRAINT' || what === 'TRIGGER' || what === 'POLICY' || what === 'RULE') {
      const on = find(tokens, 'ON', 3);
      const name = on === -1 ? null : qn(on + 1);
      if (name)
        return {
          kind: 'tables',
          touched: [{ table: name.name, action: 'present', via: `COMMENT ON ${what}` }],
        };
    }
    if (what === 'TABLE' || what === 'COLUMN' || what === 'CONSTRAINT') {
      return unparsed(`COMMENT ON ${what} with no readable table name`);
    }
    return ignored(`COMMENT ON ${what ?? '?'}`);
  }

  // Data statements. Their target is a table the migration touches, even though only its rows
  // change: a backfill is usually the half of a migration that makes a NOT NULL possible.
  if (a === 'INSERT' && kw(tokens, 1) === 'INTO') {
    const name = qn(2);
    if (name)
      return {
        kind: 'tables',
        touched: [{ table: name.name, action: 'present', via: 'INSERT INTO' }],
      };
  }
  if (a === 'UPDATE') {
    const name = qn(skip(tokens, 1, 'ONLY'));
    if (name)
      return { kind: 'tables', touched: [{ table: name.name, action: 'present', via: 'UPDATE' }] };
  }
  if (a === 'DELETE' && kw(tokens, 1) === 'FROM') {
    const name = qn(skip(tokens, 2, 'ONLY'));
    if (name)
      return {
        kind: 'tables',
        touched: [{ table: name.name, action: 'present', via: 'DELETE FROM' }],
      };
  }
  if (a === 'TRUNCATE') {
    const tables = nameList(tokens, skip(tokens, 1, 'TABLE'), qn);
    if (tables.length > 0) {
      return {
        kind: 'tables',
        touched: tables.map((table) => ({ table, action: 'present' as const, via: 'TRUNCATE' })),
      };
    }
  }

  return unparsed(
    `unrecognised statement (${tokens
      .slice(0, 3)
      .map((t) => t.text)
      .join(' ')})`
  );
}

function head(statement: SqlStatement): string {
  const first = statement.raw.split('\n')[0].trim();
  return first.length > 100 ? `${first.slice(0, 97)}...` : first;
}

function quotedMentions(raw: string): string[] {
  const out = new Set<string>();
  for (const m of raw.matchAll(/"((?:[^"]|"")+)"/g)) out.add(m[1].replace(/""/g, '"'));
  return [...out].sort();
}

/** Classify every statement of a migration. See the module comment for the three buckets. */
export function extractMigrationTables(
  sql: string,
  options: { dbSchema?: string } = {}
): MigrationTables {
  const dbSchema = options.dbSchema ?? 'public';
  const statements = splitSqlStatements(sql);
  const touched: TouchedTable[] = [];
  const ignoredStatements: IgnoredStatement[] = [];
  const unparsedStatements: UnparsedStatement[] = [];

  for (const statement of statements) {
    const result = classify(statement, dbSchema);
    if (result.kind === 'tables') {
      for (const t of result.touched) touched.push({ ...t, statement: statement.index });
    } else if (result.kind === 'ignored') {
      ignoredStatements.push({
        statement: statement.index,
        line: statement.line,
        head: head(statement),
        kind: result.label,
      });
    } else {
      unparsedStatements.push({
        statement: statement.index,
        line: statement.line,
        head: head(statement),
        reason: result.reason,
        mentions: quotedMentions(statement.raw),
      });
    }
  }

  return {
    statements: statements.length,
    touched,
    ignored: ignoredStatements,
    unparsed: unparsedStatements,
  };
}

/**
 * Each touched table once, with its FINAL state after the whole migration ran in order — a
 * table created and later dropped is `absent`, one dropped and recreated is `present`.
 */
export function finalTableStates(result: MigrationTables): Map<string, TableAction> {
  const out = new Map<string, TableAction>();
  for (const t of result.touched) out.set(t.table, t.action);
  return out;
}
