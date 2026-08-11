#!/usr/bin/env node

/**
 * Prompt Analysis Manager
 *
 * Inspect and update the orchestrator's per-ecosystem prompt-analysis guides
 * (`/v1/manager/prompt-analysis/*` admin endpoints).
 *
 * Usage:
 *   node .claude/skills/add-prompt-enhancement-guide/manage.mjs list
 *   node .claude/skills/add-prompt-enhancement-guide/manage.mjs status
 *   node .claude/skills/add-prompt-enhancement-guide/manage.mjs get <ecosystem> [--prompt-only]
 *   node .claude/skills/add-prompt-enhancement-guide/manage.mjs defaults <ecosystem>
 *   node .claude/skills/add-prompt-enhancement-guide/manage.mjs register <ecosystem> --writable
 *   node .claude/skills/add-prompt-enhancement-guide/manage.mjs put <ecosystem> --prompt-file guide.txt --writable
 *   node .claude/skills/add-prompt-enhancement-guide/manage.mjs reset <ecosystem> --writable
 *   node .claude/skills/add-prompt-enhancement-guide/manage.mjs delete <ecosystem> --writable
 *
 * Two orchestrator behaviors this wraps around:
 *
 * 1. A GET registers. PromptAnalysisGrain.GetPromptAnalysisRequestAsync calls
 *    EnsureRegisteredAsync, so reading an ecosystem that was never registered
 *    adds it to the registry with default config. There is no way to probe
 *    without writing — `status` is the safe way to see what exists.
 * 2. Only POST lowercases the key. GET/PUT/DELETE address the Orleans grain by
 *    the exact string in the path, so `MiniMaxH3` and `minimaxh3` are separate
 *    configs. Keys are lowercased here; --raw-key targets an odd-cased entry
 *    (needed to delete one).
 *
 * Options:
 *   --writable        Allow state-changing operations (register / put / reset / delete)
 *   --prompt-file     Path to a plain-text system prompt (put)
 *   --file, -f        Path to a full JSON body (put) — alternative to --prompt-file
 *   --model, -m       Model id for put; defaults to the ecosystem's current value
 *   --prompt-only     Print just the systemPrompt (get)
 *   --raw-key         Do not lowercase the ecosystem argument
 *   --output, -o      Save response to file instead of stdout
 *   --quiet, -q       Only print the response body
 *   --timeout, -t     Request timeout in seconds (default: 30)
 *
 * Env (from project .env):
 *   ORCHESTRATOR_ENDPOINT      base URL of the orchestrator
 *   ORCHESTRATOR_ACCESS_TOKEN  system bearer token
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const skillDir = __dirname;
const projectRoot = resolve(__dirname, '../../..');

function loadEnv() {
  const envFiles = [resolve(skillDir, '.env'), resolve(projectRoot, '.env')];
  for (const envPath of envFiles) {
    try {
      const envContent = readFileSync(envPath, 'utf-8');
      for (const line of envContent.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIndex = trimmed.indexOf('=');
        if (eqIndex === -1) continue;
        const key = trimmed.slice(0, eqIndex);
        const value = trimmed.slice(eqIndex + 1);
        if (!process.env[key]) process.env[key] = value;
      }
    } catch {
      // file not found, continue
    }
  }
}
loadEnv();

const DEFAULT_TIMEOUT_SECONDS = 30;
const BASE_PATH = '/v1/manager/prompt-analysis';
const WRITE_COMMANDS = new Set([
  'register',
  'put',
  'set-model',
  'set-samples',
  'reset',
  'delete',
  'import',
]);
const ECOSYSTEM_COMMANDS = new Set([
  'get',
  'defaults',
  'register',
  'put',
  'set-model',
  'set-samples',
  'reset',
  'delete',
]);

const args = process.argv.slice(2);
let writable = false;
let filePath = '';
let promptFilePath = '';
let modelId = '';
let promptOnly = false;
let rawKey = false;
let force = false;
let clearSamples = false;
let dryRun = false;
let outputPath = '';
let quiet = false;
let timeoutSeconds = DEFAULT_TIMEOUT_SECONDS;
const positional = [];

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--writable') {
    writable = true;
  } else if (arg === '--file' || arg === '-f') {
    filePath = args[++i] || '';
  } else if (arg === '--prompt-file') {
    promptFilePath = args[++i] || '';
  } else if (arg === '--model' || arg === '-m') {
    modelId = args[++i] || '';
  } else if (arg === '--prompt-only') {
    promptOnly = true;
  } else if (arg === '--raw-key') {
    rawKey = true;
  } else if (arg === '--dry-run') {
    dryRun = true;
  } else if (arg === '--clear-samples') {
    clearSamples = true;
  } else if (arg === '--force') {
    force = true;
  } else if (arg === '--output' || arg === '-o') {
    outputPath = args[++i] || '';
  } else if (arg === '--quiet' || arg === '-q') {
    quiet = true;
  } else if (arg === '--timeout' || arg === '-t') {
    const val = args[++i];
    if (!val || isNaN(parseInt(val, 10))) {
      console.error('Error: --timeout requires a number (seconds)');
      process.exit(1);
    }
    timeoutSeconds = parseInt(val, 10);
  } else if (!arg.startsWith('-')) {
    positional.push(arg);
  } else {
    console.error(`Unknown option: ${arg}`);
    process.exit(1);
  }
}

const command = positional[0] || '';

function usage(msg) {
  if (msg) console.error(`Error: ${msg}\n`);
  console.error(
    `Usage: node manage.mjs <command> [ecosystem] [options]

Commands:
  list                     GET registered ecosystem names
  status                   list + per-ecosystem custom/default, model, sample count
  get <ecosystem>          GET the live config (registers it if absent — see below)
  defaults <ecosystem>     GET the built-in default config
  register <ecosystem>     POST register (requires --writable)
  put <ecosystem>          PUT config (requires --writable + --prompt-file or --file)
  set-model <ecosystem>    Rebind the analysis model, keeping the guide as-is
                           (requires --writable + --model)
  set-samples <ecosystem>  Replace the few-shot samples, keeping the guide as-is
                           (requires --writable + --file or --clear-samples)
  export                   Snapshot every ecosystem's config to JSON (for revert)
  import                   Restore from a snapshot (requires --writable + --file)
  reset <ecosystem>        POST reset to defaults (requires --writable)
  delete <ecosystem>       DELETE from the registry (requires --writable)

Options:
  --writable               Allow register / put / reset / delete
  --prompt-file <path>     Plain-text system prompt for put
  --file, -f <path>        Full JSON body for put (alternative to --prompt-file)
  --model, -m <id>         Model id for put (default: keep the ecosystem's current value)
  --clear-samples          Drop existing few-shot samples (put / set-samples)
  --dry-run                import: report what would change, write nothing
  --prompt-only            get: print only the systemPrompt
  --raw-key                Do not lowercase the ecosystem argument
  --output, -o <path>      Save response to file
  --quiet, -q              Only print response body
  --timeout, -t <s>        Request timeout in seconds (default: ${DEFAULT_TIMEOUT_SECONDS})

Note: a GET registers the ecosystem as a side effect, so \`get\` on a name that
was never set up adds it to the registry with default config. Use \`status\` to
see what exists without creating anything.

Examples:
  node manage.mjs status
  node manage.mjs get flux1 --prompt-only
  node manage.mjs put minimaxh3 --prompt-file guide.txt --writable
  node manage.mjs delete MiniMaxH3 --raw-key --writable`
  );
  process.exit(1);
}

if (!command) usage();

let ecosystem = '';
if (ECOSYSTEM_COMMANDS.has(command)) {
  ecosystem = positional[1] || '';
  if (!ecosystem) usage(`Command "${command}" requires an ecosystem argument`);
  if (!rawKey) ecosystem = ecosystem.toLowerCase();
} else if (!['list', 'status', 'export', 'import'].includes(command)) {
  usage(`Unknown command: ${command}`);
}

if (WRITE_COMMANDS.has(command) && !writable && !dryRun) {
  usage(
    `Command "${command}" changes orchestrator state — pass --writable to confirm.\n` +
      `This affects every subsequent prompt-analysis call for "${ecosystem}".`
  );
}

if (command === 'put' && !filePath && !promptFilePath) {
  usage('Command "put" requires --prompt-file <path> or --file <path>.');
}

if (command === 'set-model' && !modelId) {
  usage('Command "set-model" requires --model <id>.');
}

if (command === 'import' && !filePath) {
  usage('Command "import" requires --file <path> (an export produced by this tool).');
}

if (command === 'set-samples' && !filePath && !clearSamples) {
  usage('Command "set-samples" requires --file <path> (a JSON array) or --clear-samples.');
}

const endpoint = process.env.ORCHESTRATOR_ENDPOINT;
const token = process.env.ORCHESTRATOR_ACCESS_TOKEN;
if (!endpoint) {
  console.error('Error: ORCHESTRATOR_ENDPOINT is not set in env (.env)');
  process.exit(1);
}
if (!token) {
  console.error('Error: ORCHESTRATOR_ACCESS_TOKEN is not set in env (.env)');
  process.exit(1);
}

const headers = { Authorization: `Bearer ${token}` };

async function request(method, path, body) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutSeconds * 1000);

  let res;
  try {
    res = await fetch(`${endpoint}${path}`, {
      method,
      signal: controller.signal,
      headers: {
        ...headers,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    clearTimeout(timeoutId);
    if (e.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutSeconds} seconds`);
    }
    throw e;
  }
  clearTimeout(timeoutId);

  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }

  if (!res.ok) {
    const detail =
      parsed == null ? '' : typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
    throw new Error(`HTTP ${res.status} ${res.statusText} ${detail}`.trim());
  }

  return parsed;
}

function readJsonBody() {
  let raw;
  try {
    raw = readFileSync(resolve(process.cwd(), filePath), 'utf-8');
  } catch (e) {
    console.error(`Error reading body file ${filePath}: ${e.message}`);
    process.exit(1);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error(`Error: --file ${filePath} is not valid JSON: ${e.message}`);
    process.exit(1);
  }
}

function readPromptFile() {
  try {
    return readFileSync(resolve(process.cwd(), promptFilePath), 'utf-8').trim();
  } catch (e) {
    console.error(`Error reading prompt file ${promptFilePath}: ${e.message}`);
    process.exit(1);
  }
}

function emit(value) {
  const output = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (outputPath) {
    writeFileSync(resolve(process.cwd(), outputPath), output);
    if (!quiet) console.error(`Saved response to ${outputPath}`);
  } else {
    console.log(output);
  }
}

async function runStatus() {
  const names = await request('GET', BASE_PATH);
  const defaultPrompt = (
    await request('GET', `${BASE_PATH}/${encodeURIComponent(names[0] ?? 'x')}/default`)
  )?.systemPrompt;

  const rows = [];
  for (const name of names) {
    const config = await request('GET', `${BASE_PATH}/${encodeURIComponent(name)}`);
    rows.push({
      ecosystem: name,
      guide: config.systemPrompt === defaultPrompt ? 'default' : 'custom',
      modelId: config.modelId,
      samples: config.samples?.length ?? 0,
      promptChars: config.systemPrompt?.length ?? 0,
    });
  }

  rows.sort((a, b) =>
    a.guide === b.guide ? a.ecosystem.localeCompare(b.ecosystem) : a.guide === 'custom' ? -1 : 1
  );

  if (outputPath) {
    emit(rows);
    return;
  }

  const width = Math.max(...rows.map((r) => r.ecosystem.length), 9);
  console.log(`${'ecosystem'.padEnd(width)}  guide    chars  samples  modelId`);
  for (const r of rows) {
    console.log(
      `${r.ecosystem.padEnd(width)}  ${r.guide.padEnd(7)}  ${String(r.promptChars).padStart(
        5
      )}  ${String(r.samples).padStart(7)}  ${r.modelId}`
    );
  }
  const custom = rows.filter((r) => r.guide === 'custom').length;
  console.error(
    `\n${rows.length} registered, ${custom} custom, ${rows.length - custom} on the built-in default`
  );
}

async function runPut() {
  const path = `${BASE_PATH}/${encodeURIComponent(ecosystem)}`;
  const body = filePath ? readJsonBody() : { systemPrompt: readPromptFile() };

  if (modelId) body.modelId = modelId;

  // PUT replaces the whole config, so anything the caller did not supply has to
  // be carried over explicitly or it is destroyed.
  if (!body.modelId || (body.samples === undefined && !clearSamples)) {
    const current = await request('GET', path);
    if (!body.modelId) {
      body.modelId = current.modelId;
      if (!quiet) console.error(`Keeping current modelId: ${body.modelId}`);
    }
    if (body.samples === undefined && !clearSamples) {
      body.samples = current.samples ?? [];
      if (body.samples.length && !quiet) {
        console.error(
          `Keeping ${body.samples.length} existing sample(s) — --clear-samples to drop them`
        );
      }
    }
  }
  if (clearSamples) body.samples = [];

  await request('PUT', path, body);

  const ok = await verifyWrite(path, body.systemPrompt, body.samples?.length ?? 0);
  console.error(
    ok
      ? `✓ ${ecosystem} updated and verified (${body.systemPrompt.length} chars, ${
          body.samples?.length ?? 0
        } sample(s))`
      : `✗ ${ecosystem} readback does not match what was sent — re-check with \`status\` before rewriting`
  );
  if (!ok) process.exit(1);
}

async function runExport() {
  const names = await request('GET', BASE_PATH);
  const ecosystems = [];
  for (const name of names) {
    const config = await request('GET', `${BASE_PATH}/${encodeURIComponent(name)}`);
    ecosystems.push({
      ecosystem: name,
      systemPrompt: config.systemPrompt,
      modelId: config.modelId,
      samples: config.samples ?? [],
    });
  }

  const builtIn = await request(
    'GET',
    `${BASE_PATH}/${encodeURIComponent(names[0] ?? 'x')}/default`
  );
  const custom = ecosystems.filter((e) => e.systemPrompt !== builtIn.systemPrompt).length;

  emit({
    exportedAt: new Date().toISOString(),
    endpoint,
    note: 'Point-in-time snapshot for reverting. NOT a source of truth — the orchestrator is. Re-importing wholesale will overwrite anything edited since.',
    defaultSystemPrompt: builtIn.systemPrompt,
    ecosystems,
  });
  console.error(`Exported ${ecosystems.length} ecosystems (${custom} with a custom guide)`);
}

async function runImport() {
  const backup = readJsonBody();
  const list = Array.isArray(backup) ? backup : backup.ecosystems;
  if (!Array.isArray(list)) {
    console.error(
      'Error: --file must be an export produced by this tool, or a JSON array of configs'
    );
    process.exit(1);
  }

  const builtIn = backup.defaultSystemPrompt;
  let written = 0;
  const skipped = [];

  for (const entry of list) {
    if (!entry?.ecosystem || !entry.systemPrompt) {
      console.error(`Skipping malformed entry: ${JSON.stringify(entry)?.slice(0, 80)}`);
      continue;
    }
    // Restoring a fallback-serving entry would freeze that text as its permanent
    // guide — the same trap set-model guards against.
    if (builtIn && entry.systemPrompt === builtIn && !force) {
      skipped.push(entry.ecosystem);
      continue;
    }
    if (dryRun) {
      const live = await request('GET', `${BASE_PATH}/${encodeURIComponent(entry.ecosystem)}`);
      const changes = [];
      if (live.systemPrompt !== entry.systemPrompt)
        changes.push(`guide ${live.systemPrompt.length} -> ${entry.systemPrompt.length} chars`);
      if (live.modelId !== entry.modelId) changes.push(`model ${live.modelId} -> ${entry.modelId}`);
      if ((live.samples?.length ?? 0) !== (entry.samples?.length ?? 0))
        changes.push(`samples ${live.samples?.length ?? 0} -> ${entry.samples?.length ?? 0}`);
      if (changes.length) {
        console.error(`  ${entry.ecosystem}: ${changes.join(', ')}`);
        written++;
      }
      continue;
    }

    await request('PUT', `${BASE_PATH}/${encodeURIComponent(entry.ecosystem)}`, {
      systemPrompt: entry.systemPrompt,
      modelId: entry.modelId,
      samples: entry.samples ?? [],
    });
    console.error(`  restored ${entry.ecosystem}`);
    written++;
  }

  console.error(
    dryRun ? `\n${written} ecosystem(s) would change` : `\n✓ restored ${written} ecosystem(s)`
  );
  if (skipped.length) {
    console.error(
      `skipped ${skipped.length} that were serving the built-in default (--force to write them as frozen copies)`
    );
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * PUT replaces the whole config, so `set-samples` has to send a systemPrompt it did not
 * author. Reads can lag a write by up to a minute, so a GET taken right after someone
 * else's `put` returns the *previous* guide — and writing that back silently reverts it.
 * Observed on `seedance`: a verified 2588-char deploy was reinstated as the old 2659-char
 * guide by the very next `set-samples`.
 *
 * Two consecutive agreeing reads mean nothing is in flight. `--prompt-file` skips the
 * problem entirely by making the guide explicit.
 */
