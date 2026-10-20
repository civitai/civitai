// The blanked keys keep their lines with an empty value in every copied .env, and an app the daemon
// spawns in a worktree gets them empty whatever its .env chain or the daemon's environment says.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AppSession, primaryCheckout } from './daemon.mjs';
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
