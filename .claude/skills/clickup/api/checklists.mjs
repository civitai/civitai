/**
 * ClickUp checklist API methods
 */

import { apiRequest } from './client.mjs';

// Create a new checklist on a task
export async function createChecklist(taskId, name) {
  const response = await apiRequest(`/task/${taskId}/checklist`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
  return response;
}

// Add item to a checklist
export async function addChecklistItem(checklistId, name, options = {}) {
  const body = { name, ...options };
  const response = await apiRequest(`/checklist/${checklistId}/checklist_item`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return response;
}

// Get checklists for a task (from task details)
export async function getChecklists(taskId) {
  const response = await apiRequest(`/task/${taskId}`);
  return response.checklists || [];
}

// Edit a checklist item (rename, assign, resolve/complete, nest)
export async function editChecklistItem(checklistId, checklistItemId, updates = {}) {
  const body = {};
  if (updates.name !== undefined) body.name = updates.name;
  if (updates.assignee !== undefined) body.assignee = updates.assignee;
  if (updates.resolved !== undefined) body.resolved = updates.resolved;
  if (updates.parent !== undefined) body.parent = updates.parent;

  const response = await apiRequest(`/checklist/${checklistId}/checklist_item/${checklistItemId}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  return response;
}

// Delete a checklist item
export async function deleteChecklistItem(checklistId, checklistItemId) {
  const response = await apiRequest(`/checklist/${checklistId}/checklist_item/${checklistItemId}`, {
    method: 'DELETE',
  });
  return response;
}

// Add item to first checklist, or create one if none exist
export async function addChecklistItemToTask(taskId, itemName, checklistName = 'Checklist') {
  let checklists = await getChecklists(taskId);

  // Create checklist if none exist
  if (checklists.length === 0) {
    const result = await createChecklist(taskId, checklistName);
    checklists = [result.checklist];
  }

  // Add item to first checklist
  const checklist = checklists[0];
  const item = await addChecklistItem(checklist.id, itemName);

  return { checklist, item };
}