/**
 * Reads lag writes, so a single readback reports both false failures and false successes.
 * Poll instead of asserting once — a mismatch only counts after the value has had time
 * to settle.
 */
async function verifyWrite(path, expectedPrompt, expectedSampleCount) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const v = await request('GET', path);
    if (v.systemPrompt === expectedPrompt && (v.samples?.length ?? 0) === expectedSampleCount) {
      return true;
    }
    await sleep(5000);
  }
  return false;
}

async function readStableConfig(path) {
  const first = await request('GET', path);
  await sleep(3000);
  const second = await request('GET', path);
  if (first.systemPrompt !== second.systemPrompt) return null;
  return second;
}

async function runSetSamples() {
  const path = `${BASE_PATH}/${encodeURIComponent(ecosystem)}`;
  const samples = clearSamples ? [] : readJsonBody();

  let current;
  if (promptFilePath) {
    current = { systemPrompt: readPromptFile(), modelId: (await request('GET', path)).modelId };
  } else {
    current = await readStableConfig(path);
    if (!current) {
      console.error(
        `✗ ${ecosystem}: the stored guide is still changing between reads — a write is in flight.\n` +
          `  Writing samples now would reinstate whichever guide this command happened to read.\n` +
          `  Wait a minute and retry, or pass --prompt-file <guide> to state the guide explicitly.`
      );
      process.exit(1);
    }
  }

  if (!Array.isArray(samples)) {
    console.error(
      'Error: --file must contain a JSON array of { prompt, negativePrompt?, assistantResponse }'
    );
    process.exit(1);
  }

  for (const [i, s] of samples.entries()) {
    if (!s?.prompt || !s?.assistantResponse) {
      console.error(`Error: sample ${i} needs both "prompt" and "assistantResponse"`);
      process.exit(1);
    }
    try {
      JSON.parse(s.assistantResponse);
    } catch {
      console.error(
        `Error: sample ${i} assistantResponse is not valid JSON. It is replayed as an assistant turn\n` +
          `under a strict json_schema response format, so it must match that schema exactly.`
      );
      process.exit(1);
    }
  }

  await request('PUT', path, {
    systemPrompt: current.systemPrompt,
    modelId: modelId || current.modelId,
    samples,
  });

  const ok = await verifyWrite(path, current.systemPrompt, samples.length);
  console.error(
    ok
      ? `✓ ${ecosystem}: ${current.samples?.length ?? 0} -> ${
          samples.length
        } sample(s) (guide unchanged)`
      : `✗ ${ecosystem} readback does not match what was sent — re-check with \`status\` before rewriting`
  );
  if (!ok) process.exit(1);
}

