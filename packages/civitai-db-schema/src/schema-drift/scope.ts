/**
 * The table set a scoped drift run covers, where each table came from, and whether the schema
 * and the catalog can actually support a claim about it.
 *
 * Pure: no I/O. `cli.ts` reads the migration files and hands their text to
 * `extractMigrationTables`; everything after that is here.
 *
 * WHY THE SCOPE IS VERIFIED, NOT JUST APPLIED. A filter over findings has a failure mode the
 * whole-schema run does not: a requested table that matches no model, or that the catalog does
 * not have, filters EVERYTHING out and prints a perfectly clean report. That is a comparison
 * that visited nothing, wearing the clothes of a passing one — exactly what `assessCoverage`
 * exists to refuse at the whole-schema level. So every table in the scope is checked against
 * both sides before any comparison, and a table either side cannot vouch for makes the run
 * exit 2.
 */
import type { MigrationTables, TableAction } from './migration-tables';
import { finalTableStates } from './migration-tables';
import type { DbCatalog, ParsedSchema } from './types';

export type ScopeOrigin =
  | { kind: 'flag' }
  | { kind: 'migration'; path: string; via: string[]; action: TableAction };

export interface ScopeTable {
  table: string;
  /**
   * What the run expects of the table. `present`: it must be a managed model's table in both
   * the schema and the catalog, and it is compared. `absent`: the migration drops or renames it
   * away, so the run checks that neither side still has it and compares nothing.
   */
  expect: TableAction;
  origins: ScopeOrigin[];
}

export interface ScopeMigration {
  path: string;
  result: MigrationTables;
}

export interface DriftScope {
  /** Sorted by table name, so the header is stable across runs. */
  tables: ScopeTable[];
  migrations: ScopeMigration[];
  /** The run was told to proceed despite unparsed statements (`--allow-unparsed`). */
  allowUnparsed: boolean;
}

/**
 * Merge `--tables` and every `--migration` into one scope.
 *
 * Precedence, stated because it decides what gets compared: migrations are applied in the order
 * given, so a later migration's final state for a table wins over an earlier one's; then a
 * table named by `--tables` is always `present` — the flag is an explicit request to compare
 * it, and a run told to compare a table it also expects dropped will say so by failing the
 * catalog check, rather than silently picking one reading.
 */
export function buildScope(input: {
  tables: string[];
  migrations: ScopeMigration[];
  allowUnparsed: boolean;
}): DriftScope {
  const byTable = new Map<string, ScopeTable>();
  const entry = (table: string): ScopeTable => {
    let e = byTable.get(table);
    if (!e) {
      e = { table, expect: 'present', origins: [] };
      byTable.set(table, e);
    }
    return e;
  };

  for (const migration of input.migrations) {
    const finals = finalTableStates(migration.result);
    for (const [table, action] of finals) {
      const via = [
        ...new Set(migration.result.touched.filter((t) => t.table === table).map((t) => t.via)),
      ];
      const e = entry(table);
      e.expect = action;
      e.origins.push({ kind: 'migration', path: migration.path, via, action });
    }
  }
  for (const table of input.tables) {
    const e = entry(table);
    e.expect = 'present';
    e.origins.push({ kind: 'flag' });
  }

  return {
    tables: [...byTable.values()].sort((a, b) => a.table.localeCompare(b.table)),
    migrations: input.migrations,
    allowUnparsed: input.allowUnparsed,
  };
}

/** Every statement across the scope's migrations that could not be classified. */
export function unparsedStatements(scope: DriftScope) {
  return scope.migrations.flatMap((m) => m.result.unparsed.map((u) => ({ path: m.path, ...u })));
}

/** The tables a comparison should visit. */
export function comparedTables(scope: DriftScope): Set<string> {
  return new Set(scope.tables.filter((t) => t.expect === 'present').map((t) => t.table));
}

/**
 * Reasons this scope cannot be checked against this schema and catalog. Empty when it can.
 *
 * Each problem is a reason the run would otherwise print a clean report about something it did
 * not look at, so each is fatal (exit 2) in the CLI.
 */
