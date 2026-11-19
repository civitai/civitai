/**
 * Schema <-> database drift detector.
 *
 *   pnpm --filter @civitai/db-schema drift            # read DATABASE_URL, print a report
 *   pnpm --filter @civitai/db-schema drift --json     # machine-readable
 *   pnpm --filter @civitai/db-schema drift --migration prisma/migrations/<dir>/migration.sql
 *                                                     # only the tables that migration touches
 *
 * Read-only. Every database statement is a SELECT against pg_catalog; the tool never
 * writes, and never applies a migration.
 *
 * The connection comes from DATABASE_URL in the environment. Nothing about where the
 * database lives is baked in here, and nothing about it should be added.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { readCatalog, DEFAULT_DB_SCHEMA } from './catalog';
import { assertCatalogSanity, assessCoverage, compareSchemaToCatalog } from './compare';
import { parsePrismaSchema } from './parse-prisma-schema';
import { extractMigrationTables } from './migration-tables';
import { formatReport } from './report';
import {
  buildScope,
  comparedTables,
  formatScope,
  formatUnparsed,
  unparsedStatements,
  verifyScope,
  type DriftScope,
} from './scope';
import type { DbCatalog } from './types';

interface Options {
  schemaPath: string;
  catalogPath: string | null;
  dbSchema: string;
  json: boolean;
  verbose: boolean;
  strict: boolean;
  /** `--tables`, in the order given, de-duplicated. */
  tables: string[];
  /** `--migration` paths exactly as given, for the report header. */
  migrations: string[];
  allowUnparsed: boolean;
}

const USAGE = `Usage: drift [options]

  --schema <path>    Prisma schema to read (default: this package's schema.full.prisma)
  --catalog <path>   Read a previously captured catalog JSON instead of connecting
  --db-schema <name> Postgres schema to introspect (default: ${DEFAULT_DB_SCHEMA})
  --dump-catalog     Print the catalog as JSON and exit (no comparison)
  --json             Emit the drift report as JSON
  --verbose          Include the skipped-model list in the text report
  --strict           Exit 1 when any drift is found, or when any referential action
                     could not be compared (default: always exit 0)
  --tables <A,B,..>  Compare only these tables (exact, case-sensitive names). Repeatable
  --migration <sql>  Compare only the tables this migration file touches. Repeatable, or
                     comma-separated. Combines with --tables
  --allow-unparsed   Proceed although a --migration has statements that could not be
                     classified (DO blocks, functions, triggers, views, DROP INDEX, CASCADE,
                     anything unrecognised). They are still listed, and whatever they touch
                     is NOT in scope unless --tables names it
  --help             This message

Connection is read from DATABASE_URL. A run whose comparison covered nothing exits 2,
with or without --strict — and so does a scoped run naming a table the schema or the
catalog does not have, or a --migration with unclassified statements and no
--allow-unparsed.`;

/**
 * Strip anything that looks like a connection string or a host from a message before it
 * reaches stdout/stderr.
 *
 * This repo is public and so are its CI logs. A URL passed positionally by mistake would
 * otherwise be echoed back by the unknown-argument error, credentials and all.
 */
function redact(text: string): string {
  return text
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<redacted-connection-string>')
    .replace(/\b\S+@\S+\b/g, '<redacted-host>');
}

/**
 * `pg` embeds the host, port and user it tried in its connection errors (`connect
 * ECONNREFUSED <ip>:<port>`, `getaddrinfo ENOTFOUND <host>`). Report the error CODE, which
 * is the diagnostic part, and drop the address, which is the part that must not be logged.
 */
function connectionFailure(error: unknown): Error {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code)
      : 'unknown';
  return new Error(
    `Could not read the database catalog (${code}). Check DATABASE_URL and that the role ` +
      'can read pg_catalog. The address is deliberately not printed: this repo and its CI ' +
      'logs are public.'
  );
}

/**
 * Locate the canonical schema without depending on the module system.
 *
 * `pnpm --filter @civitai/db-schema drift` runs with cwd at the package; a bare `tsx`
 * invocation from the repo root has cwd at the root. Both are covered; anything else
 * passes `--schema`. (`import.meta.url` would be tidier but this package is not ESM.)
 */
function defaultSchemaPath(): string {
  const candidates = [
    resolve(process.cwd(), 'prisma/schema.full.prisma'),
    resolve(process.cwd(), 'packages/civitai-db-schema/prisma/schema.full.prisma'),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0];
}

