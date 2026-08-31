#!/usr/bin/env node

/**
 * ClickUp Event Listener (webhook.site + local receiver)
 *
 * Receives ClickUp webhook events via webhook.site forwarding.
 * Designed to be run as a background task so the agent gets notified
 * when a watched event arrives (task status change, comment, etc.).
 *
 * KEY FEATURE: On startup, checks webhook.site API for events that
 * arrived since last seen timestamp. Prevents gaps between restarts.
 *
 * Modes:
 *   1. "wait" (default) — Check for missed events, then listen for ONE
 *      new webhook, print it, and exit. Agent gets background task notification.
 *
 *   2. "server" — Stay running and log all events.
 *
 * Usage:
 *   node listen.mjs [--since <ISO timestamp>] [--port 3458] [--timeout 600] [--mode wait|server]
 *
 * Configuration (accounts.json > webhookSiteToken):
 *   Or environment: CLICKUP_WEBHOOK_SITE_TOKEN
 *
 * Exit codes:
 *   0 — webhook received (wait mode)
 *   1 — timeout or error
 */

import { spawn } from 'child_process';
import http from 'http';
import https from 'https';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_FILE = path.join(__dirname, 'webhooks.jsonl');
const LATEST_FILE = path.join(__dirname, 'webhook-latest.json');
const WEBHOOK_URL_FILE = path.join(__dirname, 'webhook-url.txt');
const LAST_SEEN_FILE = path.join(__dirname, 'last-seen.txt');
const WATCHERS_FILE = path.join(__dirname, 'watchers.json');

// ── Load config ───────────────────────────────────────────────────────────

// Try accounts.json first, then env
function loadConfig() {
  const accountsPath = path.join(__dirname, 'accounts.json');
  if (fs.existsSync(accountsPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(accountsPath, 'utf-8'));
      return {
        webhookSiteToken: data.webhookSiteToken || process.env.CLICKUP_WEBHOOK_SITE_TOKEN,
        webhookSiteApiKey: data.webhookSiteApiKey || process.env.WEBHOOK_SITE_API_KEY,
      };
    } catch {}
  }
  return {
    webhookSiteToken: process.env.CLICKUP_WEBHOOK_SITE_TOKEN,
    webhookSiteApiKey: process.env.WEBHOOK_SITE_API_KEY,
  };
}

const config = loadConfig();
const WH_TOKEN = config.webhookSiteToken;
const WH_API_KEY = config.webhookSiteApiKey;

// ── Parse CLI args ────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getFlag(name) {
  const idx = args.indexOf(name);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

const PORT = parseInt(getFlag('--port') || '3458', 10);
const TIMEOUT = parseInt(getFlag('--timeout') || '600', 10) * 1000;
const MODE = getFlag('--mode') || 'wait';

// Filters — only deliver events matching these criteria
const FILTER_STATUS = getFlag('--filter-status');    // e.g. "qa review" — only deliver status changes TO this status
const FILTER_EVENT = getFlag('--filter-event');       // e.g. "taskCommentPosted" — only deliver this event type
const FILTER_TASK = getFlag('--filter-task');          // e.g. "868abc123" — only deliver events for this task

let SINCE = getFlag('--since');
if (!SINCE && fs.existsSync(LAST_SEEN_FILE)) {
  SINCE = fs.readFileSync(LAST_SEEN_FILE, 'utf8').trim();
}

if (!WH_TOKEN) {
  console.error('Error: No webhook.site token configured.');
  console.error('Add "webhookSiteToken" to accounts.json or set CLICKUP_WEBHOOK_SITE_TOKEN env var.');
  console.error('Visit https://webhook.site to get a token (the UUID in the URL).');
  process.exit(1);
}

const WEBHOOK_URL = `https://webhook.site/${WH_TOKEN}`;

// Write the webhook URL so other commands can read it
fs.writeFileSync(WEBHOOK_URL_FILE, WEBHOOK_URL);

// ── Load watcher secrets for signature verification ───────────────────────

function loadWatcherSecrets() {
  if (!fs.existsSync(WATCHERS_FILE)) return {};
  try {
    const watchers = JSON.parse(fs.readFileSync(WATCHERS_FILE, 'utf-8'));
    const secrets = {};
    for (const w of watchers) {
      if (w.webhookId && w.secret) secrets[w.webhookId] = w.secret;
    }
    return secrets;
  } catch {
    return {};
  }
}

const WATCHER_SECRETS = loadWatcherSecrets();

// ── Event Filtering ───────────────────────────────────────────────────────

