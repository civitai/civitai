// A worktree's app envs get the database the primary root .env names: in the text of every copied
// .env, and in the env the daemon spawns a worktree app with, whatever the primary app .env says.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AppSession, primaryCheckout } from './daemon.mjs';
import { appDatabaseEnv, devDbFromEnvText, routeEnvTextToDevDb } from './dev-db.mjs';
import { redactedMismatch } from './selftest-redact.mjs';

const failures = [];
let checks = 0;

function check(name, actual, expected) {
  checks++;
  if (actual !== expected) failures.push(`${name}: ${redactedMismatch(actual, expected)}`);
}

const PLANTED = 'postgres://u:p@example.invalid:5432/x';
const DEV = 'postgres://dev:dev@dev.example.invalid:5432/civitai';
const DEV_REPLICA = 'postgres://dev:dev@dev-replica.example.invalid:5432/civitai';
const devDb = { DATABASE_URL: DEV, DATABASE_REPLICA_URL: DEV_REPLICA };
const plantedIn = (env) =>
  Object.values(env).filter((v) => String(v).includes('u:p@example.invalid')).length;

// --- the dev value: the root .env's last ACTIVE line ---
check(
  'reads the last active lines, ignoring commented ones',
  JSON.stringify(
    devDbFromEnvText(
      `# DATABASE_URL=${PLANTED}\nDATABASE_URL=old\nDATABASE_URL=${DEV}\n#DATABASE_REPLICA_URL=${PLANTED}\nDATABASE_REPLICA_URL=${DEV_REPLICA}\n`
    )
  ),
  JSON.stringify(devDb)
);
check(
  'a root with no replica lends its DATABASE_URL to the replica',
  devDbFromEnvText(`DATABASE_URL=${DEV}\n`)?.DATABASE_REPLICA_URL,
  DEV
);
check(
  'a root with only a commented DATABASE_URL has no dev value',
  devDbFromEnvText(`# DATABASE_URL=${DEV}\n`),
  null
);

// --- the text rewrite ---
const appText = `A=1\nDATABASE_URL=${PLANTED}\n  export DATABASE_REPLICA_URL="${PLANTED}"\n# DATABASE_URL=${PLANTED}\n#DATABASE_REPLICA_URL=${PLANTED}\nB=2\n`;
const routed = routeEnvTextToDevDb(appText, devDb);
check(
  'active lines take the dev value in place; commented ones are dropped',
  routed.text,
  `A=1\nDATABASE_URL=${DEV}\n  export DATABASE_REPLICA_URL=${DEV_REPLICA}\nB=2\n`
);
check('counts every line it changed', routed.changed, 4);
check('routing a routed file changes nothing', routeEnvTextToDevDb(routed.text, devDb).changed, 0);
check(
  'keeps CRLF',
  routeEnvTextToDevDb(`A=1\r\nDATABASE_URL=${PLANTED}\r\n`, devDb).text,
  `A=1\r\nDATABASE_URL=${DEV}\r\n`
);
const noDb = 'A=1\nDATABASE_POOL_MAX=5\n';
check('a file with no DB line comes back as is', routeEnvTextToDevDb(noDb, devDb).text, noDb);
check(
  'an active DB line with no dev value is refused',
  routeEnvTextToDevDb(appText, null).missing,
  true
);
check(
  'only commented DB lines with no dev value are dropped, not refused',
  routeEnvTextToDevDb(`A=1\n# DATABASE_URL=${PLANTED}\n`, null).text,
  'A=1\n'
);

// --- the key-by-key pick ---
check(
  "the worktree's own app value wins over its root",
  appDatabaseEnv({ DATABASE_URL: 'own' }, { DATABASE_URL: DEV }).DATABASE_URL,
  'own'
);
check(
  'a key nobody in the worktree sets stays unset',
  appDatabaseEnv({}, {}).DATABASE_URL,
  undefined
);
check(
  "a worktree's own DATABASE_URL with no replica of its own is its replica too, not the root's",
  appDatabaseEnv({ DATABASE_URL: 'own' }, devDb).DATABASE_REPLICA_URL,
  'own'
);
check(
  "... while the worktree's own replica, if set, wins",
  appDatabaseEnv({ DATABASE_URL: 'own', DATABASE_REPLICA_URL: 'own-replica' }, devDb)
    .DATABASE_REPLICA_URL,
  'own-replica'
);
check(
  'with no DB key of its own the worktree takes the root replica',
  appDatabaseEnv({}, devDb).DATABASE_REPLICA_URL,
  DEV_REPLICA
);

// --- the daemon: an app spawned in a worktree ---
const root = mkdtempSync(join(tmpdir(), 'dev-db-'));
const primary = join(root, 'primary');
const tree = join(root, 'worktrees', 'feature');
const appRel = join('apps', 'moderator');
for (const dir of [join(primary, appRel), join(tree, appRel)]) mkdirSync(dir, { recursive: true });
const primaryApp = join(primary, appRel, '.env');
const treeApp = join(tree, appRel, '.env');
const rootChain = [join(primary, '.env'), join(tree, '.env')];
const savedDb = process.env.DATABASE_URL;

try {
  writeFileSync(
    join(primary, '.env'),
    `DATABASE_URL=${DEV}\nDATABASE_REPLICA_URL=${DEV_REPLICA}\n`
  );
  writeFileSync(primaryApp, `APP=1\nDATABASE_URL=${PLANTED}\nDATABASE_REPLICA_URL=${PLANTED}\n`);
  writeFileSync(treeApp, 'APP=tree\n');
  const spawn = (worktree) =>
    new AppSession('moderator', worktree, 5174, [primaryApp, treeApp], rootChain).spawnEnv();

  const env = spawn(tree);
  check(
    'a worktree app with no DB key of its own gets the root DATABASE_URL',
    env.DATABASE_URL,
    DEV
  );
  check('... and the root DATABASE_REPLICA_URL', env.DATABASE_REPLICA_URL, DEV_REPLICA);
  check('... and the primary app value appears nowhere in its env', plantedIn(env), 0);
  check('... while the chain still layers every other key', env.APP, 'tree');
  check(
    'the primary checkout keeps its own app value',
    spawn(primaryCheckout).DATABASE_URL,
    PLANTED
  );

  writeFileSync(treeApp, `APP=tree\nDATABASE_URL=${PLANTED}\n`);
  check(
    "a worktree app's own DATABASE_URL is the opt-in and wins",
    spawn(tree).DATABASE_URL,
    PLANTED
  );
  check(
    '... and its replica follows it, not the root replica',
    spawn(tree).DATABASE_REPLICA_URL,
    PLANTED
  );

  writeFileSync(treeApp, 'APP=tree\n');
  writeFileSync(join(primary, '.env'), 'ROOT=1\n');
  process.env.DATABASE_URL = PLANTED;
  const unset = spawn(tree);
  check(
    'with no DB anywhere in the worktree the key is removed, not inherited',
    'DATABASE_URL' in unset,
    false
  );
  check('... not even from the daemon process env', plantedIn(unset), 0);
} finally {
  if (savedDb === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = savedDb;
  rmSync(root, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`dev-db: ${failures.length}/${checks} failed`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`dev-db: ${checks} checks passed`);
