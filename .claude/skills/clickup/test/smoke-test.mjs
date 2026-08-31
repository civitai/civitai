#!/usr/bin/env node

/**
 * ClickUp Skill Smoke Tests
 *
 * Runs live API tests against the ClickUp workspace to verify all commands work.
 * Creates test resources, validates them, then cleans up.
 *
 * Usage:
 *   node test/smoke-test.mjs              # Run all tests
 *   node test/smoke-test.mjs --readonly   # Skip write tests (safe for CI)
 *   node test/smoke-test.mjs --verbose    # Show full output from each command
 *
 * Prerequisites:
 *   - .env file configured with CLICKUP_API_TOKEN and CLICKUP_TEAM_ID
 *   - CLICKUP_DEFAULT_LIST_ID set (or provide a test list ID)
 */

import { execFile } from 'child_process';
import { writeFileSync, existsSync, unlinkSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const QUERY = resolve(__dirname, '..', 'query.mjs');

// Config
const VERBOSE = process.argv.includes('--verbose');
const READONLY = process.argv.includes('--readonly');

// Test infrastructure list (Meta - Infrastructure)
const TEST_LIST_ID = '901113123527';
const TEST_SPACE_ID = '90114072520';

// Persistent smoke test doc (created once, reused across runs)
// Pages created during tests are archived in cleanup
const PERSISTENT_DOC_ID = '825mr-17091';

// Tracking
let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];
const cleanupTasks = [];

// ─── Helpers ───────────────────────────────────────────────────────────

function run(args, { timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('node', [QUERY, ...args], { timeout }, (err, stdout, stderr) => {
      const output = (stdout || '') + (stderr || '');
      if (err && err.killed) {
        reject(new Error(`Timed out after ${timeout}ms`));
      } else {
        // Some commands exit(1) for usage errors - that's expected for validation tests
        resolve({ code: err?.code || 0, output: output.trim(), stdout: (stdout || '').trim(), stderr: (stderr || '').trim() });
      }
    });
  });
}

function runJson(args, options) {
  return run([...args, '--json'], options);
}

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, error: err.message });
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    if (VERBOSE) {
      console.log(`    Error: ${err.message}`);
    }
  }
}

