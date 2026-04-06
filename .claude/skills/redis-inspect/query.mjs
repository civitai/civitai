#!/usr/bin/env node

/**
 * Redis Inspection Tool
 *
 * Usage:
 *   node .claude/skills/redis-inspect/query.mjs get <key>
 *   node .claude/skills/redis-inspect/query.mjs keys <pattern>
 *   node .claude/skills/redis-inspect/query.mjs ttl <key>
 *   node .claude/skills/redis-inspect/query.mjs type <key>
 *   node .claude/skills/redis-inspect/query.mjs hgetall <key>
 *   node .claude/skills/redis-inspect/query.mjs hget <key> <field>
 *   node .claude/skills/redis-inspect/query.mjs scard <key>
 *   node .claude/skills/redis-inspect/query.mjs smembers <key>
 *   node .claude/skills/redis-inspect/query.mjs del <key> --writable
 *   node .claude/skills/redis-inspect/query.mjs info
 *
 * Options:
 *   --sys         Use system cache (REDIS_SYS_URL) instead of main cache
 *   --writable    Allow write operations (del)
 *   --json        Output raw JSON
 *   --limit <n>   Limit results for keys/smembers (default: 100)
 */

import { createClient } from 'redis';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Load .env files (skill-specific first, then project root as fallback)
const __dirname = dirname(fileURLToPath(import.meta.url));
const skillDir = __dirname;
const projectRoot = resolve(__dirname, '../../..');

function loadEnv() {
  const envFiles = [
    resolve(skillDir, '.env'),      // Skill-specific (priority)
    resolve(projectRoot, '.env'),   // Project root (fallback)
  ];

  let loaded = false;
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
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
      loaded = true;
    } catch (e) {
      // File not found, continue to next
    }
  }

  if (!loaded) {
    console.error('Warning: Could not load any .env file');
  }
}

loadEnv();