function matchesFilters(event) {
  // Filter by event type
  if (FILTER_EVENT) {
    const allowed = FILTER_EVENT.split(',').map(s => s.trim().toLowerCase());
    const eventType = (event.event || '').toLowerCase();
    if (!allowed.includes(eventType)) return false;
  }

  // Filter by task ID
  if (FILTER_TASK) {
    const allowed = FILTER_TASK.split(',').map(s => s.trim());
    if (!allowed.includes(event.task_id)) return false;
  }

  // Filter by target status (only deliver taskStatusUpdated where after.status matches)
  if (FILTER_STATUS) {
    const allowed = FILTER_STATUS.split(',').map(s => s.trim().toLowerCase());
    const items = event.history_items || [];
    // For status updates, check the "after" status
    const hasMatch = items.some(item => {
      const afterStatus = (item.after?.status || '').toLowerCase();
      return allowed.includes(afterStatus);
    });
    // For non-status events, FILTER_STATUS doesn't apply — let them through
    if (event.event === 'taskStatusUpdated' && !hasMatch) return false;
  }

  return true;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function verifySignature(rawBody, signature, webhookId) {
  if (!signature) return null;
  // Try the specific webhook's secret first
  const secret = WATCHER_SECRETS[webhookId];
  if (!secret) return null;

  const hash = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');
  return hash === signature;
}

function saveLastSeen(timestamp) {
  fs.writeFileSync(LAST_SEEN_FILE, timestamp);
}

function processEvent(event, source = 'live', verified = 'skipped') {
  const entry = {
    received_at: new Date().toISOString(),
    source,
    verified,
    ...event,
  };

  fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
  fs.writeFileSync(LATEST_FILE, JSON.stringify(entry, null, 2));

  if (entry._wh_created_at) {
    saveLastSeen(entry._wh_created_at);
  } else {
    saveLastSeen(entry.received_at);
  }

  return entry;
}

function formatEventSummary(event) {
  const type = event.event || 'unknown';
  const taskId = event.task_id || '?';
  const webhookId = event.webhook_id || '?';
  const items = event.history_items || [];
  let detail = '';

  if (type === 'taskStatusUpdated' && items.length > 0) {
    const item = items[0];
    detail = ` | ${item.before?.status || '?'} → ${item.after?.status || '?'}`;
  } else if (type === 'taskCommentPosted' && items.length > 0) {
    const user = items[0]?.user?.username || '?';
    detail = ` | by ${user}`;
  } else if (items.length > 0) {
    const user = items[0]?.user?.username;
    if (user) detail = ` | by ${user}`;
  }

  return `${type} | task:${taskId} | wh:${webhookId}${detail}`;
}

// ── Catch-up: query webhook.site for missed events ────────────────────────

function fetchMissedEvents(since) {
  return new Promise((resolve, reject) => {
    const sinceUtc = since.includes('Z') || since.includes('+') ? since : since.replace(' ', 'T') + 'Z';
    const d = new Date(sinceUtc);
    if (d.getMilliseconds() > 0) {
      d.setSeconds(d.getSeconds() + 1);
      d.setMilliseconds(0);
    }
    d.setSeconds(d.getSeconds() + 1);
    const dateFrom = d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');

    const url = new URL(`https://webhook.site/token/${WH_TOKEN}/requests`);
    url.searchParams.set('date_from', dateFrom);
    url.searchParams.set('sorting', 'oldest');
    url.searchParams.set('per_page', '10');

    const headers = {};
    if (WH_API_KEY) headers['Api-Key'] = WH_API_KEY;

    https.get(url.toString(), { headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json);
        } catch {
          resolve({ data: [] });
        }
      });
    }).on('error', (err) => {
      process.stderr.write(`[catch-up] Failed to query webhook.site: ${err.message}\n`);
      resolve({ data: [] });
    });
  });
}

function parseWebhookSiteRequest(req) {
  try {
    const event = JSON.parse(req.content);
    event._wh_created_at = req.created_at;
    return event;
  } catch {
    return null;
  }
}

// ── Local HTTP server ─────────────────────────────────────────────────────

let serverResolve;

