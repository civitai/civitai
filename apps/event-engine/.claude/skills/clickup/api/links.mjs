/**
 * ClickUp links and attachments API methods
 */

import { apiRequest } from './client.mjs';

// Add a link dependency between tasks
export async function addTaskLink(taskId, linkedTaskId) {
  const response = await apiRequest(`/task/${taskId}/link/${linkedTaskId}`, {
    method: 'POST',
  });
  return response;
}

// Remove a link dependency between tasks
export async function removeTaskLink(taskId, linkedTaskId) {
  const response = await apiRequest(`/task/${taskId}/link/${linkedTaskId}`, {
    method: 'DELETE',
  });
  return response;
}

// Add an external URL reference via comment
// (ClickUp doesn't have a dedicated external links field, so we use comments)
export async function addExternalLink(taskId, url, description = null) {
  const { postComment } = await import('./comments.mjs');

  const text = description
    ? `📎 **Reference**: [${description}](${url})`
    : `📎 **Reference**: ${url}`;

  return postComment(taskId, text);
}
