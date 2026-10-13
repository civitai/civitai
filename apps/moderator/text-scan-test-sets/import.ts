// Seeds a test set from a local JSON file (never committed). Dry run by default; prints counts only. See README.md.
import { readFileSync } from 'node:fs';
import type { DB as ModeratorDB } from '../src/lib/server/moderator-db/types';
import {
  importSeed,
  parseTruthMap,
  type ImportOptions,
} from '../src/lib/server/text-scan-tests/seed';
import { FLAG_LABELS, type FlagLabel } from '../src/lib/text-scan-tests/expected';
import { TEST_SET_LIMITS, WORKSPACES, type Workspace } from '../src/lib/text-scan-tests/types';
import { CliError, createKyselyClients, describeDb, describeError, flag, requireEnv } from './cli';

function parseArgs(argv: string[]): ImportOptions & { file: string } {
  const set = flag(argv, '--set')?.trim();
  const workspace = flag(argv, '--workspace');
  const file = flag(argv, '--file');
  const format = flag(argv, '--format');
  const label = flag(argv, '--label');
  const truthMap = flag(argv, '--truth-map');
  const by = Number(flag(argv, '--by'));
  if (!set || set.length > TEST_SET_LIMITS.nameChars)
    throw new CliError(`--set needs a name of 1-${TEST_SET_LIMITS.nameChars} characters`);
  if (!(WORKSPACES as readonly unknown[]).includes(workspace))
    throw new CliError('--workspace is prompts or modelRules');
  if (!file) throw new CliError('--file is required');
  if (format !== 'lab-seed' && format !== 'bench')
    throw new CliError('--format is lab-seed or bench');
  if (!Number.isInteger(by) || by < 1) throw new CliError('--by needs the moderator user id');
  if (label !== undefined && !(FLAG_LABELS as readonly string[]).includes(label))
    throw new CliError(`--label is one of ${FLAG_LABELS.join(', ')}`);
  const map = truthMap === undefined ? undefined : parseTruthMap(truthMap);
  if (typeof map === 'string') throw new CliError(map);
  return {
    set,
    workspace: workspace as Workspace,
    file,
    format,
    label: label as FlagLabel | undefined,
    truthMap: map,
    by,
    write: argv.includes('--write'),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dbUrl = requireEnv('MODERATOR_DATABASE_URL');
  console.log(
    JSON.stringify({ moderatorDb: describeDb(dbUrl), workspace: args.workspace, write: args.write })
  );
  const json: unknown = JSON.parse(readFileSync(args.file, 'utf8'));
  if (!args.write) {
    console.log(JSON.stringify(await importSeed(null, json, args), null, 2));
    console.log('dry run: nothing written.');
    return;
  }
  const { db } = createKyselyClients<ModeratorDB>({ connectionString: dbUrl, singleClient: true });
  try {
    console.log(JSON.stringify(await importSeed(db, json, args), null, 2));
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  console.error(describeError(err));
  process.exit(1);
});