export function verifyScope(scope: DriftScope, schema: ParsedSchema, catalog: DbCatalog): string[] {
  const problems: string[] = [];
  const catalogTables = new Set(catalog.tables);
  const models = new Map<string, { ignored: boolean; names: string[] }>();
  for (const model of schema.models) {
    const m = models.get(model.table) ?? { ignored: true, names: [] };
    // A table is managed if ANY model on it is.
    m.ignored = m.ignored && model.ignored;
    m.names.push(model.name);
    models.set(model.table, m);
  }

  if (scope.tables.length === 0) {
    problems.push(
      'the scope is empty: no --tables were given and the migration(s) touch no table. A ' +
        'scoped run over nothing would print a clean report that measured nothing.'
    );
    return problems;
  }

  for (const t of scope.tables) {
    const model = models.get(t.table);
    if (t.expect === 'present') {
      if (!model) {
        problems.push(
          `"${t.table}" is in the scope but no model in the schema maps to it, so there is ` +
            'nothing to compare it against. (Unquoted names fold to lower case, as in ' +
            'Postgres: `ALTER TABLE Image` means "image".)'
        );
      } else if (model.ignored) {
        problems.push(
          `"${t.table}" is in the scope but its model (${model.names.join(', ')}) carries ` +
            '@@ignore, so the drift detector does not check it.'
        );
      }
      if (!catalogTables.has(t.table)) {
        problems.push(
          `"${t.table}" is in the scope but is not an ordinary table in this catalog (absent, ` +
            'or a view). If a migration creates it, it has not been applied to this database.'
        );
      }
    } else {
      if (catalogTables.has(t.table)) {
        problems.push(
          `"${t.table}" is dropped or renamed away by the migration but is still in this ` +
            'catalog, so the migration has not been applied to this database.'
        );
      }
      if (model) {
        problems.push(
          `"${t.table}" is dropped or renamed away by the migration but the schema still ` +
            `declares it (${model.names.join(', ')}).`
        );
      }
    }
  }
  return problems;
}

function describeOrigin(origin: ScopeOrigin): string {
  if (origin.kind === 'flag') return '--tables';
  return `${origin.path} (${origin.via.join(', ')})`;
}

/**
 * The header a scoped report starts with: the EXACT set covered and where each table came from,
 * so a reader can check the scope is the one they meant before believing anything below it.
 */
export function formatScope(scope: DriftScope, knownTables?: ReadonlySet<string>): string {
  const lines: string[] = [];
  const compared = scope.tables.filter((t) => t.expect === 'present');
  const absent = scope.tables.filter((t) => t.expect === 'absent');

  lines.push(
    `Scope: ${compared.length} table(s) compared` +
      (absent.length > 0 ? `, ${absent.length} checked absent` : '') +
      ' — findings on every other table are EXCLUDED from this report'
  );
  const width = Math.max(...scope.tables.map((t) => t.table.length));
  for (const t of compared) {
    lines.push(`  ${t.table.padEnd(width)}  <- ${t.origins.map(describeOrigin).join('; ')}`);
  }
  for (const t of absent) {
    lines.push(
      `  ${t.table.padEnd(width)}  <- ${t.origins.map(describeOrigin).join('; ')}  ` +
        '[expected absent: not in the catalog, not in the schema]'
    );
  }
  lines.push(
    '  A finding belongs to the table it is on; for a foreign key, the REFERENCING table. A ' +
      'relation on an\n  unscoped table that points at a scoped one is not reported.'
  );

  for (const m of scope.migrations) {
    const r = m.result;
    lines.push(
      `  ${m.path}: ${r.statements} statement(s) — ` +
        `${r.statements - r.ignored.length - r.unparsed.length} read for tables, ` +
        `${r.ignored.length} touch no table, ${r.unparsed.length} NOT CLASSIFIED`
    );
  }

  const unparsed = unparsedStatements(scope);
  if (unparsed.length > 0) {
    lines.push('');
    lines.push(
      `Statements NOT classified — ${unparsed.length} (proceeding because of --allow-unparsed)`
    );
    lines.push(
      '  Whatever these touch is NOT in the scope above unless --tables names it. This report ' +
        'says nothing\n  about their effect.'
    );
    lines.push(...formatUnparsed(unparsed, knownTables));
  }

  return lines.join('\n');
}

/**
 * One block per unparsed statement. With `knownTables` (the schema's model tables), the
 * quoted identifiers it mentions are narrowed to the ones that ARE tables — a hint for what to
 * pass to `--tables`, and only a hint: it is never added to the scope by itself.
 */
export function formatUnparsed(
  unparsed: ReturnType<typeof unparsedStatements>,
  knownTables?: ReadonlySet<string>
): string[] {
  const lines: string[] = [];
  for (const u of unparsed) {
    lines.push(`  ${u.path}:${u.line}  ${u.head}`);
    lines.push(`      ${u.reason}`);
    const mentions = knownTables ? u.mentions.filter((m) => knownTables.has(m)) : u.mentions;
    if (mentions.length > 0) {
      lines.push(
        `      ${knownTables ? 'mentions schema tables' : 'mentions'}: ${mentions.join(', ')}`
      );
    }
  }
  return lines;
}
