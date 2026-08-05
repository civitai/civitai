/**
 * Foreign-key remediation runner.
 *
 *   pnpm --filter @civitai/db-schema fk-remediate                     # plan, offline
 *   pnpm --filter @civitai/db-schema fk-remediate --catalog c.json    # plan from a snapshot
 *   pnpm --filter @civitai/db-schema fk-remediate --measure           # plan + count orphans
 *   pnpm --filter @civitai/db-schema fk-remediate --relation X.y --measure --apply
 *
 * 🔴 THE DEFAULT IS A DRY RUN AND ISSUES NO STATEMENTS AT ALL. `--apply` is the only thing
 * that changes that, it takes no value, and it requires exactly one `--relation`.
 *
 * The connection comes from DATABASE_URL in the environment. Nothing about where the
 * database lives is baked in here, and nothing about it should be added — this repository
 * and its CI logs are public.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { DEFAULT_DB_SCHEMA, readCatalog } from '../catalog';
import { assertCatalogSanity } from '../compare';
import { parsePrismaSchema } from '../parse-prisma-schema';
import { readIndexes } from './catalog-indexes';
import { RemediationRefused, countOrphans, executePlan } from './execute';
import { DEFAULT_BACKUP_SCHEMA, DEFAULT_BATCH_SIZE, buildRemediationPlan } from './plan';
import { formatPlan } from './report';
import type { RemediationCatalog } from './types';

const USAGE = `Usage: fk-remediate [options]

  --schema <path>     Prisma schema to read (default: this package's schema.full.prisma)
  --catalog <path>    Read a captured catalog JSON instead of connecting
  --db-schema <name>  Postgres schema to introspect (default: ${DEFAULT_DB_SCHEMA})
  --relation <key>    Restrict to one relation, e.g. ImageTagForReview.imageId.
                      Repeatable when planning; exactly one is required with --apply.
  --measure           Count orphans (read-only). Requires a connection.
  --batch-size <n>    Rows per remediation statement (default: ${DEFAULT_BATCH_SIZE})
  --backup-schema <s> Schema the orphan backups are written to (default: ${DEFAULT_BACKUP_SCHEMA})
  --apply             Execute. Requires exactly one --relation and --measure.
  --json              Emit the plan as JSON
  --verbose           Include relations whose foreign key already exists
  --help              This message

Without --apply nothing is executed: --measure issues read-only counts, everything else
runs offline. Exit 1 when a selected relation is refused or blocked, 2 on error.`;

interface Options {
  schemaPath: string;
  catalogPath: string | null;
  dbSchema: string;
  only: string[];
  measure: boolean;
  batchSize: number;
  backupSchema: string;
  apply: boolean;
  json: boolean;
  verbose: boolean;
  help: boolean;
}

/**
 * Strip anything that looks like a connection string or a host before it reaches stdout.
 * A URL passed positionally by mistake would otherwise be echoed back, credentials and all.
 */
function redact(text: string): string {
  return text
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<redacted-connection-string>')
    .replace(/\b\S+@\S+\b/g, '<redacted-host>');
}

function connectionFailure(error: unknown): Error {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code)
      : 'unknown';
  return new Error(
    `Could not read the database (${code}). Check DATABASE_URL and that the role can read ` +
      'pg_catalog. The address is deliberately not printed: this repo and its CI logs are ' +
      'public.'
  );
}

function defaultSchemaPath(): string {
  const candidates = [
    resolve(process.cwd(), 'prisma/schema.full.prisma'),
    resolve(process.cwd(), 'packages/civitai-db-schema/prisma/schema.full.prisma'),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0];
}

