#!/usr/bin/env node
/**
 * Creates CivitaiOfficial models and versions, and writes model descriptions. See SKILL.md.
 *
 * Every write is a dry run that prints its payload unless --writable is passed.
 */

import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { API_URL, createCli, projectRoot, trpcCall, whoami } from '../mod-actions/lib.mjs';
import { queryDb } from '../generation-coverage/coverage.mjs';

// constants.system.officialUserId in src/server/common/constants.ts
const OFFICIAL_USER_ID = 12042163;
const KINDS = { 'api-only': 'ExternalGeneration', 'hosted-weights': 'Download' };
const ECOSYSTEMS_DIR = resolve(projectRoot, 'src/server/services/orchestrator/ecosystems');
// Mirrors checkLoadable in src/server/services/resource-load.service.ts.
const LOADABLE_FILE_TYPES = ['Model', 'Pruned Model', 'Diffusion Model', 'UNet', 'Negative', 'VAE'];
// Closed models reachable only through their provider's API, plus fal, which hosts third-party models.
const EXTERNAL_ENGINES = [
  'fal', 'openai', 'google', 'gemini', 'seedance', 'seedream', 'kling', 'kling-v3',
  'vidu', 'vidu-q3', 'sora', 'veo3', 'grok', 'minimax-h3',
];

const { flags, writable, fail, required, requiredInt, oneOf, dryRun, dispatch } = createCli([
  'writable',
  'no-download',
]);

const sqlString = (value) => `'${String(value).replace(/'/g, "''")}'`;

// ---------------------------------------------------------------------------
// Descriptions. A write needs --approved <hash> of the exact text the user was shown, so an edit
// made after approval — to the file, or to the live page — fails instead of landing unseen.

function readDescription() {
  const html = readFileSync(required('description-file'), 'utf-8').trim();
  if (!html) fail('the description file is empty');
  return html;
}

function approvalHash(...parts) {
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 12);
}

function requireApproval(hash) {
  if (flags.approved !== hash)
    fail(
      `--approved ${flags.approved ?? '(missing)'} does not match ${hash}. ` +
        `Run without --writable, show the user the output, and get their approval of that exact text.`
    );
}

function printApprovalFooter(hash) {
  console.log(`\nApproval hash: ${hash}`);
  console.log(`After the user approves exactly this, re-run with: --writable --approved ${hash}`);
}

const oneTagPerLine = (html) => `${html.replace(/>\s*</g, '>\n<')}\n`;

function printDiff(current, proposed) {
  const dir = mkdtempSync(join(tmpdir(), 'official-model-description-'));
  const currentPath = join(dir, 'current.html');
  const proposedPath = join(dir, 'proposed.html');
  writeFileSync(currentPath, oneTagPerLine(current));
  writeFileSync(proposedPath, oneTagPerLine(proposed));
  const diff = spawnSync('git', ['diff', '--no-index', '--no-color', '--', currentPath, proposedPath], {
    encoding: 'utf-8',
  });
  if (diff.error) console.log(`(git unavailable — compare ${currentPath} with ${proposedPath})`);
  else console.log(diff.stdout);
}

// ---------------------------------------------------------------------------
// Models

async function transferToOfficial(modelId, targetUserId) {
  await trpcCall('moderator.models.transferOwnership', { modelIds: [modelId], targetUserId });
  console.log(`Transferred model ${modelId} to user ${targetUserId}.`);
}

async function createModel() {
  const name = required('name');
  const description = readDescription();
  const targetUserId = flags['owner-id'] ? requiredInt('owner-id') : OFFICIAL_USER_ID;
  const hash = approvalHash(name, description);
  const payload = { name, description, type: flags.type ?? 'Checkpoint', uploadType: 'Created', status: 'Draft' };

  if (!writable) {
    console.log(`[dry run] model.upsert → ${API_URL}, then transfer to user ${targetUserId}`);
    console.log(`Name: ${name}   Type: ${payload.type}   Status: Draft\n`);
    console.log(oneTagPerLine(description));
    return printApprovalFooter(hash);
  }
  requireApproval(hash);

  const model = await trpcCall('model.upsert', payload);
  console.log(`Created Draft model ${model.id}: ${API_URL}/models/${model.id}`);
  try {
    await transferToOfficial(model.id, targetUserId);
  } catch (err) {
    console.error(`Transfer failed: ${err.message}`);
    console.error(`The model exists and is owned by you. Retry with:`);
    console.error(`  node .claude/skills/official-model-admin/model.mjs transfer --model-id ${model.id} --writable`);
    process.exit(1);
  }
}

