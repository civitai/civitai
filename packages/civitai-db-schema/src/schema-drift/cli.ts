/**
 * Schema <-> database drift detector.
 *
 *   pnpm --filter @civitai/db-schema drift            # read DATABASE_URL, print a report
 *   pnpm --filter @civitai/db-schema drift --json     # machine-readable
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
import { formatReport } from './report';
import type { DbCatalog } from './types';

interface Options {
  schemaPath: string;
  catalogPath: string | null;
  dbSchema: string;
  json: boolean;
  verbose: boolean;
  strict: boolean;
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
  --help             This message

Connection is read from DATABASE_URL. A run whose comparison covered nothing exits 2,
with or without --strict.`;

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
    dumpCatalog: false,
    help: false,
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

  const catalog = await loadCatalog(options);
  if (options.dumpCatalog) {
    process.stdout.write(`${JSON.stringify(catalog)}\n`);
    return 0;
  }

  // Fails loudly on a catalog read that answered uniformly — see compare.ts.
  assertCatalogSanity(catalog);

  const schema = parsePrismaSchema(readFileSync(options.schemaPath, 'utf8'));
  const report = compareSchemaToCatalog(schema, catalog);

  process.stdout.write(
    options.json
      ? `${JSON.stringify(report, null, 2)}\n`
      : `${formatReport(report, { verbose: options.verbose })}\n`
  );

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
