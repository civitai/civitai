/**
 * ClickUp Webhook API — create, list, delete, update webhooks
 *
 * Webhooks can be scoped to task, list, folder, or space level.
 * Unscoped webhooks fire for all events in the workspace.
 */

import { apiRequest } from './client.mjs';
import { getTeamId } from './user.mjs';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WATCHERS_FILE = resolve(__dirname, '..', 'watchers.json');

// ── Persistent watcher registry ───────────────────────────────────────────

function loadWatchers() {
  if (!existsSync(WATCHERS_FILE)) return [];
  try {
    return JSON.parse(readFileSync(WATCHERS_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function saveWatchers(watchers) {
  writeFileSync(WATCHERS_FILE, JSON.stringify(watchers, null, 2));
}

export function addWatcherEntry(entry) {
  const watchers = loadWatchers();
  watchers.push(entry);
  saveWatchers(watchers);
}

export function removeWatcherEntry(webhookId) {
  const watchers = loadWatchers().filter(w => w.webhookId !== webhookId);
  saveWatchers(watchers);
}

export function getWatcherEntries() {
  return loadWatchers();
}

export function getWatcherSecret(webhookId) {
  const entry = loadWatchers().find(w => w.webhookId === webhookId);
  return entry?.secret || null;
}

export function clearAllWatcherEntries() {
  saveWatchers([]);
}

// ── ClickUp Webhook API ───────────────────────────────────────────────────

/**
 * Create a webhook.
 * @param {string} endpoint - URL to receive events
 * @param {string[]} events - Event types to subscribe to
 * @param {object} scope - Optional { taskId, listId, folderId, spaceId }
 * @returns {object} Webhook object with id, secret, etc.
 */
export async function createWebhook(endpoint, events, scope = {}) {
  const teamId = await getTeamId();
  const body = { endpoint, events };
  if (scope.taskId) body.task_id = scope.taskId;
  if (scope.listId) body.list_id = scope.listId;
  if (scope.folderId) body.folder_id = scope.folderId;
  if (scope.spaceId) body.space_id = scope.spaceId;

  const result = await apiRequest(`/team/${teamId}/webhook`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return result.webhook || result;
}

/**
 * List all webhooks for the workspace.
 */
export async function listWebhooks() {
  const teamId = await getTeamId();
  const result = await apiRequest(`/team/${teamId}/webhook`);
  return result.webhooks || [];
}

/**
 * Delete a webhook by ID.
 */
export async function deleteWebhook(webhookId) {
  return apiRequest(`/webhook/${webhookId}`, { method: 'DELETE' });
}

/**
 * Update a webhook (endpoint, events, status).
 */
export async function updateWebhook(webhookId, updates = {}) {
  const body = {};
  if (updates.endpoint) body.endpoint = updates.endpoint;
  if (updates.events) body.events = updates.events;
  if (updates.status) body.status = updates.status;

  return apiRequest(`/webhook/${webhookId}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

// ── Default events for common watch commands ──────────────────────────────

export const DEFAULT_TASK_EVENTS = [
  'taskStatusUpdated',
  'taskCommentPosted',
  'taskUpdated',
  'taskAssigneeUpdated',
  'taskDueDateUpdated',
];

export const DEFAULT_LIST_EVENTS = [
  'taskCreated',
  'taskStatusUpdated',
  'taskCommentPosted',
  'taskUpdated',
  'taskDeleted',
];

export const DEFAULT_SPACE_EVENTS = [
  'taskCreated',
  'taskStatusUpdated',
  'taskCommentPosted',
  'taskUpdated',
  'taskDeleted',
  'listCreated',
  'listUpdated',
  'listDeleted',
];

export const ALL_TASK_EVENTS = [
  'taskCreated',
  'taskUpdated',
  'taskDeleted',
  'taskPriorityUpdated',
  'taskStatusUpdated',
  'taskAssigneeUpdated',
  'taskDueDateUpdated',
  'taskTagUpdated',
  'taskMoved',
  'taskCommentPosted',
  'taskCommentUpdated',
  'taskTimeEstimateUpdated',
  'taskTimeTrackedUpdated',
  'taskAttachmentUploaded',
  'taskCustomFieldUpdated',
];
