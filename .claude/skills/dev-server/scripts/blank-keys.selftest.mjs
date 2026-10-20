// The blanked keys keep their lines with an empty value in every copied .env, and a process the
// daemon spawns in a worktree (an app or the main app) gets them empty whatever its .env chain, its
// own .env files or the daemon's environment says.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as daemon from './daemon.mjs';

const { AppSession, primaryCheckout, spawnEnvFor } = daemon;
// A missing export fails its own check below instead of ending the run at import.
const worktreeEnvDir = daemon.worktreeEnvDir ?? (() => null);
import { blankEnvText } from './blank-keys.mjs';
import { redactedMismatch } from './selftest-redact.mjs';

const failures = [];
let checks = 0;

function check(name, actual, expected) {
  checks++;
  if (actual !== expected) failures.push(`${name}: ${redactedMismatch(actual, expected)}`);
}

const plantedIn = (values) => values.filter((v) => String(v).includes('planted-')).length;

// --- the text rewrite ---
const text =
  'A=1\nCSAM_UPLOAD_KEY=planted-key\n  export CSAM_UPLOAD_SECRET="planted-secret"\n' +
  '# CSAM_BUCKET_NAME=planted-bucket\nNOT_CSAM_KEY=kept\nCSAM_UPLOAD_REGION=\n';
const blanked = blankEnvText(text);
check(
  'every blanked key keeps its line, commented ones too, with an empty value',
  blanked.text,
  'A=1\nCSAM_UPLOAD_KEY=\n  export CSAM_UPLOAD_SECRET=\n# CSAM_BUCKET_NAME=\nNOT_CSAM_KEY=kept\nCSAM_UPLOAD_REGION=\n'
);
check('counts only the lines that had a value', blanked.changed, 3);
check('blanking a blanked file changes nothing', blankEnvText(blanked.text).changed, 0);
check(
  'keeps CRLF',
  blankEnvText('A=1\r\nCSAM_UPLOAD_KEY=planted-key\r\n').text,
  'A=1\r\nCSAM_UPLOAD_KEY=\r\n'
);
const none = 'A=1\nB=2\n';
check('a file with no blanked key comes back as is', blankEnvText(none).text, none);

// --- the daemon: an app spawned in a worktree ---
const root = mkdtempSync(join(tmpdir(), 'blank-keys-'));
const primary = join(root, 'primary');
const tree = join(root, 'worktrees', 'feature');
const appRel = join('apps', 'moderator');
for (const dir of [join(primary, appRel), join(tree, appRel)]) mkdirSync(dir, { recursive: true });
const primaryApp = join(primary, appRel, '.env');
const treeApp = join(tree, appRel, '.env');
const rootChain = [join(primary, '.env'), join(tree, '.env')];
const saved = process.env.CSAM_UPLOAD_SECRET;

try {
  writeFileSync(
    join(primary, '.env'),
    'DATABASE_URL=postgres://dev:dev@dev.example.invalid:5432/civitai\nCSAM_BUCKET_NAME=planted-bucket\n'
  );
  writeFileSync(primaryApp, 'APP=1\nCSAM_UPLOAD_KEY=planted-key\n');
  writeFileSync(treeApp, 'APP=tree\n');
  process.env.CSAM_UPLOAD_SECRET = 'planted-secret';
  const spawn = (worktree) =>
    new AppSession('moderator', worktree, 5174, [primaryApp, treeApp], rootChain).spawnEnv();

  const env = spawn(tree);
  check("a worktree app gets the primary app file's blanked key empty", env.CSAM_UPLOAD_KEY, '');
  check("... and the daemon process env's", env.CSAM_UPLOAD_SECRET, '');
  check('... and no planted value anywhere in its env', plantedIn(Object.values(env)), 0);
  check('... while the chain still layers every other key', env.APP, 'tree');

  writeFileSync(treeApp, 'APP=tree\nCSAM_UPLOAD_REGION=planted-region\n');
  check("a worktree app's own value is emptied too", spawn(tree).CSAM_UPLOAD_REGION, '');

  check(
    'the primary checkout keeps its own app value',
    spawn(primaryCheckout).CSAM_UPLOAD_KEY,
    'planted-key'
  );

  // Vite also reads .env.local and the development files, which the daemon's chain does not, so
  // their keys are emptied by name.
  writeFileSync(treeApp, 'APP=tree\n');
  writeFileSync(join(tree, appRel, '.env.local'), 'CSAM_BUCKET_NAME=planted-local\n');
  writeFileSync(
    join(tree, appRel, '.env.development.local'),
    '# CSAM_UPLOAD_ENDPOINT=planted-dev-local\n'
  );
  const local = spawn(tree);
  check("a worktree app's .env.local key is emptied by name", local.CSAM_BUCKET_NAME, '');
  check('... and a commented one in .env.development.local', local.CSAM_UPLOAD_ENDPOINT, '');

  // The main app in a worktree: `next dev` reads the same four files from the worktree root.
  writeFileSync(join(tree, '.env.local'), 'CSAM_UPLOAD_KEY=planted-main-local\n');
  check('the daemon exports worktreeEnvDir', typeof daemon.worktreeEnvDir, 'function');
  const main = spawnEnvFor(
    { CSAM_UPLOAD_REGION: 'planted-chain' },
    { blankedEnvDir: worktreeEnvDir(tree, tree) }
  );
  check('a worktree main app gets its chain value emptied', main.CSAM_UPLOAD_REGION, '');
  check('... and its root .env.local key, by name', main.CSAM_UPLOAD_KEY, '');
  check('... and no planted value anywhere in its env', plantedIn(Object.values(main)), 0);
  check(
    'the main app in the primary checkout has no blanked dir',
    worktreeEnvDir(primaryCheckout, primaryCheckout),
    null
  );
  // spawnEnvFor is half of it; the main app session has to pass the dir.
  const daemonSource = readFileSync(new URL('./daemon.mjs', import.meta.url), 'utf8');
  check(
    'the main app session passes its worktree as the blanked dir',
    daemonSource.includes(
      'spawnEnvFor(envVars, { blankedEnvDir: worktreeEnvDir(this.worktree, this.worktree) })'
    ),
    true
  );
} finally {
  if (saved === undefined) delete process.env.CSAM_UPLOAD_SECRET;
  else process.env.CSAM_UPLOAD_SECRET = saved;
  rmSync(root, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`blank-keys: ${failures.length}/${checks} failed`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`blank-keys: ${checks} checks passed`);