function skip(name, reason = 'readonly mode') {
  skipped++;
  console.log(`  \x1b[33m○\x1b[0m ${name} (skipped: ${reason})`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertContains(text, substr, message) {
  if (!text.includes(substr)) {
    throw new Error(message || `Expected output to contain "${substr}", got: ${text.slice(0, 200)}`);
  }
}

function assertJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Expected valid JSON, got: ${text.slice(0, 200)}`);
  }
}

// ─── Read-only Tests ───────────────────────────────────────────────────

async function readOnlyTests() {
  console.log('\n\x1b[1mRead-only Tests\x1b[0m');

  await test('help: shows usage', async () => {
    const { output } = await run([]);
    assertContains(output, 'Usage:');
    assertContains(output, 'Task Commands:');
    assertContains(output, 'Document Commands:');
    assertContains(output, 'List Commands:');
  });

  await test('me: returns user info', async () => {
    const { output } = await run(['me']);
    assertContains(output, 'User:');
    assertContains(output, 'ID:');
    assertContains(output, 'Email:');
  });

  await test('me --json: returns valid JSON', async () => {
    const { stdout } = await runJson(['me']);
    const data = assertJson(stdout);
    assert(data.id, 'Expected user ID');
    assert(data.username, 'Expected username');
  });

  await test('my-tasks: lists assigned tasks', async () => {
    const { output } = await run(['my-tasks']);
    // Should contain at least "Total: X task(s)" or list some tasks
    assert(output.includes('task(s)') || output.includes('ID:'), 'Expected task listing');
  });

  await test('tasks: lists tasks in a list', async () => {
    const { output } = await run(['tasks', TEST_LIST_ID]);
    assert(output.includes('task(s)') || output.includes('ID:'), 'Expected task listing');
  });

  await test('docs: lists workspace docs', async () => {
    const { output } = await run(['docs']);
    assertContains(output, 'doc(s)');
  });

  await test('docs --json: returns valid JSON', async () => {
    const { stdout } = await runJson(['docs']);
    const data = assertJson(stdout);
    assert(Array.isArray(data.docs || data), 'Expected docs array');
  });

  await test('space-lists: lists folderless lists', async () => {
    const { output } = await run(['space-lists', TEST_SPACE_ID]);
    // May have 0 lists, that's ok - should not error
    assert(output.includes('list(s)') || output.includes('No folderless lists'), 'Expected list result');
  });

  await test('get: handles missing task ID', async () => {
    const { output, code } = await run(['get']);
    assert(code !== 0, 'Expected non-zero exit');
    assertContains(output, 'Usage:');
  });

  await test('comment: handles missing text', async () => {
    const { output, code } = await run(['comment', 'fakeid']);
    assert(code !== 0, 'Expected non-zero exit');
    assertContains(output, 'Error');
  });
}

// ─── Write Tests ──────────────────────────────────────────────────────

async function writeTests() {
  console.log('\n\x1b[1mWrite Tests (create → verify → cleanup)\x1b[0m');

  let testTaskId = null;
  let testSubtaskId = null;
  let testCommentId = null;
  let testListId = null;
  const testPageIds = [];  // Track pages to archive in cleanup

  // ── Task CRUD ──

  await test('create: creates a task', async () => {
    const { stdout } = await runJson(['create', TEST_LIST_ID, 'SMOKE TEST: Delete me']);
    const data = assertJson(stdout);
    testTaskId = data.id;
    assert(testTaskId, 'Expected task ID in response');
    cleanupTasks.push({ type: 'task', id: testTaskId });
    if (VERBOSE) console.log(`    Created task: ${testTaskId}`);
  });

  if (!testTaskId) {
    skip('Remaining write tests', 'task creation failed');
    return;
  }

  await test('get: retrieves created task', async () => {
    const { output } = await run(['get', testTaskId]);
    assertContains(output, 'SMOKE TEST: Delete me');
    assertContains(output, testTaskId);
  });

  await test('get --json: returns full task JSON', async () => {
    const { stdout } = await runJson(['get', testTaskId]);
    const data = assertJson(stdout);
    assert(data.id === testTaskId, 'Task ID mismatch');
    assert(data.name === 'SMOKE TEST: Delete me', 'Task name mismatch');
  });

  await test('rename: renames a task', async () => {
    const { output } = await run(['rename', testTaskId, 'SMOKE TEST: Renamed']);
    assertContains(output, 'Renamed');
  });

  await test('priority: sets priority', async () => {
    const { output } = await run(['priority', testTaskId, 'high']);
    assertContains(output, 'high');
  });

  await test('due: sets due date', async () => {
    const { output } = await run(['due', testTaskId, 'tomorrow']);
    assertContains(output, 'Due date set');
  });

  await test('start: sets start date', async () => {
    const { output } = await run(['start', testTaskId, 'today']);
    assertContains(output, 'Start date set');
  });

  await test('tag: adds a tag', async () => {
    const { output } = await run(['tag', testTaskId, 'smoke-test']);
    assertContains(output, 'added');
  });

  await test('remove-tag: removes a tag', async () => {
    const { output } = await run(['remove-tag', testTaskId, 'smoke-test']);
    assertContains(output, 'removed');
  });

  await test('description: updates description', async () => {
    const { output } = await run(['description', testTaskId, 'Test description\\nWith newline']);
    assertContains(output, 'description updated');
  });

  // ── File-based Content ──

  const tmpFile = resolve(__dirname, '.tmp-smoke-test.md');
  const tmpFileCleanup = resolve(__dirname, '.tmp-smoke-cleanup.md');

  await test('--file: posts comment from file', async () => {
    writeFileSync(tmpFile, '# File-based Comment\n\nThis comment was loaded from a markdown file.\n\n- Item 1\n- Item 2\n');
    const { stdout } = await runJson(['comment', testTaskId, '--file', tmpFile]);
    const data = assertJson(stdout);
    assert(data.id, 'Expected comment ID');
    // Clean up the comment
    await run(['delete-comment', data.id]);
    // Clean up the temp file
    unlinkSync(tmpFile);
  });

  await test('--file --cleanup: deletes file after success', async () => {
    writeFileSync(tmpFileCleanup, 'Cleanup test content');
    const { output } = await run(['description', testTaskId, '--file', tmpFileCleanup, '--cleanup']);
    assertContains(output, 'description updated');
    assert(!existsSync(tmpFileCleanup), 'Expected temp file to be deleted after --cleanup');
  });

  await test('--file: handles missing file', async () => {
    const { output, code } = await run(['comment', testTaskId, '--file', '/nonexistent/path.md']);
    assert(code !== 0, 'Expected non-zero exit');
    assertContains(output, 'not found');
  });

  // ── Comments ──

  await test('comment: posts a comment', async () => {
    const { stdout } = await runJson(['comment', testTaskId, 'Smoke test comment']);
    const data = assertJson(stdout);
    testCommentId = data.id;
    assert(testCommentId, 'Expected comment ID');
    if (VERBOSE) console.log(`    Created comment: ${testCommentId}`);
  });

  await test('comments: lists comments', async () => {
    const { output } = await run(['comments', testTaskId]);
    assertContains(output, 'Smoke test comment');
  });

  if (testCommentId) {
    await test('update-comment: updates comment text', async () => {
      const { output } = await run(['update-comment', testCommentId, 'Updated smoke test comment']);
      assertContains(output, 'updated');
    });

    await test('resolve-comment: resolves comment', async () => {
      const { output } = await run(['resolve-comment', testCommentId]);
      assertContains(output, 'resolved');
    });

    await test('delete-comment: deletes comment', async () => {
      const { output } = await run(['delete-comment', testCommentId]);
      assertContains(output, 'deleted');
      testCommentId = null;
    });
  }

  // ── @Mentions ──

  await test('mention: posts comment with @[username] mention', async () => {
    const { stdout } = await runJson(['comment', testTaskId, 'SMOKE TEST: Hey @[justin], take a look']);
    const data = assertJson(stdout);
    assert(data.id, 'Expected comment ID');
    // Clean up
    await run(['delete-comment', data.id]);
  });

  await test('mention: unknown user throws clear error', async () => {
    const { output, code } = await run(['comment', testTaskId, 'SMOKE TEST: @[nonexistentuser99999xyz]']);
    assert(code !== 0, 'Expected non-zero exit for unknown user');
    assertContains(output, 'Could not find user');
  });

  await test('mention: plain comment without mentions still works', async () => {
    const { stdout } = await runJson(['comment', testTaskId, 'SMOKE TEST: No mentions here']);
    const data = assertJson(stdout);
    assert(data.id, 'Expected comment ID');
    // Clean up
    await run(['delete-comment', data.id]);
  });

  // ── Checklist ──

  await test('checklist: adds checklist item', async () => {
    const { output } = await run(['checklist', testTaskId, 'Test checklist item']);
    assertContains(output, 'checklist');
  });

  // ── Subtasks ──

  await test('subtask: creates subtask', async () => {
    const { stdout } = await runJson(['subtask', testTaskId, 'SMOKE TEST subtask']);
    const data = assertJson(stdout);
    testSubtaskId = data.id;
    assert(testSubtaskId, 'Expected subtask ID');
    cleanupTasks.push({ type: 'task', id: testSubtaskId });
  });

  await test('get --subtasks: shows subtasks', async () => {
    const { output } = await run(['get', testTaskId, '--subtasks']);
    assertContains(output, 'Subtask');
  });

  // ── List CRUD ──

  await test('create-list: creates a list', async () => {
    const { output } = await run(['create-list', TEST_SPACE_ID, 'SMOKE TEST: Delete me']);
    assertContains(output, 'List created');
    const match = output.match(/ID:\s*(\d+)/);
    assert(match, 'Expected list ID in output');
    testListId = match[1];
    cleanupTasks.push({ type: 'list', id: testListId });
    if (VERBOSE) console.log(`    Created list: ${testListId}`);
  });

  if (testListId) {
    await test('list: retrieves list details', async () => {
      const { output } = await run(['list', testListId]);
      assertContains(output, 'SMOKE TEST');
    });

    await test('update-list: renames a list', async () => {
      const { output } = await run(['update-list', testListId, '--name', 'SMOKE TEST: Renamed list']);
      assertContains(output, 'updated');
    });
  }

  // ── Doc CRUD (uses persistent doc to avoid orphaned docs) ──

  const testDocId = PERSISTENT_DOC_ID;

  await test('doc: retrieves doc details', async () => {
    const { output } = await run(['doc', testDocId]);
    assertContains(output, 'Smoke Test');
    assertContains(output, 'page(s)');
  });

  await test('doc --json: page listing', async () => {
    const { stdout } = await runJson(['doc', testDocId]);
    const data = assertJson(stdout);
    assert(data.pages && data.pages.length > 0, 'Expected at least one page');
  });

  // Get the first page to test page read
  const { stdout: docJson } = await runJson(['doc', testDocId]);
  const docData = JSON.parse(docJson);
  const firstPageId = docData.pages?.[0]?.id;

  if (firstPageId) {
    await test('page: reads page content', async () => {
      const { output } = await run(['page', testDocId, firstPageId]);
      assertContains(output, 'Content:');
    });
  }

  await test('create-page: adds new page to doc', async () => {
    const { stdout } = await runJson(['create-page', testDocId, 'SMOKE TEST Page', '--content', '## Test\\nCreated by smoke test']);
    const data = assertJson(stdout);
    assert(data.id, 'Expected page ID');
    testPageIds.push(data.id);
    if (VERBOSE) console.log(`    Created page: ${data.id}`);
  });

  if (testPageIds.length > 0) {
    await test('edit-page: updates page content', async () => {
      const { output } = await run(['edit-page', testDocId, testPageIds[0], '--content', '# Updated\\nEdited by smoke test', '--name', 'SMOKE TEST Page (edited)']);
      assertContains(output, 'updated');
    });
  }


  // ── Archive/Unarchive ──

  await test('archive: archives a task', async () => {
    const { output } = await run(['archive', testTaskId]);
    assertContains(output, 'archived');
  });

  await test('unarchive: restores a task', async () => {
    const { output } = await run(['unarchive', testTaskId]);
    assertContains(output, 'restored');
  });

  return { testPageIds };
}

// ─── Cleanup ───────────────────────────────────────────────────────────

async function cleanup(testPageIds = []) {
  console.log('\n\x1b[1mCleanup\x1b[0m');

  // Archive test pages created during doc CRUD tests
  for (const pageId of testPageIds) {
    try {
      await run(['edit-page', PERSISTENT_DOC_ID, pageId, '--archive']);
      console.log(`  Archived page ${pageId}`);
    } catch (err) {
      console.log(`  ⚠ Failed to archive page ${pageId}: ${err.message}`);
    }
  }

  for (const item of cleanupTasks.reverse()) {
    try {
      if (item.type === 'task') {
        await run(['archive', item.id]);
        console.log(`  Archived task ${item.id}`);
      } else if (item.type === 'list') {
        await run(['delete-list', item.id]);
        console.log(`  Deleted list ${item.id}`);
      }
    } catch (err) {
      console.log(`  ⚠ Failed to clean up ${item.type} ${item.id}: ${err.message}`);
    }
  }
}

// ─── Main ──────────────────────────────────────────────────────────────

async function main() {
  console.log('ClickUp Skill Smoke Tests');
  console.log('========================');
  console.log(`Mode: ${READONLY ? 'read-only' : 'full (read + write)'}`);

  await readOnlyTests();

  if (!READONLY) {
    const { testPageIds } = await writeTests();
    await cleanup(testPageIds);
  }

  // Summary
  console.log('\n\x1b[1mResults\x1b[0m');
  console.log(`  Passed:  ${passed}`);
  if (failed > 0) console.log(`  \x1b[31mFailed:  ${failed}\x1b[0m`);
  if (skipped > 0) console.log(`  Skipped: ${skipped}`);

  if (failures.length > 0) {
    console.log('\n\x1b[31mFailures:\x1b[0m');
    for (const f of failures) {
      console.log(`  - ${f.name}: ${f.error}`);
    }
  }

  console.log('');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(2);
});
