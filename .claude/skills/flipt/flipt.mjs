#!/usr/bin/env node

/**
 * Flipt flag reader (definitions from git).
 *
 *   node .claude/skills/flipt/flipt.mjs list [--json] [-q]
 *   node .claude/skills/flipt/flipt.mjs get <flag-key> [--json]
 *   node .claude/skills/flipt/flipt.mjs get <flag-key> --live   (refuses, names the supported path)
 *
 * Reads the DEFINITION in civitai/flipt-state (civitai-app/default/features.yaml)
 * via `gh api`, or from a local clone when FLIPT_STATE_DIR is set. It is not the
 * live server's answer. Writes are refused: change flags with a PR to flipt-state.
 */

import { readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import {
  STATE_REPO,
  STATE_PATH,
  LIVE_REFUSAL,
  detectHtmlOrOAuth,
  flagsFromYaml,
  findFlag,
  formatSegments,
} from './flipt-lib.mjs';

const skillDir = dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  for (const envPath of [resolve(skillDir, '.env'), resolve(skillDir, '../../../.env')]) {
    try {
      for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const i = t.indexOf('=');
        if (i === -1) continue;
        const k = t.slice(0, i);
        if (!process.env[k]) process.env[k] = t.slice(i + 1);
      }
    } catch {}
  }
}
loadEnv();

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('-')));
const positional = args.filter((a) => !a.startsWith('-'));
const [command = '', flagKey = ''] = positional;
const jsonOutput = flags.has('--json');
const quiet = flags.has('--quiet') || flags.has('-q');
const live = flags.has('--live');

function refuseWrite(action, key) {
  console.error(`Cannot ${action} "${key}" through this skill.`);
  console.error('');
  console.error('civitai/flipt-state is the source of truth. Open a PR instead.');
  console.error('');
  console.error('  gh repo clone civitai/flipt-state <scratch-dir>');
  console.error('  # edit civitai-app/default/features.yaml, then branch, commit, push, PR');
  console.error('');
  console.error('Flag entry format:');
  console.error('  - key: my-flag');
  console.error('    name: my-flag');
  console.error('    type: BOOLEAN_FLAG_TYPE');
  console.error('    description: what it controls');
  console.error('    enabled: false');
  process.exit(2);
}