async function runSetModel() {
  const path = `${BASE_PATH}/${encodeURIComponent(ecosystem)}`;
  const current = await request('GET', path);

  if (current.modelId === modelId) {
    console.error(`${ecosystem} is already on ${modelId} — nothing to do`);
    return;
  }

  const builtIn = await request('GET', `${path}/default`);
  if (current.systemPrompt === builtIn.systemPrompt && !force) {
    console.error(
      `Refusing: ${ecosystem} has no guide of its own — it is serving the built-in default.\n` +
        `Writing a model id here would freeze today's fallback text as this ecosystem's\n` +
        `permanent guide, so later changes to the built-in default would stop reaching it.\n` +
        `Change PromptAnalysisGrain.DefaultModelId in civitai-orchestration instead, or pass\n` +
        `--force if you really want a frozen copy.`
    );
    process.exit(1);
  }

  await request('PUT', path, {
    systemPrompt: current.systemPrompt,
    modelId,
    samples: current.samples ?? [],
  });

  const verify = await request('GET', path);
  const ok = verify.modelId === modelId && verify.systemPrompt === current.systemPrompt;
  console.error(
    ok
      ? `✓ ${ecosystem}: ${current.modelId} -> ${verify.modelId} (guide unchanged, ${verify.systemPrompt.length} chars)`
      : `✗ ${ecosystem} readback does not match what was sent`
  );
  if (!ok) process.exit(1);
}

