#!/usr/bin/env node

/**
 * Meilisearch Admin Tool
 *
 * Usage:
 *   node .claude/skills/meilisearch-admin/query.mjs health
 *   node .claude/skills/meilisearch-admin/query.mjs stats
 *   node .claude/skills/meilisearch-admin/query.mjs tasks [--status enqueued|processing|succeeded|failed]
 *   node .claude/skills/meilisearch-admin/query.mjs task <taskId>
 *   node .claude/skills/meilisearch-admin/query.mjs indexes
 *   node .claude/skills/meilisearch-admin/query.mjs index <indexName> [settings|filterable|sortable|searchable]
 *   node .claude/skills/meilisearch-admin/query.mjs --feed <command>  (use feed/metrics search instead of main)
 *
 * Options:
 *   --feed        Use METRICS_SEARCH_HOST instead of SEARCH_HOST
 *   --json        Output raw JSON
 *   --limit <n>   Limit results (default: 20)
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Load .env from project root
const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../../..');

function loadEnv() {
  try {
    const envPath = resolve(projectRoot, '.env');
    const envContent = readFileSync(envPath, 'utf-8');
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex);
      const value = trimmed.slice(eqIndex + 1);
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch (e) {
    console.error('Warning: Could not load .env file');
  }
}

loadEnv();

// Parse arguments
const args = process.argv.slice(2);
let useFeed = false;
let jsonOutput = false;
let limit = 20;
let status = null;
const positionalArgs = [];

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--feed') {
    useFeed = true;
  } else if (arg === '--json') {
    jsonOutput = true;
  } else if (arg === '--limit') {
    limit = parseInt(args[++i], 10);
  } else if (arg === '--status') {
    status = args[++i];
  } else if (!arg.startsWith('-')) {
    positionalArgs.push(arg);
  }
}

const command = positionalArgs[0];
const commandArg = positionalArgs[1];
const commandArg2 = positionalArgs[2];

if (!command) {
  console.error(`Usage: node query.mjs <command> [options]

Commands:
  health                     Check Meilisearch health
  stats                      Get overall stats
  tasks                      List tasks (use --status to filter)
  task <id>                  Get specific task details
  indexes                    List all indexes
  index <name>               Get index stats
  index <name> settings      Get all index settings
  index <name> filterable    Get filterable attributes
  index <name> sortable      Get sortable attributes
  index <name> searchable    Get searchable attributes

Options:
  --feed         Use feed/metrics search (METRICS_SEARCH_HOST)
  --status <s>   Filter tasks by status (enqueued|processing|succeeded|failed)
  --limit <n>    Limit results (default: 20)
  --json         Output raw JSON

Examples:
  node query.mjs health
  node query.mjs tasks --status failed
  node query.mjs index models_v9 settings
  node query.mjs --feed stats`);
  process.exit(1);
}

// Select host and API key
const host = useFeed ? process.env.METRICS_SEARCH_HOST : process.env.SEARCH_HOST;
const apiKey = useFeed ? process.env.METRICS_SEARCH_API_KEY : process.env.SEARCH_API_KEY;

if (!host || !apiKey) {
  console.error(`Error: ${useFeed ? 'METRICS_SEARCH_HOST/METRICS_SEARCH_API_KEY' : 'SEARCH_HOST/SEARCH_API_KEY'} not configured`);
  process.exit(1);
}

async function request(path, options = {}) {
  const url = `${host}${path}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text}`);
  }

  return response.json();
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

async function main() {
  console.error(`Using: ${useFeed ? 'Feed/Metrics' : 'Main'} Search (${host})\n`);

  try {
    switch (command) {
      case 'health': {
        const data = await request('/health');
        if (jsonOutput) {
          console.log(JSON.stringify(data, null, 2));
        } else {
          console.log(`Status: ${data.status}`);
        }
        break;
      }

      case 'stats': {
        const data = await request('/stats');
        if (jsonOutput) {
          console.log(JSON.stringify(data, null, 2));
        } else {
          console.log(`Database Size: ${formatBytes(data.databaseSize)}`);
          console.log(`Last Update: ${data.lastUpdate || 'Never'}`);
          console.log(`\nIndexes:`);
          for (const [name, stats] of Object.entries(data.indexes)) {
            console.log(`  ${name}: ${stats.numberOfDocuments.toLocaleString()} docs, ${stats.isIndexing ? 'INDEXING' : 'ready'}`);
          }
        }
        break;
      }

      case 'tasks': {
        let path = `/tasks?limit=${limit}`;
        if (status) path += `&statuses=${status}`;
        const data = await request(path);
        if (jsonOutput) {
          console.log(JSON.stringify(data, null, 2));
        } else {
          console.log(`Total: ${data.total} | Showing: ${data.results.length}\n`);
          for (const task of data.results) {
            const duration = task.duration ? formatDuration(task.duration) : '-';
            const index = task.indexUid || '-';
            console.log(`[${task.uid}] ${task.status.padEnd(10)} ${task.type.padEnd(20)} ${index.padEnd(25)} ${duration}`);
            if (task.error) {
              console.log(`       Error: ${task.error.message}`);
            }
          }
        }
        break;
      }

      case 'task': {
        if (!commandArg) {
          console.error('Error: task command requires a task ID');
          process.exit(1);
        }
        const data = await request(`/tasks/${commandArg}`);
        if (jsonOutput) {
          console.log(JSON.stringify(data, null, 2));
        } else {
          console.log(`Task ID: ${data.uid}`);
          console.log(`Status: ${data.status}`);
          console.log(`Type: ${data.type}`);
          console.log(`Index: ${data.indexUid || '-'}`);
          console.log(`Duration: ${data.duration ? formatDuration(data.duration) : '-'}`);
          console.log(`Enqueued: ${data.enqueuedAt}`);
          console.log(`Started: ${data.startedAt || '-'}`);
          console.log(`Finished: ${data.finishedAt || '-'}`);
          if (data.error) {
            console.log(`\nError:`);
            console.log(`  Code: ${data.error.code}`);
            console.log(`  Type: ${data.error.type}`);
            console.log(`  Message: ${data.error.message}`);
          }
          if (data.details) {
            console.log(`\nDetails:`, JSON.stringify(data.details, null, 2));
          }
        }
        break;
      }

      case 'indexes': {
        const data = await request('/indexes');
        if (jsonOutput) {
          console.log(JSON.stringify(data, null, 2));
        } else {
          console.log(`Found ${data.results.length} indexes:\n`);
          for (const idx of data.results) {
            console.log(`  ${idx.uid}`);
            console.log(`    Primary Key: ${idx.primaryKey || '-'}`);
            console.log(`    Created: ${idx.createdAt}`);
            console.log(`    Updated: ${idx.updatedAt}`);
          }
        }
        break;
      }

      case 'index': {
        if (!commandArg) {
          console.error('Error: index command requires an index name');
          process.exit(1);
        }

        const subCommand = commandArg2;

        if (!subCommand) {
          // Get index stats
          const data = await request(`/indexes/${commandArg}/stats`);
          if (jsonOutput) {
            console.log(JSON.stringify(data, null, 2));
          } else {
            console.log(`Index: ${commandArg}`);
            console.log(`Documents: ${data.numberOfDocuments.toLocaleString()}`);
            console.log(`Indexing: ${data.isIndexing}`);
            console.log(`Field Distribution:`);
            const fields = Object.entries(data.fieldDistribution)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 15);
            for (const [field, count] of fields) {
              console.log(`  ${field}: ${count.toLocaleString()}`);
            }
            if (Object.keys(data.fieldDistribution).length > 15) {
              console.log(`  ... and ${Object.keys(data.fieldDistribution).length - 15} more fields`);
            }
          }
        } else if (subCommand === 'settings') {
          const data = await request(`/indexes/${commandArg}/settings`);
          console.log(JSON.stringify(data, null, 2));
        } else if (subCommand === 'filterable') {
          const data = await request(`/indexes/${commandArg}/settings/filterable-attributes`);
          if (jsonOutput) {
            console.log(JSON.stringify(data, null, 2));
          } else {
            console.log(`Filterable attributes for ${commandArg}:\n`);
            for (const attr of data) {
              console.log(`  - ${attr}`);
            }
          }
        } else if (subCommand === 'sortable') {
          const data = await request(`/indexes/${commandArg}/settings/sortable-attributes`);
          if (jsonOutput) {
            console.log(JSON.stringify(data, null, 2));
          } else {
            console.log(`Sortable attributes for ${commandArg}:\n`);
            for (const attr of data) {
              console.log(`  - ${attr}`);
            }
          }
        } else if (subCommand === 'searchable') {
          const data = await request(`/indexes/${commandArg}/settings/searchable-attributes`);
          if (jsonOutput) {
            console.log(JSON.stringify(data, null, 2));
          } else {
            console.log(`Searchable attributes for ${commandArg}:\n`);
            for (const attr of data) {
              console.log(`  - ${attr}`);
            }
          }
        } else {
          console.error(`Unknown subcommand: ${subCommand}`);
          console.error('Valid subcommands: settings, filterable, sortable, searchable');
          process.exit(1);
        }
        break;
      }

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
