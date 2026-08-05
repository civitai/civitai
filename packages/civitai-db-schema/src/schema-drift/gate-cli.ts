/**
 * CI entry point for the schema<->database drift delta gate.
 *
 *   pnpm --filter @civitai/db-schema drift:gate        # verdict; exit 1 on new enforced drift
 *   pnpm --filter @civitai/db-schema drift:baseline    # rewrite the baseline from this pair
 *
 * READ-ONLY, AND NOT MERELY BY CONVENTION. Unlike `cli.ts`, this entry point has no database
 * code path at all: it takes a captured catalog JSON and nothing else, and there is no flag
 * that makes it open a connection. That is deliberate. This runs on a public repo's CI, so
 * it must be impossible for it to hold a credential, resolve a hostname, or print either one
 * into a public log — not "configured not to", but unable to. The `pg` client is not
 * imported here.
 *
 * Exit codes:
 *   0  no new enforced drift
 *   1  this change introduces drift on columns the database already has
 *   2  the run cannot be trusted (bad arguments, unreadable inputs, a baseline that does not
 *      describe these inputs, or a comparison that covered nothing)
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { assertCatalogSanity, assessCoverage, compareSchemaToCatalog } from './compare';
import {
  assertMeasuredSomething,
  buildBaseline,
  evaluateGate,
  formatGateResult,
  type Baseline,
} from './gate';
import { parsePrismaSchema } from './parse-prisma-schema';
import type { DbCatalog } from './types';

const PACKAGE_ROOT = resolve(__dirname, '../..');

const DEFAULT_SCHEMA = 'prisma/schema.full.prisma';
const DEFAULT_CATALOG = 'src/schema-drift/__tests__/fixtures/catalog-production-2026-08-03.json';
const DEFAULT_BASELINE = 'src/schema-drift/drift-baseline.json';

const USAGE = `Usage: drift-gate [options]

  --schema <path>      Prisma schema (default: ${DEFAULT_SCHEMA})
  --catalog <path>     Captured catalog JSON (default: ${DEFAULT_CATALOG})
  --baseline <path>    Accepted-findings baseline (default: ${DEFAULT_BASELINE})
  --update-baseline    Rewrite the baseline from this schema/catalog pair and exit 0
  --help               This message

Paths are resolved against the @civitai/db-schema package root, so the command behaves the
same from the package and from the repo root. No database connection is ever opened.`;

interface Options {
  schemaPath: string;
  catalogPath: string;
  baselinePath: string;
  updateBaseline: boolean;
  help: boolean;
}

/**
 * Strip anything shaped like a connection string or a host before it reaches a public log.
 *
 * This entry point never connects, so it cannot produce `getaddrinfo ENOTFOUND <host>` of its
 * own — but it does echo unknown arguments back, and an operator who pastes a URL positionally
 * would otherwise have it printed, credentials and all, into a public CI log.
 */
function redact(text: string): string {
  return text
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<redacted-connection-string>')
    .replace(/\b\S+@\S+\b/g, '<redacted-host>');
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    schemaPath: DEFAULT_SCHEMA,
    catalogPath: DEFAULT_CATALOG,
    baselinePath: DEFAULT_BASELINE,
    updateBaseline: false,
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
        options.schemaPath = next();
        break;
      case '--catalog':
        options.catalogPath = next();
        break;
      case '--baseline':
        options.baselinePath = next();
        break;
      case '--update-baseline':
        options.updateBaseline = true;
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

function readJson<T>(path: string, what: string): T {
  if (!existsSync(path)) {
    throw new Error(`${what} not found at ${relative(PACKAGE_ROOT, path)}`);
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (error) {
    throw new Error(
      `${what} at ${relative(PACKAGE_ROOT, path)} is not readable JSON: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

function main(): number {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const schemaPath = resolve(PACKAGE_ROOT, options.schemaPath);
  const catalogPath = resolve(PACKAGE_ROOT, options.catalogPath);
  const baselinePath = resolve(PACKAGE_ROOT, options.baselinePath);

  if (!existsSync(schemaPath)) {
    throw new Error(`Prisma schema not found at ${relative(PACKAGE_ROOT, schemaPath)}`);
  }
  const catalog = readJson<DbCatalog>(catalogPath, 'Catalog snapshot');

  // The catalog's own positive control, before anything is compared against it.
  assertCatalogSanity(catalog);

  const schema = parsePrismaSchema(readFileSync(schemaPath, 'utf8'));
  const report = compareSchemaToCatalog(schema, catalog);

  // A comparison that visited nothing prints the same reassuring page as a clean database.
  // Fatal regardless of the verdict: nothing was measured either way.
  const coverage = assessCoverage(report);
  if (coverage.length > 0) {
    process.stderr.write(
      `This gate's verdict is meaningless:\n${coverage.map((p) => `  - ${p}\n`).join('')}`
    );
    return 2;
  }

  const catalogRelative = relative(PACKAGE_ROOT, catalogPath).split('\\').join('/');

  if (options.updateBaseline) {
    const baseline = buildBaseline(report, catalog, catalogRelative);
    writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
    process.stdout.write(
      `Wrote ${baseline.entries.length} accepted finding(s) to ` +
        `${relative(PACKAGE_ROOT, baselinePath)}\n` +
        `  enforced: ${baseline.entries.filter((e) => e.tier === 'enforced').length}\n` +
        `  pending : ${baseline.entries.filter((e) => e.tier === 'pending').length}\n`
    );
    return 0;
  }

  const baseline = readJson<Baseline>(baselinePath, 'Baseline');

  // A baseline measured against a different catalog describes a different database. Every
  // entry would mismatch and the gate would either flood or, if the shapes happened to line
  // up, pass for the wrong reason.
  if (baseline.catalog !== catalogRelative) {
    process.stderr.write(
      `Baseline was captured against "${baseline.catalog}" but this run used ` +
        `"${catalogRelative}". A baseline only means anything next to the catalog it was ` +
        'measured with. Recapture it with `--update-baseline`.\n'
    );
    return 2;
  }

  const result = evaluateGate(report, catalog, baseline);
  process.stdout.write(`${formatGateResult(result, baseline)}\n`);

  const untrustworthy = assertMeasuredSomething(result, baseline);
  if (untrustworthy.length > 0) {
    process.stderr.write(
      `\nThis gate's verdict is meaningless:\n${untrustworthy.map((p) => `  - ${p}\n`).join('')}`
    );
    return 2;
  }

  if (result.newEnforced.length > 0) {
    process.stderr.write(
      `\nBLOCKED: this change introduces ${result.newEnforced.length} drift finding(s) on ` +
        'columns the database already has.\n\n' +
        'If the declaration is wrong, fix the schema. If the database is wrong, write the ' +
        'migration\n(`pnpm run db:migrate:empty "..."`) — and because migrations here are ' +
        'applied by hand, also\nget it applied, then recapture the catalog snapshot.\n\n' +
        'If it is a deliberate, accepted gap, record it: run\n' +
        '  pnpm --filter @civitai/db-schema drift:baseline\n' +
        'and commit the baseline change with the reason in the PR description. The point of ' +
        'the\nbaseline is that accepting drift is a reviewable act, not a silent one.\n'
    );
    return 1;
  }

  process.stdout.write('\nOK: no new drift on columns the database already has.\n');
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(`${redact(error instanceof Error ? error.message : String(error))}\n`);
  process.exitCode = 2;
}
