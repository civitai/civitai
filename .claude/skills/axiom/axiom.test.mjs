// node --test .claude/skills/axiom/axiom.test.mjs
// Runs the CLI against a faked https.request. It never reaches Axiom and never reads a real .env:
// the CLI is copied three directories deep into a temp dir so load-env.mjs finds no .env above it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let root;
let cli;
let preload;

before(() => {
  root = mkdtempSync(join(tmpdir(), 'axiom-cli-'));
  const dir = join(root, 'a', 'b', 'c');
  mkdirSync(dir, { recursive: true });
  for (const f of ['axiom.mjs', 'load-env.mjs']) copyFileSync(join(here, f), join(dir, f));
  cli = join(dir, 'axiom.mjs');
  preload = join(dir, 'fake-https.mjs');
  writeFileSync(
    preload,
    `import https from 'https';
import { EventEmitter } from 'events';
https.request = (_options, cb) => {
  const req = new EventEmitter();
  req.write = () => {};
  req.end = () => {
    setImmediate(() => {
      const res = new EventEmitter();
      res.statusCode = Number(process.env.FAKE_STATUS);
      cb(res);
      res.emit('data', process.env.FAKE_BODY);
      res.emit('end');
    });
  };
  return req;
};
`
  );
});

after(() => rmSync(root, { recursive: true, force: true }));

function run(args, { status = 200, body = '{}', token = 'test-token' } = {}) {
  const r = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, cli, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, AXIOM_TOKEN: token, FAKE_STATUS: String(status), FAKE_BODY: body },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const UNAUTHORIZED = JSON.stringify({ message: 'unauthorized' });
const COMMANDS = [
  ['datasets'],
  ['dataset-info', 'logs'],
  ['query', "['logs'] | take 1"],
  ['search', 'logs', '--where', 'a == 1'],
  ['count', 'logs'],
  ['tail', 'logs'],
  ['top', 'logs', 'field'],
];

for (const cmd of COMMANDS) {
  for (const json of [false, true]) {
    const args = json ? [...cmd, '--json'] : cmd;
    test(`${cmd[0]}${json ? ' --json' : ''}: a 401 exits non-zero and names the status`, () => {
      const r = run(args, { status: 401, body: UNAUTHORIZED });
      assert.notEqual(r.code, 0);
      assert.match(r.err, /401/);
      if (json) assert.equal(JSON.parse(r.out).statusCode, 401); // callers can still parse stdout
    });
  }
}

test('a 500 with a non-JSON body exits non-zero', () => {
  const r = run(['datasets'], { status: 500, body: 'upstream down' });
  assert.notEqual(r.code, 0);
  assert.match(r.err, /500/);
});

for (const json of [false, true]) {
  test(`an empty AXIOM_TOKEN exits non-zero${json ? ' (--json)' : ''}`, () => {
    const r = run(json ? ['datasets', '--json'] : ['datasets'], { token: '' });
    assert.notEqual(r.code, 0);
    assert.match(r.err, /AXIOM_TOKEN/);
  });
}

test('control: a dataset list exits 0 and prints it', () => {
  const r = run(['datasets'], { body: JSON.stringify([{ name: 'logs', created: 'x' }]) });
  assert.equal(r.code, 0);
  assert.match(r.out, /logs/);
});

test('control: a real empty result exits 0, tabular and --json', () => {
  const body = JSON.stringify({ tables: [{ fields: [{ name: '_time', data: [] }] }], status: {} });
  const plain = run(['query', "['logs'] | take 1"], { body });
  assert.equal(plain.code, 0);
  assert.match(plain.out, /No results/);
  const json = run(['query', "['logs'] | take 1", '--json'], { body });
  assert.equal(json.code, 0);
  assert.deepEqual(JSON.parse(json.out).rows, []);
});