function parseArgs(argv: string[]): Options & { dumpCatalog: boolean; help: boolean } {
  const options = {
    schemaPath: defaultSchemaPath(),
    catalogPath: null as string | null,
    dbSchema: DEFAULT_DB_SCHEMA,
    json: false,
    verbose: false,
    strict: false,
    tables: [] as string[],
    migrations: [] as string[],
    allowUnparsed: false,
    dumpCatalog: false,
    help: false,
  };
  // Comma-separated and repeatable. An empty element (`--tables A,,B`, `--tables ""`) is an
  // error rather than skipped: it is almost always a shell variable that expanded to nothing,
  // and dropping it would quietly narrow the scope the caller asked for.
  const list = (flag: string, value: string): string[] => {
    const parts = value.split(',').map((p) => p.trim());
    if (parts.some((p) => p.length === 0)) {
      throw new Error(`${flag} has an empty entry in "${redact(value)}"`);
    }
    return parts;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      i += 1;
      return value;
    };
    switch (arg) {
      case '--schema':
        options.schemaPath = resolve(next());
        break;
      case '--catalog':
        options.catalogPath = resolve(next());
        break;
      case '--db-schema':
        options.dbSchema = next();
        break;
      case '--dump-catalog':
        options.dumpCatalog = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '--verbose':
        options.verbose = true;
        break;
      case '--strict':
        options.strict = true;
        break;
      case '--tables':
        for (const t of list(arg, next())) {
          if (!options.tables.includes(t)) options.tables.push(t);
        }
        break;
      case '--migration':
        options.migrations.push(...list(arg, next()));
        break;
      case '--allow-unparsed':
        options.allowUnparsed = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${redact(arg)}\n\n${USAGE}`);
    }
  }
  return options;
}

async function loadCatalog(options: Options): Promise<DbCatalog> {
  if (options.catalogPath) {
    return JSON.parse(readFileSync(options.catalogPath, 'utf8')) as DbCatalog;
  }
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set. Set it, or pass --catalog <captured.json>.');
  }
  const client = new Client({ connectionString });
  try {
    await client.connect();
    return await readCatalog(client, options.dbSchema);
  } catch (error) {
    throw connectionFailure(error);
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const scoped = options.tables.length > 0 || options.migrations.length > 0;
  if (scoped && options.dumpCatalog) {
    throw new Error(
      '--dump-catalog captures the whole catalog; it does not take --tables or --migration.'
    );
  }
  if (options.allowUnparsed && options.migrations.length === 0) {
    throw new Error('--allow-unparsed only means something with --migration.');
  }

  // Migrations are read and classified BEFORE any connection is opened: a migration this tool
  // cannot read should cost the operator nothing but the message.
  let scope: DriftScope | null = null;
  // Parsed before the catalog read, so the unparsed-statement message below can say which of
  // the identifiers a statement mentions are tables. Not on the --dump-catalog path, which
  // never needed a schema and must not start failing for want of one.
  const schema = options.dumpCatalog
    ? null
    : parsePrismaSchema(readFileSync(options.schemaPath, 'utf8'));
  const schemaTables = new Set(schema?.models.map((m) => m.table) ?? []);
  if (scoped) {
    scope = buildScope({
      tables: options.tables,
      migrations: options.migrations.map((path) => {
        const full = resolve(path);
        if (!existsSync(full)) throw new Error(`--migration file not found: ${redact(path)}`);
        return {
          path,
          result: extractMigrationTables(readFileSync(full, 'utf8'), {
            dbSchema: options.dbSchema,
          }),
        };
      }),
      allowUnparsed: options.allowUnparsed,
    });
    const unparsed = unparsedStatements(scope);
    if (unparsed.length > 0 && !options.allowUnparsed) {
      process.stderr.write(
        `${unparsed.length} statement(s) in the migration could not be classified, so the set ` +
          'of tables it touches is NOT known:\n' +
          `${formatUnparsed(unparsed, schemaTables).join('\n')}\n\n` +
          'Refusing to run a scoped check over a guessed subset. Read the statements above, ' +
          'then re-run with\n--allow-unparsed, adding --tables for every table they touch. ' +
          'They will still be listed in the report.\n'
      );
      return 2;
    }
  }

  const catalog = await loadCatalog(options);
  // Sanity-check BEFORE dumping, not only before comparing. The STALE message this tool
  // prints tells an operator to recapture with `--dump-catalog`, and without this that
  // recapture could happily emit a catalog the very next `drift` run would reject — the
  // reserved-word `NOTNULL` read, which succeeds and returns a constant `true` for every
  // column, being the motivating case. Failing at capture time is the cheap end.
  assertCatalogSanity(catalog);

  if (options.dumpCatalog) {
    // Stamp the capture instant. A frozen catalog decays — every column created after it is
    // invisible to a comparison against it — and without a date on the artefact that decay
    // cannot be reported by anything downstream. Read from a --catalog file, an existing
    // stamp is preserved rather than refreshed: it dates the CAPTURE, not the re-dump.
    const stamped: DbCatalog = {
      ...catalog,
      capturedAt: catalog.capturedAt ?? new Date().toISOString(),
    };
    // Indented, and the committed snapshot is `.prettierignore`d to match. Single-line JSON
    // made a CONTENT-IDENTICAL re-dump of the committed fixture a 21,522-line diff, which is
    // the same unreviewable-diff problem `drift-baseline.json` was fixed for — and worse
    // here, because the gate's own STALE message tells you to run this command. Prettier
    // cannot be the owner instead: it collapses short arrays (`"columns": ["userId"]`) in a
    // way `JSON.stringify` will not reproduce, so the two disagree by 3,598 lines and the
    // artefact only stays clean if every operator remembers to run a formatter afterwards.
    // Nothing enforces that, and `prettier --check` on a MODIFIED file is report-only here.
    // One owner, no discipline required: a re-dump of the committed snapshot is a zero-line
    // diff.
    //
    // (3,598 is measured with the file IN the repo, where `.prettierrc` resolves and sets
    // printWidth 100. Copying it to /tmp first gives 3,589 — prettier's default width 80 —
    // which is a fact about where the measurement was taken, not about these two formats.)
    process.stdout.write(`${JSON.stringify(stamped, null, 2)}\n`);
    return 0;
  }
  // Unreachable — only --dump-catalog leaves it null, and that returned above. Narrows the type.
  if (!schema) throw new Error('internal: schema was not parsed');

  if (scope) {
    // Before comparing: a requested table either side cannot vouch for would be filtered to
    // nothing and print clean. See `verifyScope`.
    const problems = verifyScope(scope, schema, catalog);
    if (problems.length > 0) {
      process.stderr.write(
        `${formatScope(
          scope,
          schemaTables
        )}\n\nThis scoped run cannot cover what it was asked to:\n${problems
          .map((p) => `  - ${p}\n`)
          .join('')}`
      );
      return 2;
    }
    if (comparedTables(scope).size === 0) {
      // Only drops/renames-away: each was verified absent above, which is the whole check.
      process.stdout.write(
        `${formatScope(
          scope,
          schemaTables
        )}\n\nEvery table in scope is expected absent and is absent. ` + 'Nothing to compare.\n'
      );
      return 0;
    }
  }

  const report = compareSchemaToCatalog(
    schema,
    catalog,
    scope ? { tables: comparedTables(scope) } : {}
  );

  if (options.json) {
    process.stdout.write(`${JSON.stringify(scope ? { scope, ...report } : report, null, 2)}\n`);
  } else {
    if (scope) process.stdout.write(`${formatScope(scope, schemaTables)}\n\n`);
    process.stdout.write(`${formatReport(report, { verbose: options.verbose })}\n`);
  }

  // A comparison that visited nothing prints exactly the same reassuring page as a clean
  // database. That is the one failure mode this tool must never have, so it is fatal
  // regardless of --strict: a clean report is a claim, and an empty catalog cannot support
  // it. Exit 2 (error), not 1 (drift found) — nothing was measured either way.
  const coverage = assessCoverage(report);
  if (coverage.length > 0) {
    process.stderr.write(
      `\nThis report is not trustworthy and its clean sections mean nothing:\n${coverage
        .map((problem) => `  - ${problem}\n`)
        .join('')}\nCheck --db-schema, DATABASE_URL, and the role's catalog visibility.\n`
    );
    return 2;
  }

  if (!options.strict) return 0;

  // Default is report-only. The database currently carries a real backlog of drift, so a
  // gate that failed on any finding would be red on every run and would be switched off
  // within a week; --strict is opt-in for a caller that has a clean baseline to hold.
  if (report.findings.length > 0) return 1;

  // Under --strict, "could not compare" is not "compared and found nothing". A catalog
  // without ON DELETE/UPDATE data yields no referential-action findings at all, so a gate
  // would otherwise pass having checked none of them.
  if (report.counts.referentialActionUnknown > 0) {
    process.stderr.write(
      `\n--strict: ${report.counts.referentialActionUnknown} referential actions could not be ` +
        'compared (the catalog carried no ON DELETE/UPDATE data), so this run cannot ' +
        'certify them.\n'
    );
    return 1;
  }

  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
);
