#!/usr/bin/env node

/**
 * Apply a Cloudflare Redirect Rules JSON config to a zone (idempotent upsert).
 *
 * JSON schema:
 *   { zone: "civitai.red", phase: "http_request_dynamic_redirect", rules: [ ...CF rule objects... ] }
 *
 * Behavior:
 *   - Fetches the zone's existing phase-entrypoint ruleset.
 *   - Removes any existing rule whose `description` matches one in the config
 *     (so re-applying is an upsert, not a duplicate).
 *   - Appends the config's rules.
 *   - PUTs the merged rule list back.
 *
 * Required token scopes: Zone → Dynamic Redirect (Edit) + Zone → Zone (Read).
 *
 * Usage:
 *   node apply-redirects.mjs <path-to-json>            # dry run — shows the plan
 *   node apply-redirects.mjs <path-to-json> --apply    # actually writes
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const envPath = resolve(__dirname, '.env');
try {
  const envContent = readFileSync(envPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
} catch {}

const CF_API_TOKEN = process.env.CF_API_TOKEN;
if (!CF_API_TOKEN) {
  console.error('Missing CF_API_TOKEN in .env');
  process.exit(1);
}

const [, , configPath, ...flags] = process.argv;
if (!configPath) {
  console.error('Usage: apply-redirects.mjs <path-to-json> [--apply]');
  process.exit(1);
}
const apply = flags.includes('--apply');

const config = JSON.parse(readFileSync(resolve(configPath), 'utf8'));
if (!config.zone || !config.phase || !Array.isArray(config.rules)) {
  console.error('Config must include: zone, phase, rules[]');
  process.exit(1);
}

const API = 'https://api.cloudflare.com/client/v4';

async function cf(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${CF_API_TOKEN}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok || json.success === false) {
    throw new Error(`CF ${res.status} ${path}: ${JSON.stringify(json.errors ?? json, null, 2)}`);
  }
  return json;
}

async function resolveZoneId(zoneName) {
  const list = await cf(`/zones?name=${encodeURIComponent(zoneName)}`);
  const zone = list.result?.[0];
  if (!zone) throw new Error(`Zone not found: ${zoneName}`);
  return zone.id;
}

async function getEntrypoint(zoneId, phase) {
  return cf(`/zones/${zoneId}/rulesets/phases/${phase}/entrypoint`);
}

async function putRules(zoneId, phase, rules) {
  return cf(`/zones/${zoneId}/rulesets/phases/${phase}/entrypoint`, {
    method: 'PUT',
    body: JSON.stringify({ rules }),
  });
}

const zoneId = await resolveZoneId(config.zone);
console.log(`Zone: ${config.zone} (${zoneId})`);
console.log(`Phase: ${config.phase}`);

let existing = [];
try {
  const ep = await getEntrypoint(zoneId, config.phase);
  existing = ep.result?.rules ?? [];
} catch (e) {
  if (!String(e).includes('request is not authorized')) throw e;
  console.error('WARNING: could not read existing ruleset — token lacks read permission.');
  console.error('         Proceeding as if empty; this will WIPE any existing rules on apply.');
  console.error('         Add "Dynamic Redirect: Edit" + read scopes to the token to fix.');
}

const incomingDescriptions = new Set(config.rules.map((r) => r.description));
const kept = existing.filter((r) => !incomingDescriptions.has(r.description));
const removed = existing.filter((r) => incomingDescriptions.has(r.description));
const finalRules = [...kept, ...config.rules];

console.log(`\nExisting rules: ${existing.length}`);
console.log(`  - kept:    ${kept.length}`);
console.log(`  - removed: ${removed.length}  (matched by description)`);
console.log(`Incoming rules: ${config.rules.length}`);
console.log(`Final rule count: ${finalRules.length}\n`);

for (const r of removed) console.log(`  REMOVE  ${r.description}`);
for (const r of config.rules) console.log(`  UPSERT  ${r.description}`);

if (!apply) {
  console.log('\nDry run. Re-run with --apply to write.');
  process.exit(0);
}

await putRules(zoneId, config.phase, finalRules);
console.log('\nApplied.');