// Live state: only through an explicit FLIPT_LIVE_URL (for example a gated
// in-cluster endpoint a DevOps seat hands you). The browser-facing FLIPT_URL is
// never used: it answers every path with an OAuth login.
async function liveGet(key) {
  const base = process.env.FLIPT_LIVE_URL;
  if (!base || !process.env.FLIPT_API_TOKEN) {
    console.error(LIVE_REFUSAL);
    process.exit(3);
  }
  const res = await fetch(`${base}/evaluate/v1/boolean`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      Authorization: `Bearer ${process.env.FLIPT_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ flagKey: key, entityId: 'flipt-skill', context: {} }),
  });
  const body = await res.text();
  const bad = detectHtmlOrOAuth({
    status: res.status,
    contentType: res.headers.get('content-type') ?? '',
    location: res.headers.get('location') ?? '',
    body,
  });
  if (bad) throw new Error(bad);
  console.log(body);
}

async function readDefinitions() {
  let text;
  let source;
  if (process.env.FLIPT_STATE_DIR) {
    const p = resolve(process.env.FLIPT_STATE_DIR, STATE_PATH);
    text = readFileSync(p, 'utf-8');
    source = `local clone ${process.env.FLIPT_STATE_DIR} (as checked out, may be behind)`;
  } else {
    try {
      text = execFileSync(
        'gh',
        [
          'api',
          `repos/${STATE_REPO}/contents/${STATE_PATH}`,
          '-H',
          'Accept: application/vnd.github.raw',
        ],
        { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }
      );
      const sha = execFileSync('gh', ['api', `repos/${STATE_REPO}/commits/main`, '--jq', '.sha'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
      source = `${STATE_REPO}@${sha.slice(0, 10)} (main)`;
    } catch (e) {
      throw new Error(
        `Could not read ${STATE_REPO} with gh (is gh logged in with access to it?): ${(
          e.stderr || e.message
        )
          .toString()
          .trim()}`
      );
    }
  }
  const { parse } = await import('yaml');
  return { flags: flagsFromYaml(text, parse), source };
}

const NOT_LIVE = 'DEFINITION from git, not live state.';

async function listFlags() {
  const { flags: all, source } = await readDefinitions();
  if (jsonOutput) {
    console.log(JSON.stringify({ source, note: NOT_LIVE, flags: all }, null, 2));
    return;
  }
  if (!quiet) console.log(`${all.length} flags in ${source}\n${NOT_LIVE}\n${'─'.repeat(80)}`);
  for (const f of all) {
    console.log(`${f.enabled ? '✓ ENABLED ' : '✗ DISABLED'}  ${f.key}`);
    if (f.description && !quiet) console.log(`         ${String(f.description).slice(0, 200)}\n`);
  }
}

async function getFlag(key) {
  const { flags: all, source } = await readDefinitions();
  const data = findFlag(all, key);
  if (!data)
    throw new Error(
      `Flag not found in ${source}: ${key}. (Absent from git; a flag created only on the live server would not show here.)`
    );
  if (jsonOutput) {
    console.log(JSON.stringify({ source, note: NOT_LIVE, flag: data }, null, 2));
    return;
  }
  console.log(`Flag: ${data.key}`);
  console.log(`Source: ${source} — ${NOT_LIVE}`);
  console.log(`Status: ${data.enabled ? '✓ ENABLED' : '✗ DISABLED'}`);
  console.log(`Type: ${data.type}`);
  if (data.type === 'BOOLEAN_FLAG_TYPE') {
    console.log(
      `Default: ${data.enabled} — ${
        data.enabled
          ? 'PUBLIC unless a rollout overrides: everyone no rollout matches gets true'
          : 'off for everyone no rollout matches'
      }`
    );
  }
  if (data.description) console.log(`Description: ${data.description}`);
  for (const v of data.variants ?? []) {
    console.log(
      `  variant ${v.key}${v.default ? ' (default)' : ''}${
        v.attachment ? ' → ' + JSON.stringify(v.attachment) : ''
      }`
    );
  }
  for (const rule of data.rules ?? []) {
    const seg = rule.segment ?? rule;
    console.log(
      `  rule segment: ${formatSegments(
        seg.keys ?? seg.segments,
        seg.operator ?? seg.segmentOperator
      )}`
    );
    for (const d of rule.distributions ?? [])
      console.log(`    → variant "${d.variant}" at ${d.rollout}%`);
  }
  for (const r of data.rollouts ?? []) {
    if (r.threshold) console.log(`  rollout ${r.threshold.percentage}% → ${r.threshold.value}`);
    if (r.segment)
      console.log(
        `  rollout segment ${formatSegments(
          r.segment.keys ?? r.segment.segments,
          r.segment.operator ?? r.segment.segmentOperator
        )} → ${r.segment.value}`
      );
  }
}

function showHelp() {
  console.log(`Flipt flag reader (definitions from civitai/flipt-state git)

  list                  List flag definitions
  get <key>             One flag's definition
  get <key> --live      Refuses unless FLIPT_LIVE_URL is set; names the supported path
  create|enable|disable|delete|add-variant|remove-variant|set-rollout
                        Refuse (exit 2): change flags with a PR to flipt-state

Options: --json, -q, --live
Env: FLIPT_STATE_DIR (read a local clone instead of gh). FLIPT_LIVE_URL + FLIPT_API_TOKEN only for --live.
The DEFINITION is not live state.`);
}

async function main() {
  try {
    switch (command) {
      case 'list':
        if (live) {
          console.error(LIVE_REFUSAL);
          process.exit(3);
        }
        await listFlags();
        break;
      case 'get':
        if (!flagKey) {
          console.error('Usage: flipt.mjs get <flag-key>');
          process.exit(1);
        }
        if (live) await liveGet(flagKey);
        else await getFlag(flagKey);
        break;
      case 'create':
      case 'enable':
      case 'disable':
      case 'delete':
      case 'add-variant':
      case 'remove-variant':
      case 'set-rollout':
        refuseWrite(command, flagKey || '<key>');
        break;
      case '':
      case 'help':
      case '--help':
      case '-h':
        showHelp();
        break;
      default:
        console.error(`Unknown command: ${command}`);
        process.exit(1);
    }
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

main();
