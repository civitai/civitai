#!/usr/bin/env node

/**
 * Cloudflare Analytics Query Tool
 * Uses Cloudflare GraphQL Analytics API to analyze HTTP traffic patterns.
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env
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
const CF_ZONE_ID = process.env.CF_ZONE_ID;
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql';

if (!CF_API_TOKEN || !CF_ZONE_ID) {
  console.error('Missing CF_API_TOKEN or CF_ZONE_ID in .env');
  process.exit(1);
}

// --- Helpers ---

async function graphql(query, variables = {}) {
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${CF_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`CF GraphQL ${res.status}: ${text}`);
  }
  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(`CF GraphQL errors: ${JSON.stringify(json.errors, null, 2)}`);
  }
  return json.data;
}

async function restApi(path, params = {}) {
  const url = new URL(`https://api.cloudflare.com/client/v4${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, v);
  }
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${CF_API_TOKEN}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`CF REST ${res.status}: ${text}`);
  }
  return res.json();
}

function parseTime(s) {
  if (!s) return null;
  const rel = s.match(/^-(\d+)([mhd])$/);
  if (rel) {
    const n = parseInt(rel[1]);
    const unit = rel[2];
    const now = Date.now();
    const ms = unit === 'm' ? n * 60000 : unit === 'h' ? n * 3600000 : n * 86400000;
    return new Date(now - ms).toISOString();
  }
  if (/^\d{2}:\d{2}$/.test(s)) {
    const today = new Date().toISOString().slice(0, 10);
    return `${today}T${s}:00Z`;
  }
  return new Date(s.replace(' ', 'T') + (s.includes('T') || s.includes('Z') ? '' : ':00Z')).toISOString();
}

function fmt(n) {
  if (typeof n !== 'number') return n;
  return n.toLocaleString();
}

function table(rows, columns) {
  if (!rows?.length) { console.log('  (no data)'); return; }
  const widths = columns.map(c => Math.max(c.header.length, ...rows.map(r => String(c.value(r)).length)));
  const header = columns.map((c, i) => c.header.padEnd(widths[i])).join('  ');
  const sep = columns.map((_, i) => '-'.repeat(widths[i])).join('  ');
  console.log(`  ${header}`);
  console.log(`  ${sep}`);
  for (const r of rows) {
    console.log('  ' + columns.map((c, i) => String(c.value(r)).padEnd(widths[i])).join('  '));
  }
}

function buildFilter(start, end, opts = {}) {
  const parts = [`datetime_geq: "${start}", datetime_leq: "${end}"`];
  if (opts.pathLike) parts.push(`clientRequestPath_like: "${opts.pathLike}"`);
  if (opts.path) parts.push(`clientRequestPath: "${opts.path}"`);
  if (opts.ip) parts.push(`clientIP: "${opts.ip}"`);
  if (opts.botScoreMax !== undefined) parts.push(`botScore_leq: ${opts.botScoreMax}`);
  if (opts.userAgentLike) parts.push(`userAgent_like: "${opts.userAgentLike}"`);
  return parts.join(', ');
}

// --- Commands ---

async function topClients(start, end, limit = 20, filter = {}) {
  const f = buildFilter(start, end, filter);

  const data = await graphql(`{
    viewer {
      zones(filter: {zoneTag: "${CF_ZONE_ID}"}) {
        httpRequestsAdaptiveGroups(
          filter: {${f}}
          limit: ${limit}
          orderBy: [count_DESC]
        ) {
          count
          dimensions {
            clientIP
            clientCountryName
            clientASNDescription
          }
        }
      }
    }
  }`);

  const groups = data.viewer.zones[0]?.httpRequestsAdaptiveGroups || [];
  console.log(`\nTop ${limit} clients by request count (${start.slice(0,16)} → ${end.slice(0,16)}):`);
  table(groups, [
    { header: 'Requests', value: r => fmt(r.count) },
    { header: 'IP', value: r => r.dimensions.clientIP },
    { header: 'Country', value: r => r.dimensions.clientCountryName },
    { header: 'ASN', value: r => r.dimensions.clientASNDescription },
  ]);
  return groups;
}

async function topPaths(start, end, limit = 30, filter = {}) {
  const f = buildFilter(start, end, filter);

  const data = await graphql(`{
    viewer {
      zones(filter: {zoneTag: "${CF_ZONE_ID}"}) {
        httpRequestsAdaptiveGroups(
          filter: {${f}}
          limit: ${limit}
          orderBy: [count_DESC]
        ) {
          count
          dimensions {
            clientRequestPath
          }
        }
      }
    }
  }`);

  const groups = data.viewer.zones[0]?.httpRequestsAdaptiveGroups || [];
  console.log(`\nTop ${limit} paths by request count:`);
  table(groups, [
    { header: 'Requests', value: r => fmt(r.count) },
    { header: 'Path', value: r => r.dimensions.clientRequestPath },
  ]);
  return groups;
}

async function topUserAgents(start, end, limit = 20, filter = {}) {
  const f = buildFilter(start, end, filter);

  const data = await graphql(`{
    viewer {
      zones(filter: {zoneTag: "${CF_ZONE_ID}"}) {
        httpRequestsAdaptiveGroups(
          filter: {${f}}
          limit: ${limit}
          orderBy: [count_DESC]
        ) {
          count
          dimensions {
            clientRequestHTTPMethodName
            userAgent
          }
        }
      }
    }
  }`);

  const groups = data.viewer.zones[0]?.httpRequestsAdaptiveGroups || [];
  console.log(`\nTop ${limit} user agents:`);
  table(groups, [
    { header: 'Requests', value: r => fmt(r.count) },
    { header: 'Method', value: r => r.dimensions.clientRequestHTTPMethodName },
    { header: 'User-Agent', value: r => (r.dimensions.userAgent || '').slice(0, 120) },
  ]);
  return groups;
}

async function trafficTimeline(start, end, filter = {}) {
  const parts = [`datetimeMinute_geq: "${start}", datetimeMinute_leq: "${end}"`];
  if (filter.pathLike) parts.push(`clientRequestPath_like: "${filter.pathLike}"`);
  if (filter.ip) parts.push(`clientIP: "${filter.ip}"`);

  const data = await graphql(`{
    viewer {
      zones(filter: {zoneTag: "${CF_ZONE_ID}"}) {
        httpRequestsAdaptiveGroups(
          filter: {${parts.join(', ')}}
          limit: 1000
          orderBy: [datetimeMinute_ASC]
        ) {
          count
          dimensions {
            datetimeMinute
          }
        }
      }
    }
  }`);

  const groups = data.viewer.zones[0]?.httpRequestsAdaptiveGroups || [];
  console.log(`\nTraffic timeline (per minute):`);
  const maxCount = Math.max(...groups.map(g => g.count), 1);
  for (const g of groups) {
    const time = g.dimensions.datetimeMinute.slice(11, 16);
    const barLen = Math.ceil((g.count / maxCount) * 60);
    const bar = '\u2588'.repeat(barLen);
    console.log(`  ${time}  ${String(g.count).padStart(6)}  ${bar}`);
  }
  return groups;
}

async function ipDetail(ip, start, end) {
  const f = buildFilter(start, end, { ip });

  const data = await graphql(`{
    viewer {
      zones(filter: {zoneTag: "${CF_ZONE_ID}"}) {
        total: httpRequestsAdaptiveGroups(filter: {${f}}, limit: 1) {
          count
        }
        paths: httpRequestsAdaptiveGroups(filter: {${f}}, limit: 20, orderBy: [count_DESC]) {
          count
          dimensions { clientRequestPath }
        }
        agents: httpRequestsAdaptiveGroups(filter: {${f}}, limit: 5, orderBy: [count_DESC]) {
          count
          dimensions { userAgent }
        }
        methods: httpRequestsAdaptiveGroups(filter: {${f}}, limit: 5, orderBy: [count_DESC]) {
          count
          dimensions { clientRequestHTTPMethodName }
        }
        statuses: httpRequestsAdaptiveGroups(filter: {${f}}, limit: 10, orderBy: [count_DESC]) {
          count
          dimensions { edgeResponseStatus }
        }
        geo: httpRequestsAdaptiveGroups(filter: {${f}}, limit: 1) {
          dimensions { clientCountryName clientASNDescription }
        }
      }
    }
  }`);

  const z = data.viewer.zones[0];
  const geo = z.geo[0]?.dimensions || {};
  const total = z.total[0]?.count || 0;

  console.log(`\nIP Detail: ${ip}`);
  console.log(`  Total requests: ${fmt(total)}`);
  console.log(`  Country: ${geo.clientCountryName || 'unknown'}`);
  console.log(`  ASN: ${geo.clientASNDescription || 'unknown'}`);
  console.log('\n  Methods:');
  for (const m of z.methods) console.log(`    ${m.dimensions.clientRequestHTTPMethodName}: ${fmt(m.count)}`);

  console.log('\n  Status codes:');
  for (const s of z.statuses) console.log(`    ${s.dimensions.edgeResponseStatus}: ${fmt(s.count)}`);

  console.log('\n  Top paths:');
  table(z.paths, [
    { header: 'Requests', value: r => fmt(r.count) },
    { header: 'Path', value: r => r.dimensions.clientRequestPath },
  ]);

  console.log('\n  User agents:');
  for (const a of z.agents) console.log(`    [${fmt(a.count)}] ${(a.dimensions.userAgent || '').slice(0, 120)}`);
}

async function scrapeAnalysis(start, end, opts = {}) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`SCRAPE ANALYSIS: ${start.slice(0,16)} \u2192 ${end.slice(0,16)}`);
  console.log(`${'='.repeat(60)}`);

  const apiFilter = opts.pathLike || '/api/%';

  // 1. Top IPs hitting the API/search paths
  console.log(`\n--- Top IPs hitting ${apiFilter} ---`);
  const topIPs = await topClients(start, end, 30, { pathLike: apiFilter });

  // 2. Top paths
  console.log('\n--- Top API paths ---');
  await topPaths(start, end, 30, { pathLike: apiFilter });

  // 3. User agents
  console.log('\n--- Top user agents on API paths ---');
  await topUserAgents(start, end, 20, { pathLike: apiFilter });

  // 4. Bot score distribution
  console.log('\n--- Bot score distribution on API paths ---');
  await botScore(start, end, 20, { pathLike: apiFilter });

  // 5. Detail top suspicious IPs (high volume)
  const suspicious = topIPs.filter(ip => ip.count > 1000).slice(0, 5);
  for (const s of suspicious) {
    console.log(`\n--- Detail for high-volume IP: ${s.dimensions.clientIP} (${fmt(s.count)} reqs) ---`);
    await ipDetail(s.dimensions.clientIP, start, end);
  }
}

async function botScore(start, end, limit = 20, filter = {}) {
  console.log('\nBot score queries require Cloudflare Bot Management (not available on this zone).');
  console.log('Use user-agent analysis and IP detail instead.');
}

async function topClientsByBotScore(start, end, maxScore = 10, limit = 20, filter = {}) {
  const f = buildFilter(start, end, { ...filter, botScoreMax: maxScore });

  const data = await graphql(`{
    viewer {
      zones(filter: {zoneTag: "${CF_ZONE_ID}"}) {
        httpRequestsAdaptiveGroups(
          filter: {${f}}
          limit: ${limit}
          orderBy: [count_DESC]
        ) {
          count
          dimensions {
            clientIP
            clientCountryName
            clientASNDescription
            botScore
          }
        }
      }
    }
  }`);

  const groups = data.viewer.zones[0]?.httpRequestsAdaptiveGroups || [];
  console.log(`\nTop clients with bot score \u2264 ${maxScore}:`);
  table(groups, [
    { header: 'Requests', value: r => fmt(r.count) },
    { header: 'Bot Score', value: r => r.dimensions.botScore },
    { header: 'IP', value: r => r.dimensions.clientIP },
    { header: 'Country', value: r => r.dimensions.clientCountryName },
    { header: 'ASN', value: r => r.dimensions.clientASNDescription },
  ]);
  return groups;
}

async function rateLimits() {
  const data = await restApi(`/zones/${CF_ZONE_ID}/rate_limits`);
  const rules = data.result || [];
  console.log(`\nRate limit rules (${rules.length}):`);
  for (const r of rules) {
    console.log(`  [${r.id}] ${r.disabled ? 'DISABLED' : 'ACTIVE'} - ${r.description || 'no desc'}`);
    console.log(`    Match: ${JSON.stringify(r.match)}`);
    console.log(`    Threshold: ${r.threshold} req/${r.period}s \u2192 ${r.action?.mode} for ${r.action?.timeout}s`);
  }
}

async function wafRules() {
  // List firewall rules (custom rules)
  const data = await restApi(`/zones/${CF_ZONE_ID}/firewall/rules`);
  const rules = data.result || [];
  console.log(`\nFirewall rules (${rules.length}):`);
  for (const r of rules) {
    console.log(`  [${r.id}] ${r.paused ? 'PAUSED' : 'ACTIVE'} - ${r.description || 'no desc'}`);
    console.log(`    Action: ${r.action}  Priority: ${r.priority || 'none'}`);
    console.log(`    Filter: ${r.filter?.expression || 'none'}`);
  }
}

// --- Zone + rule port helpers ---

const PHASE_MAP = {
  custom: 'http_request_firewall_custom',
  ratelimit: 'http_ratelimit',
};

async function putRaw(path, body) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${CF_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

let _zoneCache = null;
async function listZones() {
  if (_zoneCache) return _zoneCache;
  const all = [];
  let page = 1;
  while (true) {
    const d = await restApi('/zones', { per_page: 50, page });
    all.push(...(d.result || []));
    if (!d.result_info || page >= d.result_info.total_pages) break;
    page++;
  }
  _zoneCache = all;
  return all;
}

async function resolveZone(nameOrId) {
  if (/^[0-9a-f]{32}$/.test(nameOrId)) return { id: nameOrId, name: nameOrId, plan: null };
  const zones = await listZones();
  const z = zones.find((z) => z.name === nameOrId);
  if (!z) throw new Error(`Zone not found: ${nameOrId}`);
  return { id: z.id, name: z.name, plan: z.plan?.legacy_id };
}

async function getPhaseEntrypoint(zoneId, phase) {
  const d = await restApi(`/zones/${zoneId}/rulesets/phases/${phase}/entrypoint`);
  return d.result;
}

async function turnstileList() {
  if (!CF_ACCOUNT_ID) throw new Error('CF_ACCOUNT_ID required for Turnstile commands');
  const widgets = [];
  let page = 1;
  while (true) {
    const d = await restApi(`/accounts/${CF_ACCOUNT_ID}/challenges/widgets`, {
      page,
      per_page: 50,
    });
    widgets.push(...(d.result || []));
    if (!d.result_info || page >= d.result_info.total_pages) break;
    page++;
  }
  console.log(`Turnstile widgets (${widgets.length}):\n`);
  for (const w of widgets) {
    console.log(`${w.name}`);
    console.log(`  sitekey: ${w.sitekey}`);
    console.log(`  mode:    ${w.mode}`);
    console.log(`  domains: ${(w.domains || []).join(', ') || '(none)'}`);
    console.log(`  region:  ${w.region}`);
    console.log(`  bot_fight_mode: ${w.bot_fight_mode}`);
    console.log(`  created: ${w.created_on}  modified: ${w.modified_on}`);
    console.log('');
  }
}

async function turnstileGet(sitekey) {
  if (!CF_ACCOUNT_ID) throw new Error('CF_ACCOUNT_ID required for Turnstile commands');
  const d = await restApi(`/accounts/${CF_ACCOUNT_ID}/challenges/widgets/${sitekey}`);
  console.log(JSON.stringify(d.result, null, 2));
}

function proCompatTransform(rules, phase) {
  const notes = [];
  const out = [];
  for (const r of rules) {
    const copy = JSON.parse(JSON.stringify(r));
    let expr = copy.expression;

    if (/ip\.src in \{[^}]*\}/.test(expr)) {
      expr = expr.replace(/\s+and not ip\.src in \{[^}]*\}/g, '');
      expr = expr.replace(/\s+and ip\.src in \{[^}]*\}/g, '');
      notes.push(`${r.description}: stripped ip.src in {...}`);
    }
    if (expr.includes('cf.bot_management')) {
      expr = expr.replace(/\s+and not cf\.bot_management\.verified_bot/g, '');
      expr = expr.replace(/\s+and cf\.bot_management\.verified_bot/g, '');
      notes.push(`${r.description}: stripped bot_management check`);
    }
    copy.expression = expr;

    if (phase === 'http_ratelimit' && copy.ratelimit) {
      const allowed = [10, 15, 20, 30, 40, 45, 60];
      if (!allowed.includes(copy.ratelimit.period)) {
        const rate = copy.ratelimit.requests_per_period / copy.ratelimit.period;
        copy.ratelimit.period = 60;
        copy.ratelimit.requests_per_period = Math.round(rate * 60);
        notes.push(`${r.description}: scaled period to 60s (${copy.ratelimit.requests_per_period} req)`);
      }
      if (copy.ratelimit.requests_to_origin) {
        delete copy.ratelimit.requests_to_origin;
        notes.push(`${r.description}: stripped requests_to_origin`);
      }
    }
    out.push(copy);
  }
  return { rules: out, notes };
}

function filterAndTransformRules(sourceRules, opts) {
  const kept = [];
  const skipped = [];
  const skipHosts = opts.skipHosts || [];
  const rewriteFrom = opts.rewriteHostFrom;
  const rewriteTo = opts.rewriteHostTo;

  for (const r of sourceRules) {
    const reasons = [];
    if (opts.skipDisabled && !r.enabled) reasons.push('disabled');
    for (const h of skipHosts) {
      if (r.expression.includes(`"${h}"`)) { reasons.push(`host:${h}`); break; }
    }
    if (opts.only && !opts.only.some((p) => r.description?.includes(p))) {
      reasons.push('not in --only');
    }
    if (reasons.length) { skipped.push({ desc: r.description, reasons }); continue; }

    const copy = JSON.parse(JSON.stringify(r));
    if (rewriteFrom && rewriteTo) {
      copy.expression = copy.expression.replaceAll(`"${rewriteFrom}"`, `"${rewriteTo}"`);
    }
    const clean = {
      description: copy.description,
      expression: copy.expression,
      action: copy.action,
      enabled: copy.enabled,
    };
    if (copy.action_parameters) clean.action_parameters = copy.action_parameters;
    if (copy.ratelimit) clean.ratelimit = copy.ratelimit;
    if (copy.logging) clean.logging = copy.logging;
    if (copy.ref) clean.ref = copy.ref;
    kept.push(clean);
  }
  return { kept, skipped };
}

async function exportRules(zoneName, phases, outFile) {
  const zone = await resolveZone(zoneName);
  const result = { zone: zone.name, zone_id: zone.id, plan: zone.plan, phases: {} };
  for (const phaseKey of phases) {
    const phase = PHASE_MAP[phaseKey];
    try {
      const ep = await getPhaseEntrypoint(zone.id, phase);
      result.phases[phaseKey] = { id: ep?.id, rules: ep?.rules || [] };
    } catch (e) {
      result.phases[phaseKey] = { error: e.message, rules: [] };
    }
  }
  if (outFile) {
    const fs = await import('fs');
    fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
    console.log(`Wrote ${outFile}`);
  }
  for (const [k, v] of Object.entries(result.phases)) {
    console.log(`\n=== ${zone.name} / ${k} (${v.rules?.length || 0} rules) ===`);
    for (const r of v.rules || []) {
      console.log(`  [${r.enabled ? 'ON ' : 'OFF'}] ${r.action} | ${(r.description || '').slice(0, 70)}`);
    }
  }
  return result;
}

async function portRules(opts) {
  const src = await resolveZone(opts.source);
  const tgt = await resolveZone(opts.target);
  const phases = opts.phases;

  console.log(`\nPort: ${src.name} (${src.plan}) \u2192 ${tgt.name} (${tgt.plan})`);
  console.log(`Phases: ${phases.join(', ')}`);
  console.log(`Mode: ${opts.apply ? 'APPLY (will overwrite target)' : 'DRY RUN (no writes)'}`);

  for (const phaseKey of phases) {
    const phase = PHASE_MAP[phaseKey];
    console.log(`\n--- Phase: ${phaseKey} (${phase}) ---`);

    const srcEp = await getPhaseEntrypoint(src.id, phase);
    if (!srcEp?.rules?.length) {
      console.log('  Source has no rules. Skipping.');
      continue;
    }

    const filtered = filterAndTransformRules(srcEp.rules, {
      skipDisabled: opts.skipDisabled,
      skipHosts: opts.skipHosts,
      rewriteHostFrom: opts.rewriteHostFrom,
      rewriteHostTo: opts.rewriteHostTo,
      only: opts.only,
    });

    let outRules = filtered.kept;
    let proNotes = [];
    if (opts.proCompat || tgt.plan === 'pro' || tgt.plan === 'free') {
      const t = proCompatTransform(outRules, phase);
      outRules = t.rules;
      proNotes = t.notes;
    }

    console.log(`  Kept: ${outRules.length}  Skipped: ${filtered.skipped.length}`);
    for (const r of outRules) {
      console.log(`    + [${r.action}] ${r.description}`);
      console.log(`        ${r.expression.slice(0, 140)}`);
      if (r.ratelimit) console.log(`        limit: ${JSON.stringify(r.ratelimit)}`);
    }
    for (const s of filtered.skipped) {
      console.log(`    - ${s.desc}  (${s.reasons.join(', ')})`);
    }
    if (proNotes.length) {
      console.log(`  Pro-compat transforms:`);
      for (const n of proNotes) console.log(`    ~ ${n}`);
    }

    if (opts.apply) {
      console.log(`  PUT -> ${tgt.name} ${phase}...`);
      const res = await putRaw(
        `/zones/${tgt.id}/rulesets/phases/${phase}/entrypoint`,
        { rules: outRules.map((r) => ({ ...r, ref: undefined })) },
      );
      if (!res.success) {
        console.error('  FAILED:', JSON.stringify(res.errors, null, 2));
        process.exitCode = 1;
      } else {
        console.log(`  OK: ${res.result.rules?.length} rules on target`);
      }
    }
  }

  if (!opts.apply) {
    console.log('\nDry run complete. Re-run with --apply to write.');
  }
}

async function cmdListZones() {
  const zones = await listZones();
  console.log(`\n${zones.length} zones:`);
  for (const z of zones) {
    console.log(`  ${z.id}  ${z.name.padEnd(30)}  ${z.plan?.legacy_id || '?'}  ${z.status}`);
  }
}

// --- CLI ---

const args = process.argv.slice(2);
const flags = {};
const positional = [];

for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) {
    const key = args[i].slice(2);
    const val = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : 'true';
    flags[key] = val;
  } else {
    positional.push(args[i]);
  }
}

const cmd = positional[0];
const start = parseTime(flags.start || flags.from) || parseTime('-1h');
const end = parseTime(flags.end || flags.to) || new Date().toISOString();
const limit = parseInt(flags.limit) || 20;

try {
  switch (cmd) {
    case 'top-clients':
    case 'top-ips':
      await topClients(start, end, limit, { pathLike: flags.path, ip: flags.ip });
      break;

    case 'top-paths':
      await topPaths(start, end, limit, { ip: flags.ip, pathLike: flags.path });
      break;

    case 'top-agents':
    case 'top-ua':
      await topUserAgents(start, end, limit, { ip: flags.ip, pathLike: flags.path });
      break;

    case 'timeline':
      await trafficTimeline(start, end, { ip: flags.ip, pathLike: flags.path });
      break;

    case 'ip':
      if (!positional[1]) { console.error('Usage: ip <address> --start ... --end ...'); process.exit(1); }
      await ipDetail(positional[1], start, end);
      break;

    case 'scrape':
    case 'analyze':
      await scrapeAnalysis(start, end, { pathLike: flags.path });
      break;

    case 'bot-scores':
      await botScore(start, end, limit, { pathLike: flags.path });
      break;

    case 'bot-clients':
      await topClientsByBotScore(start, end, parseInt(flags.score) || 10, limit, { pathLike: flags.path });
      break;

    case 'rate-limits':
      await rateLimits();
      break;

    case 'waf-rules':
      await wafRules();
      break;

    case 'list-zones':
      await cmdListZones();
      break;

    case 'turnstile-list':
    case 'turnstile':
      await turnstileList();
      break;

    case 'turnstile-get':
      if (!positional[1]) { console.error('Usage: turnstile-get <sitekey>'); process.exit(1); }
      await turnstileGet(positional[1]);
      break;

    case 'export-rules': {
      const zone = positional[1] || flags.zone;
      if (!zone) { console.error('Usage: export-rules <zone> [--phase custom|ratelimit|all] [--out file.json]'); process.exit(1); }
      const phase = flags.phase || 'all';
      const phases = phase === 'all' ? ['custom', 'ratelimit'] : [phase];
      await exportRules(zone, phases, flags.out);
      break;
    }

    case 'port-rules': {
      if (!flags.source || !flags.target) { console.error('Usage: port-rules --source <zone> --target <zone> [options]'); process.exit(1); }
      const phase = flags.phase || 'all';
      const phases = phase === 'all' ? ['custom', 'ratelimit'] : [phase];
      await portRules({
        source: flags.source,
        target: flags.target,
        phases,
        skipDisabled: flags['skip-disabled'] === 'true',
        skipHosts: flags['skip-hosts'] ? flags['skip-hosts'].split(',') : [],
        rewriteHostFrom: flags['rewrite-host']?.split(':')[0],
        rewriteHostTo: flags['rewrite-host']?.split(':')[1],
        only: flags.only ? flags.only.split(',') : null,
        proCompat: flags['pro-compat'] === 'true',
        apply: flags.apply === 'true',
      });
      break;
    }

    default:
      console.log(`Cloudflare CLI

Analytics:
  top-clients   Top IPs by request count
  top-paths     Top request paths
  top-agents    Top user agents
  timeline      Requests per minute timeline
  ip <addr>     Detailed breakdown for a specific IP
  scrape        Full scrape analysis
  bot-scores    Bot score distribution
  bot-clients   Top clients with low bot scores
  rate-limits   Current rate limit rules
  waf-rules     Current WAF/firewall rules

Zones + rule port:
  list-zones                            List all zones (id, name, plan)
  export-rules <zone>                   Dump rules from a zone
  port-rules --source X --target Y      Port rules between zones

Flags:
  --start, --from   Start time (-1h, -2d, "16:41", "2024-03-24 16:41")
  --end, --to       End time (default: now)
  --limit           Max results (default: 20)
  --path            Filter by path pattern (SQL LIKE: "/api/%")
  --ip              Filter by client IP
  --score           Max bot score for bot-clients (default: 10)

Port flags (for port-rules / export-rules):
  --source, --target       Zone name or id
  --phase                  custom | ratelimit | all (default)
  --out                    Write export to file (export-rules only)
  --skip-disabled          Skip rules where enabled=false
  --skip-hosts host1,host2 Skip rules whose expression references these hosts
  --rewrite-host FROM:TO   Rewrite "FROM" -> "TO" in expressions
  --only pat1,pat2         Only port rules whose description contains a pattern
  --pro-compat             Strip Enterprise-only features for Pro plan target
  --apply                  Write changes (default: dry run)

Examples:
  node query.mjs list-zones
  node query.mjs export-rules civitai.com --phase custom --out com-rules.json
  node query.mjs port-rules --source civitai.com --target civitai.red \\
    --skip-disabled --skip-hosts api.civitai.com,image.civitai.com \\
    --rewrite-host civitai.com:civitai.red --pro-compat
  # review dry run, then rerun with --apply to write
`);
  }
} catch (err) {
  console.error('Error:', err.message);
  process.exit(1);
}
