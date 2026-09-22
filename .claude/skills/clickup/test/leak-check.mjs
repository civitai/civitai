#!/usr/bin/env node

/**
 * Leak check for the smoke suite, with no ClickUp calls at all.
 *
 * Copies smoke-test.mjs into a temp dir beside a fake query.mjs, runs it, and fails if
 * anything the suite created is still live when it exits. The fake answers `doc --json`
 * with an empty body, which is the response that used to kill the suite before cleanup.
 *
 *   node test/leak-check.mjs
 *
 * Exit 0: every created task, subtask, list and page was archived or deleted.
 * Exit 1: something was left live; the ids are printed.
 */

import { execFileSync } from 'child_process';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const FAKE_QUERY = `
import { existsSync, readFileSync, writeFileSync } from 'fs';
const [cmd, ...rest] = process.argv.slice(2);
const json = rest.includes('--json');
const statePath = process.env.LEAK_CHECK_STATE;
const live = new Set(existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : []);
const save = () => writeFileSync(statePath, JSON.stringify([...live]));
const newId = (prefix) => {
  const id = prefix + String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
  live.add(id);
  save();
  return id;
};

if (cmd === 'doc' && json) process.exit(0);
if (cmd === 'create-list') {
  console.log('List created\\n  ID: ' + newId('9'));
  process.exit(0);
}
if (json && (cmd === 'create' || cmd === 'subtask' || cmd === 'create-page')) {
  console.log(JSON.stringify({ id: newId(cmd === 'create-page' ? 'page' : 'task') }));
  process.exit(0);
}
if (json && cmd === 'comment') {
  console.log(JSON.stringify({ id: 'comment' }));
  process.exit(0);
}
if (cmd === 'archive' || cmd === 'delete-list') {
  live.delete(rest[0]);
  save();
}
if (cmd === 'unarchive') {
  live.add(rest[0]);
  save();
}
if (cmd === 'edit-page' && rest.includes('--archive')) {
  live.delete(rest[1]);
  save();
}
if (cmd === 'doc') console.log('Smoke Test doc\\n1 page(s)');
else console.log('fake ok archived restored updated resolved deleted');
`;

const dir = mkdtempSync(join(tmpdir(), 'clickup-leak-check-'));
mkdirSync(join(dir, 'test'));
copyFileSync(resolve(__dirname, 'smoke-test.mjs'), join(dir, 'test', 'smoke-test.mjs'));
writeFileSync(join(dir, 'query.mjs'), FAKE_QUERY);
const statePath = join(dir, 'live.json');
writeFileSync(statePath, '[]');

let output = '';
try {
  output = execFileSync('node', [join(dir, 'test', 'smoke-test.mjs')], {
    env: { ...process.env, LEAK_CHECK_STATE: statePath },
    encoding: 'utf8',
  });
} catch (err) {
  // The fake answers every read with junk, so most assertions fail; that is expected.
  output = (err.stdout || '') + (err.stderr || '');
}

const live = JSON.parse(readFileSync(statePath, 'utf8'));
rmSync(dir, { recursive: true, force: true });

if (live.length > 0) {
  console.log(`leak-check: FAILED, ${live.length} object(s) left live: ${live.join(', ')}`);
  console.log(output.slice(-2000));
  process.exit(1);
}
// Zero leaks from a run that created nothing would pass without testing anything.
const cleaned = (output.match(/  (Archived|Deleted) /g) || []).length;
if (cleaned === 0) {
  console.log('leak-check: the suite created and cleaned up nothing, so this run proved nothing. Output:');
  console.log(output.slice(-2000));
  process.exit(1);
}
console.log(`leak-check: ok, ${cleaned} created object(s) all cleaned up`);