async function updateDescription() {
  const id = requiredInt('model-id');
  const proposed = readDescription();
  const model = await trpcCall('model.getById', { id }, 'GET');
  const current = (model.description ?? '').trim();
  if (current === proposed) return console.log('The proposed description matches the live one — nothing to do.');
  const hash = approvalHash(current, proposed);

  if (!writable) {
    console.log(`[dry run] description update for model ${id} ("${model.name}", ${model.status}) → ${API_URL}`);
    console.log(`${current.length} → ${proposed.length} chars\n`);
    printDiff(current, proposed);
    return printApprovalFooter(hash);
  }
  requireApproval(hash);

  // model.upsert is a whole-form write, but on update it drops `status` and leaves every omitted
  // optional field untouched — so the required fields go back at their current values.
  await trpcCall('model.upsert', {
    id,
    name: model.name,
    type: model.type,
    uploadType: model.uploadType,
    status: model.status,
    description: proposed,
  });
  const after = await trpcCall('model.getById', { id }, 'GET');
  console.log(`Updated the description of model ${id}: ${API_URL}/models/${id}`);
  if ((after.description ?? '').trim() !== proposed)
    console.log('Note: the stored HTML differs from the file — the server sanitizes and expands blurbs. Check the page.');
}

async function transfer() {
  const modelId = requiredInt('model-id');
  const targetUserId = flags['owner-id'] ? requiredInt('owner-id') : OFFICIAL_USER_ID;
  if (!writable) return dryRun('moderator.models.transferOwnership', { modelIds: [modelId], targetUserId });
  await transferToOfficial(modelId, targetUserId);
}

// ---------------------------------------------------------------------------
// Versions: API-only (the provider runs it, no files) or hosted weights (we run it from files)

