#!/usr/bin/env node

/**
 * OpenSearch Admin Tool
 *
 * Usage:
 *   node .claude/skills/opensearch-admin/query.mjs <command> [options]
 *
 * Commands:
 *   health                         Cluster health (green/yellow/red)
 *   stats                          Cluster-wide stats (docs, store, memory)
 *   nodes                          Node stats (heap, CPU, disk, load)
 *   indexes                        List all indexes with doc counts and sizes
 *   index <name>                   Index stats (docs, size, shards)
 *   index <name> mappings          Show field mappings
 *   index <name> settings          Show index settings
 *   index <name> shards            Show shard allocation
 *   count <name> [filter]          Count docs (optional JSON filter)
 *   search <name> <query>          Search docs with JSON query body
 *   sample <name>                  Fetch sample documents
 *   profile <name> <query>         Profile a query (execution timing)
 *   tasks                          List running cluster tasks
 *   aliases                        List all aliases
 *   segments <name>                Segment info (merge health)
 *   cat-indices                    Compact index overview (_cat/indices)
 *   pending-tasks                  Pending cluster tasks
 *   thread-pool                    Thread pool stats
 *
 * Options:
 *   --host <url>      Override OPENSEARCH_HOST
 *   --key <key>       Override OPENSEARCH_API_KEY
 *   --limit <n>       Limit results (default: 20)
 *   --sort <field>    Sort field for search (e.g. "sortAt:desc")
 *   --json            Output raw JSON
 *   --pretty          Pretty-print tables (default)
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../../..');

// ─── Load env ────────────────────────────────────────────────────────────────

function loadEnv() {
  const envFiles = [
    resolve(__dirname, '.env'),
    resolve(projectRoot, '.env'),
  ];
  for (const envPath of envFiles) {
    try {
      for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        let value = trimmed.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        if (!process.env[key]) process.env[key] = value;
      }
    } catch {}
  }
}

loadEnv();

// ─── Parse args ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let jsonOutput = false;
let limit = 20;
let sortField = null;
let hostOverride = null;
let keyOverride = null;
let userOverride = null;
let passOverride = null;
const positionalArgs = [];

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--json') jsonOutput = true;
  else if (arg === '--pretty') jsonOutput = false;
  else if (arg === '--limit') limit = parseInt(args[++i], 10);
  else if (arg === '--sort') sortField = args[++i];
  else if (arg === '--host') hostOverride = args[++i];
  else if (arg === '--key') keyOverride = args[++i];
  else if (arg === '--user') userOverride = args[++i];
  else if (arg === '--pass') passOverride = args[++i];
  else if (arg === '--help' || arg === '-h') { printHelp(); process.exit(0); }
  else if (!arg.startsWith('-')) positionalArgs.push(arg);
}

const command = positionalArgs[0];
const commandArg = positionalArgs[1];
const commandArg2 = positionalArgs[2];

const host = hostOverride || process.env.OPENSEARCH_HOST || 'http://localhost:9200';
const apiKey = keyOverride || process.env.OPENSEARCH_API_KEY || '';
const osUser = userOverride || process.env.OPENSEARCH_USERNAME || '';
const osPass = passOverride || process.env.OPENSEARCH_PASSWORD || '';

function printHelp() {
  console.log(`
OpenSearch Admin Tool

Usage: node query.mjs <command> [options]

Commands:
  health                         Cluster health
  stats                          Cluster-wide stats
  nodes                          Node stats (heap, CPU, disk)
  indexes                        List all indexes
  index <name>                   Index stats
  index <name> mappings          Field mappings
  index <name> settings          Index settings
  index <name> shards            Shard allocation
  count <name> [filter-json]     Count docs (optional filter)
  search <name> <query-json>     Search with query body
  sample <name>                  Fetch sample documents
  profile <name> <query-json>    Profile query execution
  tasks                          Running cluster tasks
  aliases                        List all aliases
  segments <name>                Segment info
  cat-indices                    Compact index listing
  pending-tasks                  Pending cluster tasks
  thread-pool                    Thread pool stats

Options:
  --host <url>      Override OPENSEARCH_HOST
  --key <key>       Override OPENSEARCH_API_KEY
  --limit <n>       Limit results (default: 20)
  --sort <field>    Sort field (e.g. "sortAt:desc")
  --json            Output raw JSON
  --pretty          Pretty-print (default)

Examples:
  node query.mjs health
  node query.mjs stats
  node query.mjs indexes
  node query.mjs index metrics_images_v1
  node query.mjs index metrics_images_v1 mappings
  node query.mjs count metrics_images_v1
  node query.mjs count metrics_images_v1 '{"term":{"userId":4}}'
  node query.mjs sample metrics_images_v1 --limit 5
  node query.mjs search metrics_images_v1 '{"bool":{"must":[{"term":{"userId":4}}]}}'
  node query.mjs search metrics_images_v1 '{"term":{"userId":4}}' --sort sortAt:desc --limit 10
  node query.mjs profile metrics_images_v1 '{"term":{"userId":4}}'
  node query.mjs nodes
  node query.mjs thread-pool
`);
}

if (!command) { printHelp(); process.exit(1); }

// ─── HTTP helpers ────────────────────────────────────────────────────────────

async function req(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (osUser && osPass) {
    headers['Authorization'] = `Basic ${Buffer.from(osUser + ':' + osPass).toString('base64')}`;
  } else if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const init = { method, headers };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }

  const resp = await fetch(`${host}${path}`, init);
  const text = await resp.text();

  let json;
  try { json = JSON.parse(text); } catch { json = text; }

  if (!resp.ok) {
    throw new Error(`${method} ${path} → ${resp.status}: ${typeof json === 'string' ? json : JSON.stringify(json)}`);
  }

  return json;
}

// ─── Formatters ──────────────────────────────────────────────────────────────

function fmtBytes(bytes) {
  if (bytes == null) return '-';
  if (bytes === 0) return '0 B';
  const k = 1024;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + units[i];
}

function fmtNum(n) {
  if (n == null) return '-';
  return Number(n).toLocaleString();
}

function fmtPct(n) {
  if (n == null) return '-';
  return n.toFixed(1) + '%';
}

function fmtMs(ms) {
  if (ms == null) return '-';
  if (ms < 1) return '<1ms';
  if (ms < 1000) return ms.toFixed(0) + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
  return (ms / 60000).toFixed(1) + 'm';
}

function pad(s, n) { return String(s).padEnd(n); }
function rpad(s, n) { return String(s).padStart(n); }

function printJson(data) { console.log(JSON.stringify(data, null, 2)); }

// ─── Commands ────────────────────────────────────────────────────────────────

async function cmdHealth() {
  const data = await req('GET', '/_cluster/health');
  if (jsonOutput) return printJson(data);

  const statusColor = { green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m' };
  const color = statusColor[data.status] || '';
  const reset = '\x1b[0m';

  console.log(`Cluster:             ${data.cluster_name}`);
  console.log(`Status:              ${color}${data.status.toUpperCase()}${reset}`);
  console.log(`Nodes:               ${data.number_of_nodes} (${data.number_of_data_nodes} data)`);
  console.log(`Active Shards:       ${fmtNum(data.active_shards)}`);
  console.log(`Relocating:          ${data.relocating_shards}`);
  console.log(`Initializing:        ${data.initializing_shards}`);
  console.log(`Unassigned:          ${data.unassigned_shards}`);
  console.log(`Pending Tasks:       ${data.number_of_pending_tasks}`);
  console.log(`Active Shard Pct:    ${fmtPct(data.active_shards_percent_as_number)}`);
}

async function cmdStats() {
  const data = await req('GET', '/_cluster/stats');
  if (jsonOutput) return printJson(data);

  const indices = data.indices;
  const nodes = data.nodes;

  console.log(`Cluster: ${data.cluster_name} (${data.status})`);
  console.log(`Nodes:   ${nodes.count.total} total, ${nodes.count.data} data\n`);

  console.log('Indices:');
  console.log(`  Count:       ${fmtNum(indices.count)}`);
  console.log(`  Documents:   ${fmtNum(indices.docs.count)} (deleted: ${fmtNum(indices.docs.deleted)})`);
  console.log(`  Store Size:  ${fmtBytes(indices.store.size_in_bytes)}`);
  console.log(`  Shards:      ${fmtNum(indices.shards.total)} total, ${fmtNum(indices.shards.primaries)} primaries`);

  if (nodes.jvm) {
    console.log('\nJVM:');
    console.log(`  Heap Used:   ${fmtBytes(nodes.jvm.mem.heap_used_in_bytes)} / ${fmtBytes(nodes.jvm.mem.heap_max_in_bytes)}`);
    console.log(`  Threads:     ${fmtNum(nodes.jvm.threads)}`);
  }

  if (nodes.fs) {
    console.log('\nDisk:');
    console.log(`  Total:       ${fmtBytes(nodes.fs.total_in_bytes)}`);
    console.log(`  Free:        ${fmtBytes(nodes.fs.free_in_bytes)}`);
    console.log(`  Available:   ${fmtBytes(nodes.fs.available_in_bytes)}`);
  }

  if (nodes.os) {
    console.log('\nOS:');
    console.log(`  CPU:         ${fmtPct(nodes.os.cpu?.percent)} used`);
    console.log(`  Memory:      ${fmtBytes(nodes.os.mem?.used_in_bytes)} / ${fmtBytes(nodes.os.mem?.total_in_bytes)} (${fmtPct(nodes.os.mem?.used_percent)})`);
  }
}

async function cmdNodes() {
  const data = await req('GET', '/_nodes/stats');
  if (jsonOutput) return printJson(data);

  console.log(`Cluster: ${data.cluster_name} | ${Object.keys(data.nodes).length} nodes\n`);

  console.log(
    pad('Node', 30),
    rpad('Heap', 20),
    rpad('CPU', 6),
    rpad('Load 1m', 8),
    rpad('Disk Used', 12),
    rpad('Disk Free', 12),
    rpad('Docs', 12),
  );
  console.log('-'.repeat(100));

  for (const [, node] of Object.entries(data.nodes)) {
    const jvm = node.jvm?.mem || {};
    const os = node.os || {};
    const fs = node.fs?.total || {};
    const docs = node.indices?.docs?.count || 0;

    const heapPct = jvm.heap_max_in_bytes ? ((jvm.heap_used_in_bytes / jvm.heap_max_in_bytes) * 100) : 0;
    const heapStr = `${fmtBytes(jvm.heap_used_in_bytes)}/${fmtBytes(jvm.heap_max_in_bytes)} (${fmtPct(heapPct)})`;

    console.log(
      pad(node.name, 30),
      rpad(heapStr, 20),
      rpad(fmtPct(os.cpu?.percent), 6),
      rpad(os.cpu?.load_average?.['1m']?.toFixed(2) ?? '-', 8),
      rpad(fmtBytes((fs.total_in_bytes || 0) - (fs.free_in_bytes || 0)), 12),
      rpad(fmtBytes(fs.free_in_bytes), 12),
      rpad(fmtNum(docs), 12),
    );
  }
}

async function cmdIndexes() {
  const data = await req('GET', '/_cat/indices?format=json&bytes=b');
  if (jsonOutput) return printJson(data);

  // Sort by doc count descending
  data.sort((a, b) => (parseInt(b['docs.count'] || 0)) - (parseInt(a['docs.count'] || 0)));

  console.log(
    pad('Index', 40),
    rpad('Health', 8),
    rpad('Status', 8),
    rpad('Docs', 14),
    rpad('Deleted', 10),
    rpad('Size', 12),
    rpad('Pri Size', 12),
  );
  console.log('-'.repeat(104));

  for (const idx of data) {
    const healthColor = { green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m' };
    const color = healthColor[idx.health] || '';
    const reset = '\x1b[0m';

    console.log(
      pad(idx.index, 40),
      rpad(`${color}${idx.health}${reset}`, 8 + (color ? 9 : 0)),
      rpad(idx.status, 8),
      rpad(fmtNum(parseInt(idx['docs.count'] || 0)), 14),
      rpad(fmtNum(parseInt(idx['docs.deleted'] || 0)), 10),
      rpad(fmtBytes(parseInt(idx['store.size'] || 0)), 12),
      rpad(fmtBytes(parseInt(idx['pri.store.size'] || 0)), 12),
    );
  }
}

async function cmdIndex() {
  if (!commandArg) {
    console.error('Error: index command requires an index name');
    process.exit(1);
  }

  const sub = commandArg2;

  if (!sub) {
    // Default: index stats
    const stats = await req('GET', `/${commandArg}/_stats`);
    const indexStats = stats.indices[commandArg];
    if (!indexStats) { console.error(`Index "${commandArg}" not found`); process.exit(1); }

    if (jsonOutput) return printJson(indexStats);

    const total = indexStats.total;
    const primaries = indexStats.primaries;

    console.log(`Index: ${commandArg}\n`);
    console.log('Documents:');
    console.log(`  Count:       ${fmtNum(primaries.docs.count)}`);
    console.log(`  Deleted:     ${fmtNum(primaries.docs.deleted)}`);
    console.log(`  Size:        ${fmtBytes(primaries.store.size_in_bytes)}`);

    console.log('\nIndexing:');
    console.log(`  Total:       ${fmtNum(total.indexing.index_total)}`);
    console.log(`  Current:     ${fmtNum(total.indexing.index_current)}`);
    console.log(`  Time:        ${fmtMs(total.indexing.index_time_in_millis)}`);
    console.log(`  Failed:      ${fmtNum(total.indexing.index_failed)}`);

    console.log('\nSearch:');
    console.log(`  Total:       ${fmtNum(total.search.query_total)}`);
    console.log(`  Current:     ${fmtNum(total.search.query_current)}`);
    console.log(`  Time:        ${fmtMs(total.search.query_time_in_millis)}`);
    console.log(`  Fetch Total: ${fmtNum(total.search.fetch_total)}`);
    console.log(`  Fetch Time:  ${fmtMs(total.search.fetch_time_in_millis)}`);

    if (total.search.query_total > 0) {
      const avgMs = total.search.query_time_in_millis / total.search.query_total;
      console.log(`  Avg Query:   ${fmtMs(avgMs)}`);
    }

    console.log('\nMerges:');
    console.log(`  Current:     ${fmtNum(total.merges.current)}`);
    console.log(`  Total:       ${fmtNum(total.merges.total)}`);
    console.log(`  Time:        ${fmtMs(total.merges.total_time_in_millis)}`);

    console.log('\nRefresh:');
    console.log(`  Total:       ${fmtNum(total.refresh.total)}`);
    console.log(`  Time:        ${fmtMs(total.refresh.total_time_in_millis)}`);

    console.log('\nCache:');
    console.log(`  Query Cache: ${fmtBytes(total.query_cache.memory_size_in_bytes)} (${fmtNum(total.query_cache.hit_count)} hits, ${fmtNum(total.query_cache.miss_count)} misses)`);
    console.log(`  Field Data:  ${fmtBytes(total.fielddata.memory_size_in_bytes)}`);
  } else if (sub === 'mappings') {
    const data = await req('GET', `/${commandArg}/_mapping`);
    const mappings = data[commandArg]?.mappings?.properties;
    if (jsonOutput) return printJson(data);

    if (!mappings) { console.log('No mappings found.'); return; }

    console.log(`Mappings for ${commandArg}:\n`);
    printMappings(mappings, '  ');
  } else if (sub === 'settings') {
    const data = await req('GET', `/${commandArg}/_settings`);
    if (jsonOutput) return printJson(data);
    console.log(`Settings for ${commandArg}:\n`);
    console.log(JSON.stringify(data[commandArg]?.settings, null, 2));
  } else if (sub === 'shards') {
    const data = await req('GET', `/_cat/shards/${commandArg}?format=json&bytes=b`);
    if (jsonOutput) return printJson(data);

    console.log(`Shards for ${commandArg}:\n`);
    console.log(
      pad('Shard', 6), pad('Type', 8), pad('State', 12),
      rpad('Docs', 12), rpad('Size', 12), pad('Node', 30),
    );
    console.log('-'.repeat(80));

    for (const s of data) {
      console.log(
        pad(s.shard, 6), pad(s.prirep === 'p' ? 'primary' : 'replica', 8),
        pad(s.state, 12),
        rpad(fmtNum(parseInt(s.docs || 0)), 12),
        rpad(fmtBytes(parseInt(s.store || 0)), 12),
        pad(s.node || 'unassigned', 30),
      );
    }
  } else {
    console.error(`Unknown subcommand: ${sub}`);
    console.error('Valid: mappings, settings, shards');
    process.exit(1);
  }
}

function printMappings(props, indent) {
  for (const [name, def] of Object.entries(props)) {
    if (def.properties) {
      console.log(`${indent}${name}: (object)`);
      printMappings(def.properties, indent + '  ');
    } else {
      const type = def.type || 'unknown';
      const extras = [];
      if (def.index === false) extras.push('not indexed');
      if (def.doc_values === false) extras.push('no doc_values');
      if (def.analyzer) extras.push(`analyzer: ${def.analyzer}`);
      const suffix = extras.length ? ` [${extras.join(', ')}]` : '';
      console.log(`${indent}${name}: ${type}${suffix}`);
    }
  }
}

async function cmdCount() {
  if (!commandArg) {
    console.error('Error: count requires an index name');
    process.exit(1);
  }

  const filter = commandArg2 ? JSON.parse(commandArg2) : null;
  const data = filter
    ? await req('POST', `/${commandArg}/_count`, { query: filter })
    : await req('GET', `/${commandArg}/_count`);

  if (jsonOutput) return printJson(data);
  console.log(`Documents in ${commandArg}: ${fmtNum(data.count)}`);
}

async function cmdSearch() {
  if (!commandArg) {
    console.error('Error: search requires an index name');
    process.exit(1);
  }

  const queryInput = commandArg2 ? JSON.parse(commandArg2) : { match_all: {} };

  // Wrap bare filter in bool.must if not already a full query
  const query = queryInput.bool || queryInput.match_all ? queryInput : { bool: { must: [queryInput] } };

  const body = { query, size: limit };

  if (sortField) {
    const [field, order] = sortField.split(':');
    body.sort = [{ [field]: { order: order || 'desc' } }];
  }

  const data = await req('POST', `/${commandArg}/_search`, body);

  if (jsonOutput) return printJson(data);

  const hits = data.hits;
  console.log(`Total: ${typeof hits.total === 'object' ? fmtNum(hits.total.value) : fmtNum(hits.total)} | Took: ${fmtMs(data.took)}\n`);

  for (const hit of hits.hits) {
    console.log(`[${hit._id}] score: ${hit._score ?? '-'}`);
    const src = hit._source;
    // Show a compact summary
    const keys = Object.keys(src);
    const preview = keys.slice(0, 8).map(k => {
      let v = src[k];
      if (Array.isArray(v)) v = `[${v.length} items]`;
      else if (typeof v === 'object' && v !== null) v = '{...}';
      else if (typeof v === 'string' && v.length > 50) v = v.slice(0, 50) + '...';
      return `${k}=${v}`;
    }).join(', ');
    console.log(`  ${preview}`);
    if (keys.length > 8) console.log(`  ... +${keys.length - 8} more fields`);
    console.log('');
  }
}

async function cmdSample() {
  if (!commandArg) {
    console.error('Error: sample requires an index name');
    process.exit(1);
  }

  const body = { query: { match_all: {} }, size: limit };
  const data = await req('POST', `/${commandArg}/_search`, body);

  if (jsonOutput) return printJson(data.hits.hits.map(h => h._source));

  const hits = data.hits.hits;
  console.log(`Showing ${hits.length} sample documents from ${commandArg}:\n`);

  for (const hit of hits) {
    console.log(`─── ID: ${hit._id} ───`);
    console.log(JSON.stringify(hit._source, null, 2));
    console.log('');
  }
}

async function cmdProfile() {
  if (!commandArg) {
    console.error('Error: profile requires an index name');
    process.exit(1);
  }

  const queryInput = commandArg2 ? JSON.parse(commandArg2) : { match_all: {} };
  const query = queryInput.bool || queryInput.match_all ? queryInput : { bool: { must: [queryInput] } };

  const body = { query, size: limit, profile: true };

  if (sortField) {
    const [field, order] = sortField.split(':');
    body.sort = [{ [field]: { order: order || 'desc' } }];
  }

  const data = await req('POST', `/${commandArg}/_search`, body);

  if (jsonOutput) return printJson(data);

  const hits = data.hits;
  console.log(`Total: ${typeof hits.total === 'object' ? fmtNum(hits.total.value) : fmtNum(hits.total)} | Took: ${fmtMs(data.took)}\n`);

  // Profile breakdown
  if (data.profile?.shards) {
    for (const shard of data.profile.shards) {
      console.log(`Shard: ${shard.id}\n`);

      if (shard.searches) {
        for (const search of shard.searches) {
          for (const q of search.query || []) {
            printProfileNode(q, '  ');
          }
          if (search.collector) {
            console.log('  Collectors:');
            for (const c of search.collector) {
              printCollector(c, '    ');
            }
          }
        }
      }
    }
  }
}

function printProfileNode(node, indent) {
  const timeMs = (node.time_in_nanos || 0) / 1e6;
  console.log(`${indent}${node.type}: ${node.description}`);
  console.log(`${indent}  Time: ${fmtMs(timeMs)}`);

  if (node.breakdown) {
    const interesting = Object.entries(node.breakdown)
      .filter(([k, v]) => v > 0 && !k.endsWith('_count'))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    if (interesting.length) {
      const parts = interesting.map(([k, v]) => `${k}: ${fmtMs(v / 1e6)}`);
      console.log(`${indent}  Breakdown: ${parts.join(', ')}`);
    }
  }

  if (node.children) {
    for (const child of node.children) {
      printProfileNode(child, indent + '  ');
    }
  }
}

function printCollector(c, indent) {
  const timeMs = (c.time_in_nanos || 0) / 1e6;
  console.log(`${indent}${c.name}: ${fmtMs(timeMs)}`);
  if (c.children) {
    for (const child of c.children) {
      printCollector(child, indent + '  ');
    }
  }
}

async function cmdTasks() {
  const data = await req('GET', '/_tasks?detailed=true&group_by=parents');
  if (jsonOutput) return printJson(data);

  const nodes = data.nodes || {};
  let taskCount = 0;

  for (const [, node] of Object.entries(nodes)) {
    for (const [taskId, task] of Object.entries(node.tasks || {})) {
      taskCount++;
      const running = task.running_time_in_nanos ? fmtMs(task.running_time_in_nanos / 1e6) : '-';
      console.log(`[${taskId}] ${task.action} | Running: ${running} | Cancellable: ${task.cancellable}`);
      if (task.description) console.log(`  ${task.description}`);
    }
  }

  if (taskCount === 0) console.log('No running tasks.');
}

async function cmdAliases() {
  const data = await req('GET', '/_cat/aliases?format=json');
  if (jsonOutput) return printJson(data);

  if (data.length === 0) { console.log('No aliases.'); return; }

  console.log(pad('Alias', 40), pad('Index', 40), pad('Filter', 10), pad('Routing', 10));
  console.log('-'.repeat(100));

  for (const a of data) {
    console.log(pad(a.alias, 40), pad(a.index, 40), pad(a.filter || '-', 10), pad(a.routing?.index || '-', 10));
  }
}

async function cmdSegments() {
  if (!commandArg) {
    console.error('Error: segments requires an index name');
    process.exit(1);
  }

  const data = await req('GET', `/${commandArg}/_segments`);
  if (jsonOutput) return printJson(data);

  const indexData = data.indices[commandArg];
  if (!indexData) { console.error(`Index "${commandArg}" not found`); process.exit(1); }

  let totalSegments = 0;
  let totalDocs = 0;
  let totalDeleted = 0;
  let totalSize = 0;

  for (const [shardNum, shardArr] of Object.entries(indexData.shards)) {
    for (const shard of shardArr) {
      const segments = Object.values(shard.segments || {});
      console.log(`Shard ${shardNum} (${shard.routing.primary ? 'primary' : 'replica'}):`);
      console.log(`  Segments: ${segments.length}`);

      for (const seg of segments) {
        totalSegments++;
        totalDocs += seg.num_docs || 0;
        totalDeleted += seg.deleted_docs || 0;
        totalSize += seg.size_in_bytes || 0;
      }

      console.log(`  Docs: ${fmtNum(segments.reduce((s, seg) => s + (seg.num_docs || 0), 0))}`);
      console.log(`  Deleted: ${fmtNum(segments.reduce((s, seg) => s + (seg.deleted_docs || 0), 0))}`);
      console.log(`  Size: ${fmtBytes(segments.reduce((s, seg) => s + (seg.size_in_bytes || 0), 0))}`);
      console.log('');
    }
  }

  console.log('Total:');
  console.log(`  Segments: ${fmtNum(totalSegments)}`);
  console.log(`  Docs: ${fmtNum(totalDocs)}`);
  console.log(`  Deleted: ${fmtNum(totalDeleted)}`);
  console.log(`  Size: ${fmtBytes(totalSize)}`);
}

async function cmdCatIndices() {
  const data = await req('GET', '/_cat/indices?v&s=docs.count:desc&bytes=b&format=json');
  if (jsonOutput) return printJson(data);

  console.log(
    pad('health', 8), pad('status', 8), pad('index', 40),
    rpad('docs', 14), rpad('deleted', 10),
    rpad('size', 12), rpad('pri.size', 12),
  );
  console.log('-'.repeat(104));

  for (const row of data) {
    console.log(
      pad(row.health || '-', 8), pad(row.status || '-', 8), pad(row.index, 40),
      rpad(fmtNum(parseInt(row['docs.count'] || 0)), 14),
      rpad(fmtNum(parseInt(row['docs.deleted'] || 0)), 10),
      rpad(fmtBytes(parseInt(row['store.size'] || 0)), 12),
      rpad(fmtBytes(parseInt(row['pri.store.size'] || 0)), 12),
    );
  }
}

async function cmdPendingTasks() {
  const data = await req('GET', '/_cluster/pending_tasks');
  if (jsonOutput) return printJson(data);

  const tasks = data.tasks || [];
  if (tasks.length === 0) { console.log('No pending cluster tasks.'); return; }

  for (const t of tasks) {
    console.log(`[${t.insert_order}] Priority: ${t.priority} | Pending: ${t.time_in_queue} | ${t.source}`);
  }
}

async function cmdThreadPool() {
  const data = await req('GET', '/_cat/thread_pool?format=json&h=node_name,name,active,queue,rejected,completed');
  if (jsonOutput) return printJson(data);

  // Filter to interesting pools (non-zero activity)
  const interesting = data.filter(t =>
    parseInt(t.active || 0) > 0 || parseInt(t.queue || 0) > 0 ||
    parseInt(t.rejected || 0) > 0 || parseInt(t.completed || 0) > 0
  );

  console.log(pad('Node', 25), pad('Pool', 30), rpad('Active', 8), rpad('Queue', 8), rpad('Rejected', 10), rpad('Completed', 12));
  console.log('-'.repeat(93));

  for (const t of interesting) {
    console.log(
      pad(t.node_name || '-', 25),
      pad(t.name, 30),
      rpad(t.active || '0', 8),
      rpad(t.queue || '0', 8),
      rpad(t.rejected || '0', 10),
      rpad(t.completed || '0', 12),
    );
  }

  if (interesting.length === 0) console.log('(all thread pools idle)');
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.error(`OpenSearch: ${host}\n`);

  try {
    switch (command) {
      case 'health': return cmdHealth();
      case 'stats': return cmdStats();
      case 'nodes': return cmdNodes();
      case 'indexes': case 'indices': return cmdIndexes();
      case 'index': return cmdIndex();
      case 'count': return cmdCount();
      case 'search': return cmdSearch();
      case 'sample': return cmdSample();
      case 'profile': return cmdProfile();
      case 'tasks': return cmdTasks();
      case 'aliases': return cmdAliases();
      case 'segments': return cmdSegments();
      case 'cat-indices': return cmdCatIndices();
      case 'pending-tasks': return cmdPendingTasks();
      case 'thread-pool': return cmdThreadPool();
      default:
        console.error(`Unknown command: ${command}`);
        console.error('Run with --help to see available commands.');
        process.exit(1);
    }
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

main();