export function parseArgs(argv: string[]): Options {
  const options: Options = {
    schemaPath: defaultSchemaPath(),
    catalogPath: null,
    dbSchema: DEFAULT_DB_SCHEMA,
    only: [],
    measure: false,
    batchSize: DEFAULT_BATCH_SIZE,
    backupSchema: DEFAULT_BACKUP_SCHEMA,
    apply: false,
    json: false,
    verbose: false,
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
      case '--relation':
        options.only.push(next());
        break;
      case '--measure':
        options.measure = true;
        break;
      case '--batch-size': {
        const raw = next();
        const value = Number(raw);
        if (!Number.isInteger(value) || value < 1 || value > 100_000) {
          throw new Error(`--batch-size must be an integer between 1 and 100000, got ${raw}`);
        }
        options.batchSize = value;
        break;
      }
      case '--backup-schema':
        options.backupSchema = next();
        break;
      case '--apply':
        options.apply = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '--verbose':
        options.verbose = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${redact(arg)}\n\n${USAGE}`);
    }
  }

  // Checked here rather than at the point of execution so that an --apply invocation that
  // is going to be rejected is rejected before it opens a connection.
  if (options.apply) {
    if (options.only.length !== 1) {
      throw new Error(
        `--apply requires exactly one --relation; got ${options.only.length}. Remediate one ` +
          'relation at a time.'
      );
    }
    if (options.catalogPath) {
      throw new Error(
        '--apply cannot be combined with --catalog. Executing against a live database on the ' +
          'strength of a captured snapshot means acting on a catalog that may be months old.'
      );
    }
    if (!options.measure) {
      throw new Error(
        '--apply requires --measure. Applying without knowing the orphan count means not ' +
          'knowing whether the VALIDATE at the end can succeed.'
      );
    }
  }
  return options;
}

function loadCatalogFile(path: string): RemediationCatalog {
  return JSON.parse(readFileSync(path, 'utf8')) as RemediationCatalog;
}

async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set. Set it, or pass --catalog <captured.json>.');
  }
  const client = new Client({ connectionString });
  try {
    await client.connect();
    return await fn(client);
  } catch (error) {
    if (error instanceof RemediationRefused) throw error;
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

  const schema = parsePrismaSchema(readFileSync(options.schemaPath, 'utf8'));
  const planOptions = {
    only: options.only,
    batchSize: options.batchSize,
    backupSchema: options.backupSchema,
  };

  const render = (plan: ReturnType<typeof buildRemediationPlan>) => {
    process.stdout.write(
      options.json
        ? `${JSON.stringify(plan, null, 2)}\n`
        : `${formatPlan(plan, { verbose: options.verbose })}\n`
    );
  };

  // Offline: a captured catalog, no connection, no counts.
  if (options.catalogPath) {
    const catalog = loadCatalogFile(options.catalogPath);
    assertCatalogSanity(catalog);
    const plan = buildRemediationPlan(schema, catalog, planOptions);
    render(plan);
    return verdict(plan);
  }

  if (!options.measure && !options.apply) {
    throw new Error(
      'Nothing to do: with no --catalog and no --measure there is no catalog to plan ' +
        'against. Pass --catalog <captured.json> to plan offline, or --measure to read the ' +
        'live database.'
    );
  }

  return withClient(async (client) => {
    const catalog: RemediationCatalog = await readCatalog(client, options.dbSchema);
    assertCatalogSanity(catalog);
    catalog.indexes = await readIndexes(client, options.dbSchema);

    // Two passes: plan once to learn which relations exist and are worth counting, count
    // them, then re-plan with the counts. Counting is read-only; the anti-joins are the
    // expensive part, so only relations that got past the refusals are counted.
    const first = buildRemediationPlan(schema, catalog, planOptions);
    const orphanCounts: Record<string, number> = {};
    for (const relation of first.relations) {
      if (relation.outcome === 'satisfied' || relation.outcome === 'refused') continue;
      orphanCounts[relation.key] = await countOrphans(
        client,
        relation,
        options.backupSchema,
        options.batchSize
      );
    }

    const plan = buildRemediationPlan(schema, catalog, { ...planOptions, orphanCounts });
    render(plan);

    if (!options.apply) return verdict(plan);

    const result = await executePlan(client, plan, {
      apply: true,
      onStatement: (statement, key) => {
        process.stderr.write(`[apply] ${key}: ${statement.kind}\n`);
      },
    });
    for (const relation of result.relations) {
      process.stderr.write(
        `[apply] ${relation.key}: ${relation.rowsRemediated} row(s) remediated over ` +
          `${relation.batches} batch(es), ${relation.executed.length} statement(s)\n`
      );
    }
    return 0;
  });
}

/**
 * Exit code for a plan-only run.
 *
 * A plan whose selected relations are all refused or blocked exits 1 rather than 0: the
 * caller asked for something and got nothing, and a zero exit there is the reassuring
 * result that makes a refusal read as a success.
 */
function verdict(plan: ReturnType<typeof buildRemediationPlan>): number {
  if (plan.unmatchedSelectors.length > 0) {
    process.stderr.write(
      `\nThese selectors matched no declared relation: ${plan.unmatchedSelectors.join(', ')}\n` +
        'Every count printed above is about the relations that DID match.\n'
    );
    return 2;
  }
  if (plan.counts.relationsConsidered === 0) {
    process.stderr.write(
      '\nThe plan considered no relation at all. That is a broken run, not a clean one.\n'
    );
    return 2;
  }
  return plan.counts.refused > 0 || plan.counts.blocked > 0 ? 1 : 0;
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