function handlerFor(ecosystemKey) {
  const index = readFileSync(join(ECOSYSTEMS_DIR, 'index.ts'), 'utf-8').split('\n');
  const start = index.findIndex((line) => line.trim() === `case '${ecosystemKey}':`);
  if (start === -1) return null;
  const fn = index
    .slice(start)
    .map((line) => line.match(/return (create\w+Input)\(/)?.[1])
    .find(Boolean);
  if (!fn) return null;
  const file = readdirSync(ECOSYSTEMS_DIR)
    .filter((f) => f.endsWith('.handler.ts'))
    .find((f) => readFileSync(join(ECOSYSTEMS_DIR, f), 'utf-8').includes(`export const ${fn}`));
  if (!file) return { fn, file: null, engines: [] };
  const source = readFileSync(join(ECOSYSTEMS_DIR, file), 'utf-8');
  const engines = [...new Set([...source.matchAll(/engine: ['"]([\w-]+)['"]/g)].map((m) => m[1]))];
  return { fn, file, engines };
}

function classifyEngine(engine) {
  if (engine === 'comfy' || engine.endsWith('-comfy')) return 'hosted-weights';
  if (EXTERNAL_ENGINES.includes(engine)) return 'api-only';
  return 'unclear';
}

async function evidence() {
  if (!flags.ecosystem && !flags['base-model']) fail('pass --ecosystem <key> and/or --base-model <name>');
  const votes = new Set();

  console.log('Evidence for API-only vs hosted weights\n');

  if (flags.ecosystem) {
    const handler = handlerFor(flags.ecosystem);
    if (!handler) {
      console.log(`Handler: none for ecosystem "${flags.ecosystem}" in ecosystems/index.ts (new ecosystem?).`);
      console.log('  Check @civitai/orchestration-client instead: a Comfy* input type means hosted weights;');
      console.log('  a provider-specific input with a provider engine means API-only.');
    } else {
      console.log(`Handler: ${handler.file ?? '(file not found)'} (${handler.fn})`);
      for (const engine of handler.engines) {
        const kind = classifyEngine(engine);
        votes.add(kind);
        console.log(`  engine '${engine}' → ${kind === 'unclear' ? 'unclear (a model-family engine; runs either way)' : kind}`);
      }
      if (handler.engines.length > 1)
        console.log('  Several engines: the handler branches by version, so the answer depends on which branch this version takes.');
    }
  }

  if (flags['base-model']) {
    const { rows } = queryDb(
      `SELECT mv.id, mv.name, mv.status, mv."usageControl",
              (SELECT count(*) FROM "ModelFile" f WHERE f."modelVersionId" = mv.id)::int AS files
       FROM "ModelVersion" mv JOIN "Model" m ON m.id = mv."modelId"
       WHERE m."userId" = ${OFFICIAL_USER_ID} AND mv."baseModel" = ${sqlString(flags['base-model'])}
       ORDER BY mv.id DESC LIMIT 10`,
      { db: flags.db }
    );
    console.log(`\nExisting CivitaiOfficial versions with base model "${flags['base-model']}":`);
    if (!rows.length) console.log('  none');
    for (const row of rows) {
      const kind = row.usageControl === 'ExternalGeneration' ? 'api-only' : 'hosted-weights';
      votes.add(kind);
      console.log(`  ${row.id}  ${row.name} — ${row.usageControl}, ${row.files} file(s), ${row.status} → ${kind}`);
    }
  }

  const decided = [...votes].filter((v) => v !== 'unclear');
  console.log(
    `\nSuggestion: ${
      decided.length === 1 ? decided[0] : decided.length > 1 ? 'MIXED — ask which one this version is' : 'no signal'
    }`
  );
  console.log(`
Confirm with the user before create-version. The deciding question:
  Does the provider publish weights we download and run (e.g. on Hugging Face)?  → hosted-weights
  Or is the model only reachable through the provider's own API?                 → api-only`);
}

async function createVersion() {
  const kind = oneOf('kind', required('kind'), Object.keys(KINDS));
  const usageControl = kind === 'hosted-weights' && flags['no-download'] ? 'Generation' : KINDS[kind];
  const payload = {
    modelId: requiredInt('model-id'),
    name: required('name'),
    baseModel: required('base-model'),
    usageControl,
    trainedWords: [],
  };

  if (!writable) return dryRun(`modelVersion.upsert (${kind})`, payload);

  let version;
  try {
    version = await trpcCall('modelVersion.upsert', payload);
  } catch (err) {
    if (/Unknown base model/i.test(err.message))
      fail(
        `${err.message}\nThe server at ${API_URL} does not know this base model yet. ` +
          `The constants PR that adds it must be deployed there first.`
      );
    throw err;
  }

  const { id } = version;
  console.log(`Created Draft version ${id} on model ${payload.modelId} (${kind}, ${usageControl}).`);
  if (kind === 'api-only')
    return console.log('No model files needed — the provider runs it. Next: the coverage row.');

  console.log(`
This version needs its model files before it can generate. Give the user this link:

  ${API_URL}/models/${payload.modelId}/model-versions/${id}/wizard?step=2

(or, on the model page, the version menu → "Manage files"). When they say the upload is done:

  node .claude/skills/official-model-admin/model.mjs files --version ${id}`);
}

async function files() {
  const id = requiredInt('version');
  const version = await trpcCall('modelVersion.getById', { id, withFiles: true }, 'GET');
  const uploaded = version.files ?? [];
  const uploadUrl = `${API_URL}/models/${version.model.id}/model-versions/${id}/wizard?step=2`;

  console.log(`Version ${id}: ${version.model.name} — ${version.name} (${version.usageControl})\n`);
  for (const f of uploaded)
    console.log(
      `  ${f.scannedAt ? 'scanned ' : 'SCANNING'}  ${f.type.padEnd(15)} ${String(f.metadata?.format ?? '?').padEnd(11)} ${f.name}`
    );

  if (version.usageControl === 'ExternalGeneration') {
    const note = uploaded.length ? ' These files are not used for generation.' : '';
    return console.log(`API-only version — no files needed.${note}`);
  }
  if (!uploaded.length) return console.log(`NOT READY: no files yet. Upload at ${uploadUrl}`);

  const weights = uploaded.filter((f) => LOADABLE_FILE_TYPES.includes(f.type));
  const scannedWeights = weights.filter((f) => f.scannedAt);
  const needsSafeTensor = version.model.type === 'Checkpoint';
  if (!weights.length)
    return console.log(
      `\nNOT READY: no weight file. One file must have type ${LOADABLE_FILE_TYPES.join(', ')}. Fix the file types at ${uploadUrl}`
    );
  if (!scannedWeights.length)
    return console.log('\nNOT READY: the weight files are still being scanned. Check again in a few minutes.');
  if (needsSafeTensor && !scannedWeights.some((f) => f.metadata?.format === 'SafeTensor'))
    return console.log('\nNOT READY: a checkpoint needs a SafeTensor weight file. Upload one, or correct the format.');
  if (scannedWeights.length < weights.length)
    return console.log('\nREADY, but some weight files are still scanning — only the scanned ones can load yet.');
  console.log('\nREADY: the weight files are uploaded and scanned. Next: the coverage row.');
}

const HELP = `Usage: node .claude/skills/official-model-admin/model.mjs <command> [flags]

  whoami
  create-model        --name <n> --description-file <html> [--type Checkpoint] [--owner-id <id>] [--writable --approved <hash>]
  update-description  --model-id <id> --description-file <html> [--writable --approved <hash>]
  transfer            --model-id <id> [--owner-id <id>] [--writable]
  evidence            [--ecosystem <key>] [--base-model <name>]      API-only or hosted weights?
  create-version      --model-id <id> --name <n> --base-model <name> --kind <api-only|hosted-weights>
                      [--no-download] [--writable]
  files               --version <id>                                 are the uploaded files ready?

Description writes need --approved <hash>, printed by the dry run of the same command.
--kind api-only → ExternalGeneration (no files); hosted-weights → Download, or Generation with --no-download.
--owner-id defaults to CivitaiOfficial (${OFFICIAL_USER_ID}).`;

dispatch(
  {
    whoami,
    'create-model': createModel,
    'update-description': updateDescription,
    transfer,
    evidence,
    'create-version': createVersion,
    files,
  },
  HELP
);