async function main() {
  try {
    switch (command) {
      case 'list':
        emit(await request('GET', BASE_PATH));
        break;
      case 'status':
        await runStatus();
        break;
      case 'get': {
        const config = await request('GET', `${BASE_PATH}/${encodeURIComponent(ecosystem)}`);
        emit(promptOnly ? config.systemPrompt : config);
        break;
      }
      case 'defaults':
        emit(await request('GET', `${BASE_PATH}/${encodeURIComponent(ecosystem)}/default`));
        break;
      case 'register':
        await request('POST', BASE_PATH, { ecosystem });
        console.error(`✓ registered ${ecosystem}`);
        break;
      case 'put':
        await runPut();
        break;
      case 'export':
        await runExport();
        break;
      case 'import':
        await runImport();
        break;
      case 'set-samples':
        await runSetSamples();
        break;
      case 'set-model':
        await runSetModel();
        break;
      case 'reset':
        await request('POST', `${BASE_PATH}/${encodeURIComponent(ecosystem)}/reset`);
        console.error(`✓ reset ${ecosystem} to defaults`);
        break;
      case 'delete':
        await request('DELETE', `${BASE_PATH}/${encodeURIComponent(ecosystem)}`);
        console.error(`✓ unregistered ${ecosystem}`);
        break;
      default:
        usage(`Unknown command: ${command}`);
    }
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}

main();