const server = http.createServer((req, res) => {
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'listening', webhook_url: WEBHOOK_URL }));
    return;
  }

  if (req.method === 'POST') {
    let rawBody = '';
    req.on('data', (chunk) => (rawBody += chunk));
    req.on('end', () => {
      try {
        const event = JSON.parse(rawBody);
        const signature = req.headers['x-signature'];
        const webhookId = event.webhook_id;
        const verified = verifySignature(rawBody, signature, webhookId);

        const entry = {
          received_at: new Date().toISOString(),
          source: 'live',
          verified: verified === null ? 'skipped' : verified,
          ...event,
        };

        // Always ack the webhook to prevent ClickUp from marking it unhealthy
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));

        // Always log and update cursor
        fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
        saveLastSeen(entry.received_at);

        // Check filters — only deliver to agent if event matches
        if (!matchesFilters(event)) {
          process.stderr.write(`[filtered] ${formatEventSummary(event)}\n`);
          return;
        }

        fs.writeFileSync(LATEST_FILE, JSON.stringify(entry, null, 2));

        if (MODE === 'server') {
          process.stderr.write(`[${entry.received_at}] ${formatEventSummary(event)}\n`);
        } else {
          console.log(JSON.stringify(entry, null, 2));
          if (serverResolve) serverResolve();
        }
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

// ── whcli forward process ─────────────────────────────────────────────────

function startForwarder() {
  const whArgs = [
    'forward',
    `--token=${WH_TOKEN}`,
    `--target=http://localhost:${PORT}`,
    '--listen-timeout=5',
  ];
  if (WH_API_KEY) whArgs.push(`--api-key=${WH_API_KEY}`);

  const proc = spawn('whcli', whArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: true,
  });

  proc.stdout.on('data', (d) => process.stderr.write(`[whcli] ${d}`));
  proc.stderr.on('data', (d) => process.stderr.write(`[whcli:err] ${d}`));
  proc.on('error', (err) => process.stderr.write(`[whcli] Error: ${err.message}\n`));

  return proc;
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  process.stderr.write(`ClickUp Event Listener\n`);
  process.stderr.write(`Webhook URL: ${WEBHOOK_URL}\n`);
  process.stderr.write(`Mode: ${MODE} | Port: ${PORT} | Timeout: ${TIMEOUT / 1000}s\n`);
  process.stderr.write(`Since: ${SINCE || 'none (first run)'}\n`);
  process.stderr.write(`Tracked webhooks: ${Object.keys(WATCHER_SECRETS).length}\n`);
  if (FILTER_STATUS) process.stderr.write(`Filter status: ${FILTER_STATUS}\n`);
  if (FILTER_EVENT) process.stderr.write(`Filter event: ${FILTER_EVENT}\n`);
  if (FILTER_TASK) process.stderr.write(`Filter task: ${FILTER_TASK}\n`);
  process.stderr.write('\n');

  // ── Step 1: Check for missed events ─────────────────────────────────────
  if (SINCE && MODE === 'wait') {
    process.stderr.write(`Checking webhook.site for events since ${SINCE}...\n`);
    const result = await fetchMissedEvents(SINCE);
    const requests = result.data || [];

    if (requests.length > 0) {
      // Find the first missed event that passes our filters
      for (const req of requests) {
        const event = parseWebhookSiteRequest(req);
        if (!event) continue;

        // Always update cursor even for filtered events
        const entry = processEvent(event, 'catch-up');

        if (matchesFilters(event)) {
          process.stderr.write(`[catch-up] Found matching event (of ${requests.length} missed). Delivering.\n`);
          console.log(JSON.stringify(entry, null, 2));
          process.exit(0);
        } else {
          process.stderr.write(`[catch-up:filtered] ${event.event || 'unknown'} — skipped\n`);
        }
      }
      process.stderr.write(`[catch-up] ${requests.length} missed event(s), none matched filters. Starting live listener.\n`);
    } else {
      process.stderr.write(`[catch-up] No missed events. Starting live listener.\n`);
    }
  }

  // ── Step 2: Start live listener ─────────────────────────────────────────
  await new Promise((resolve) => server.listen(PORT, resolve));
  process.stderr.write(`Listening on port ${PORT}\n\n`);

  const forwarder = startForwarder();

  if (MODE === 'wait') {
    const gotWebhook = new Promise((resolve) => { serverResolve = resolve; });
    const timedOut = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), TIMEOUT)
    );

    try {
      await Promise.race([gotWebhook, timedOut]);
      forwarder.kill();
      server.close(() => process.exit(0));
    } catch {
      console.log(JSON.stringify({
        error: 'timeout',
        message: `No ClickUp event received within ${TIMEOUT / 1000}s`,
        webhook_url: WEBHOOK_URL,
      }));
      forwarder.kill();
      server.close(() => process.exit(1));
    }
  } else {
    process.stderr.write('Running in server mode. Press Ctrl+C to stop.\n\n');

    function cleanup() {
      process.stderr.write('\nShutting down...\n');
      forwarder.kill();
      server.close(() => process.exit(0));
    }

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
  }
}

main();