// Parse arguments
const args = process.argv.slice(2);
let useSys = false;
let writable = false;
let jsonOutput = false;
let limit = 100;
const positionalArgs = [];

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--sys') {
    useSys = true;
  } else if (arg === '--writable') {
    writable = true;
  } else if (arg === '--json') {
    jsonOutput = true;
  } else if (arg === '--limit') {
    limit = parseInt(args[++i], 10);
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
  get <key>            Get a string value
  keys <pattern>       Find keys matching pattern (use * as wildcard)
  ttl <key>            Get TTL in seconds (-1 = no expiry, -2 = not found)
  type <key>           Get the type of a key
  exists <key>         Check if key exists
  hgetall <key>        Get all fields from a hash
  hget <key> <field>   Get a specific hash field
  scard <key>          Get set cardinality (count)
  smembers <key>       Get all set members
  llen <key>           Get list length
  lrange <key>         Get list elements (first 100)
  del <key>            Delete a key (requires --writable)
  info                 Get Redis server info

Options:
  --sys          Use system cache (REDIS_SYS_URL) - for persistent/system data
  --writable     Allow write operations (required for del)
  --json         Output raw JSON
  --limit <n>    Limit results (default: 100)

Cache Types:
  Main cache (default): Regular cache, can be lost, cluster mode
  System cache (--sys): Persistent system values, single node

Examples:
  node query.mjs keys "user:*" --limit 20
  node query.mjs get "session:data2:123456"
  node query.mjs --sys get "system:features"
  node query.mjs hgetall "packed:caches:cosmetics"
  node query.mjs ttl "generation:count:123"`);
  process.exit(1);
}

// Select Redis URL
const redisUrl = useSys ? process.env.REDIS_SYS_URL : process.env.REDIS_URL;
const cacheType = useSys ? 'System' : 'Main';

if (!redisUrl) {
  console.error(`Error: ${useSys ? 'REDIS_SYS_URL' : 'REDIS_URL'} not configured`);
  process.exit(1);
}

// Write protection
const writeCommands = ['del', 'set', 'hset', 'hdel', 'expire'];
if (writeCommands.includes(command) && !writable) {
  console.error(`Error: Write operation (${command}) requires --writable flag`);
  console.error('This requires explicit user permission as it modifies the cache.');
  process.exit(1);
}

async function main() {
  const url = new URL(redisUrl);
  const connectionUrl = `${url.protocol}//${url.host}`;

  const client = createClient({
    url: connectionUrl,
    username: url.username === '' ? undefined : url.username,
    password: url.password,
    socket: {
      connectTimeout: 10000,
    },
  });

  client.on('error', (err) => console.error('Redis error:', err.message));

  try {
    await client.connect();
    console.error(`Connected to ${cacheType} cache (${url.host})\n`);

    switch (command) {
      case 'get': {
        if (!commandArg) {
          console.error('Error: get requires a key');
          process.exit(1);
        }
        const value = await client.get(commandArg);
        if (value === null) {
          console.log('(nil)');
        } else if (jsonOutput) {
          // Try to parse as JSON
          try {
            console.log(JSON.stringify(JSON.parse(value), null, 2));
          } catch {
            console.log(value);
          }
        } else {
          console.log(value);
        }
        break;
      }

      case 'keys': {
        if (!commandArg) {
          console.error('Error: keys requires a pattern');
          process.exit(1);
        }
        const keys = [];
        for await (const key of client.scanIterator({ MATCH: commandArg, COUNT: 100 })) {
          keys.push(key);
          if (keys.length >= limit) break;
        }
        if (jsonOutput) {
          console.log(JSON.stringify(keys, null, 2));
        } else {
          console.log(`Found ${keys.length} keys (limit: ${limit}):\n`);
          for (const key of keys) {
            console.log(`  ${key}`);
          }
        }
        break;
      }

      case 'ttl': {
        if (!commandArg) {
          console.error('Error: ttl requires a key');
          process.exit(1);
        }
        const ttl = await client.ttl(commandArg);
        if (ttl === -2) {
          console.log('Key not found');
        } else if (ttl === -1) {
          console.log('No expiry (persistent)');
        } else {
          const hours = Math.floor(ttl / 3600);
          const minutes = Math.floor((ttl % 3600) / 60);
          const seconds = ttl % 60;
          console.log(`TTL: ${ttl} seconds (${hours}h ${minutes}m ${seconds}s)`);
        }
        break;
      }

      case 'type': {
        if (!commandArg) {
          console.error('Error: type requires a key');
          process.exit(1);
        }
        const type = await client.type(commandArg);
        console.log(`Type: ${type}`);
        break;
      }

      case 'exists': {
        if (!commandArg) {
          console.error('Error: exists requires a key');
          process.exit(1);
        }
        const exists = await client.exists(commandArg);
        console.log(exists ? 'Key exists' : 'Key not found');
        break;
      }

      case 'hgetall': {
        if (!commandArg) {
          console.error('Error: hgetall requires a key');
          process.exit(1);
        }
        const hash = await client.hGetAll(commandArg);
        if (Object.keys(hash).length === 0) {
          console.log('(empty or not found)');
        } else if (jsonOutput) {
          console.log(JSON.stringify(hash, null, 2));
        } else {
          for (const [field, value] of Object.entries(hash)) {
            const displayValue = value.length > 100 ? value.substring(0, 100) + '...' : value;
            console.log(`${field}: ${displayValue}`);
          }
        }
        break;
      }

      case 'hget': {
        if (!commandArg || !commandArg2) {
          console.error('Error: hget requires a key and field');
          process.exit(1);
        }
        const value = await client.hGet(commandArg, commandArg2);
        if (value === null) {
          console.log('(nil)');
        } else if (jsonOutput) {
          try {
            console.log(JSON.stringify(JSON.parse(value), null, 2));
          } catch {
            console.log(value);
          }
        } else {
          console.log(value);
        }
        break;
      }

      case 'scard': {
        if (!commandArg) {
          console.error('Error: scard requires a key');
          process.exit(1);
        }
        const count = await client.sCard(commandArg);
        console.log(`Set has ${count} members`);
        break;
      }

      case 'smembers': {
        if (!commandArg) {
          console.error('Error: smembers requires a key');
          process.exit(1);
        }
        const members = await client.sMembers(commandArg);
        const limited = members.slice(0, limit);
        if (jsonOutput) {
          console.log(JSON.stringify(limited, null, 2));
        } else {
          console.log(`Set has ${members.length} members (showing ${limited.length}):\n`);
          for (const member of limited) {
            console.log(`  ${member}`);
          }
        }
        break;
      }

      case 'llen': {
        if (!commandArg) {
          console.error('Error: llen requires a key');
          process.exit(1);
        }
        const len = await client.lLen(commandArg);
        console.log(`List has ${len} elements`);
        break;
      }

      case 'lrange': {
        if (!commandArg) {
          console.error('Error: lrange requires a key');
          process.exit(1);
        }
        const elements = await client.lRange(commandArg, 0, limit - 1);
        if (jsonOutput) {
          console.log(JSON.stringify(elements, null, 2));
        } else {
          console.log(`List elements (first ${elements.length}):\n`);
          for (let i = 0; i < elements.length; i++) {
            console.log(`  [${i}] ${elements[i]}`);
          }
        }
        break;
      }

      case 'del': {
        if (!commandArg) {
          console.error('Error: del requires a key');
          process.exit(1);
        }
        const deleted = await client.del(commandArg);
        console.log(deleted ? `Deleted key: ${commandArg}` : 'Key not found');
        break;
      }

      case 'info': {
        const info = await client.info();
        if (jsonOutput) {
          // Parse info into object
          const parsed = {};
          for (const line of info.split('\n')) {
            if (line.startsWith('#') || !line.includes(':')) continue;
            const [key, value] = line.split(':');
            parsed[key.trim()] = value.trim();
          }
          console.log(JSON.stringify(parsed, null, 2));
        } else {
          // Show key stats
          const lines = info.split('\n');
          const stats = {};
          for (const line of lines) {
            if (line.includes(':')) {
              const [key, value] = line.split(':');
              stats[key.trim()] = value.trim();
            }
          }
          console.log(`Redis Version: ${stats.redis_version || 'unknown'}`);
          console.log(`Used Memory: ${stats.used_memory_human || 'unknown'}`);
          console.log(`Connected Clients: ${stats.connected_clients || 'unknown'}`);
          console.log(`Total Keys: ${stats.db0 || 'unknown'}`);
          console.log(`Uptime: ${stats.uptime_in_days || '?'} days`);
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
  } finally {
    await client.quit();
  }
}

main();
